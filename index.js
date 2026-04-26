// ──────────────────────────────────────────────
// index.js
//  - 애플리케이션 진입점.
//  - 책임:
//     · MQTT 브로커 연결/구독/발행
//     · YL-40(PCF8591) 조도 센서 주기 발행   → home/sensor/light
//     · 직접 RGB 조명 제어 구독              → home/bedroom/light/control
//     · 취침/기상 루틴 구독 (색온도 페이딩)  → routine/sleep, routine/wakeup
//     · 조도 기반 자동 추천 발행             → home/bedroom/routine_suggestion
//     · 주요 이벤트 로컬 JSONL 영속화
// ──────────────────────────────────────────────

const config = require('./config');
const mqttClient = require('./mqttClient');
const lightController = require('./lightController');
const routineController = require('./routineController');
const sensor = require('./sensor');
const sensorWatcher = require('./sensorWatcher');
const eventLogger = require('./eventLogger');
const scheduler = require('./scheduler');
const buildLogger = require('./logger');

const log = buildLogger('app');

let publishTimer = null;

/**
 * 조도값 읽기 → MQTT 발행 + 워처 관찰.
 *  - 실제 센서 / mock 분기는 sensor.js 내부에서 결정 + 로깅.
 *  - 페이로드 스키마 (데이터팀 인계용):
 *      deviceId   string   — MQTT clientId, 멀티 디바이스 식별
 *      value      number   — 추정 조도 (캘리브레이션 X)
 *      raw        number?  — PCF8591 8bit ADC (0..255). mock 이면 null
 *      source     string   — "sensor" | "mock". mock 표본 필터링용
 *      unit       string   — "lux_estimate" (진짜 lux 아님을 명시)
 *      timestamp  string   — ISO 8601 (Fitbit 등과 시간축 정렬)
 *  - QoS 1 로 발행 → 브로커 잠시 끊겨도 mqtt.js 내부 큐가 보관 후 재전송.
 */
function publishSensorReading() {
  try {
    const reading = sensor.readIlluminance();
    const payload = {
      deviceId: config.mqtt.clientId,
      value: reading.lux,
      raw: reading.raw,
      source: reading.source,
      unit: 'lux_estimate',
      timestamp: new Date().toISOString(),
    };

    mqttClient.publish(config.topics.light, payload, { qos: 1, retain: false });
    log.info(
      `조도값 발행 → ${reading.lux} ${payload.unit} ` +
        `[${config.topics.light}] (source=${reading.source})`,
    );

    // 어두워짐/밝아짐 전이 감시 (추천 메시지 자동 발행)
    sensorWatcher.observe(reading.lux);
  } catch (err) {
    log.error('센서 주기 발행 실패:', err.message);
    eventLogger.append({ type: 'sensor_error', message: err.message });
  }
}

function bootstrap() {
  log.info('── 스마트 수면 조명 엣지 노드 기동 (RGB) ──');
  log.info(`모드: ${config.gpio.mock ? 'MOCK (GPIO 비활성)' : 'RPI (GPIO 활성)'}`);
  log.info(
    `RGB 핀: R=${config.gpio.rgb.r}, G=${config.gpio.rgb.g}, B=${config.gpio.rgb.b} ` +
      `(commonAnode=${config.gpio.commonAnode})`,
  );
  log.info(`이벤트 로그 파일: ${eventLogger.getPath()}`);

  eventLogger.append({ type: 'service_start', clientId: config.mqtt.clientId });

  lightController.init();

  // 시간 기반 폴백 스케줄러 (외부 서버 단절 시에도 정시 발동 보장).
  scheduler.start();

  const client = mqttClient.connect();

  client.once('connect', () => {
    // 직접 RGB 조명 제어
    mqttClient.subscribe(config.topics.lightControl, (payload) => {
      const text = payload.toString();
      eventLogger.append({
        type: 'light_control_received',
        topic: config.topics.lightControl,
        payload: text,
      });
      lightController.handleControlMessage(payload);
    });

    // 취침 / 기상 루틴
    mqttClient.subscribe(config.topics.routineSleep, (payload) => {
      routineController.handleRoutineMessage('sleep', payload);
    });
    mqttClient.subscribe(config.topics.routineWakeup, (payload) => {
      routineController.handleRoutineMessage('wakeup', payload);
    });

    // 가상 센서 파이프라인 시작
    publishSensorReading();
    publishTimer = setInterval(publishSensorReading, config.sensor.publishIntervalMs);
    log.info(`센서 발행 타이머 시작 (주기 ${config.sensor.publishIntervalMs}ms)`);
    log.info(
      `센서 워처 임계치: dark < ${config.sensor.darkLux} lux, ` +
        `bright > ${config.sensor.brightLux} lux (window=${config.sensor.window})`,
    );
  });
}

// 종료 절차가 중복 진행되는 걸 막는 가드.
// SIGTERM 받고 disconnect 도는 도중 SIGINT 가 또 와도 한 번만 실행.
let isShuttingDown = false;

async function shutdown(signal, exitCode = 0) {
  if (isShuttingDown) {
    log.warn(`${signal} 수신 — 이미 종료 진행 중, 무시`);
    return;
  }
  isShuttingDown = true;

  log.warn(`${signal} 수신 → 종료 절차 시작`);
  eventLogger.append({ type: 'service_stop', signal });
  try {
    if (publishTimer) clearInterval(publishTimer);
    scheduler.stop();
    routineController.cleanup();
    await mqttClient.disconnect();
    lightController.cleanup();
    sensor.cleanup();
  } catch (err) {
    log.error('shutdown 중 오류:', err.message);
  } finally {
    log.info('프로세스 종료');
    process.exit(exitCode);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// uncaughtException / unhandledRejection 이후에는 프로세스 상태가 손상됐을 수
// 있음 → Node 공식 권고대로 종료. systemd 등 프로세스 매니저가 재시작 담당.
process.on('uncaughtException', (err) => {
  log.error('uncaughtException:', err);
  eventLogger.append({ type: 'uncaught_exception', message: err.message });
  shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection:', reason);
  eventLogger.append({
    type: 'unhandled_rejection',
    message: reason instanceof Error ? reason.message : String(reason),
  });
  shutdown('unhandledRejection', 1);
});

bootstrap();
