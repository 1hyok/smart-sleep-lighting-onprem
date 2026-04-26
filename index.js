// ──────────────────────────────────────────────
// index.js
//  - 엣지 노드 진입점.
//  - 단일 책임:
//     YL-40(PCF8591) 조도 센서 값 수집
//     → sensor.js 내부 노이즈 필터링 (burst median + 이동 평균)
//     → MQTT 브로커(Mosquitto) 의 home/sensor/illuminance 토픽으로 Publish
//  - 비즈니스 로직(루틴/조명 제어/추천/스케줄링)은 백엔드 책임이며
//    이 노드에는 포함되지 않음.
// ──────────────────────────────────────────────

const config = require('./config');
const mqttClient = require('./mqttClient');
const sensor = require('./sensor');
const eventLogger = require('./eventLogger');
const buildLogger = require('./logger');

const log = buildLogger('app');

let publishTimer = null;

/**
 * 조도값 1회 읽기 → MQTT 발행.
 *  - 실제 센서 / mock 분기는 sensor.js 내부에서 결정 + 로깅.
 *  - 페이로드 스키마 (백엔드 인계용):
 *      deviceId   string   — MQTT clientId, 멀티 디바이스 식별
 *      value      number   — 추정 조도 (캘리브레이션 X)
 *      raw        number?  — PCF8591 8bit ADC (0..255). mock 이면 null
 *      source     string   — "sensor" | "mock". mock 표본 필터링용
 *      unit       string   — "lux_estimate" (진짜 lux 아님을 명시)
 *      timestamp  string   — ISO 8601
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

    mqttClient.publish(config.topics.illuminance, payload, { qos: 1, retain: false });
    log.info(
      `조도값 발행 → ${reading.lux} ${payload.unit} ` +
        `[${config.topics.illuminance}] (source=${reading.source})`,
    );
  } catch (err) {
    log.error('센서 주기 발행 실패:', err.message);
    eventLogger.append({ type: 'sensor_error', message: err.message });
  }
}

function bootstrap() {
  log.info('── 스마트 수면 조명 엣지 노드 기동 (조도 센서) ──');
  log.info(`모드: ${config.sensor.mock ? 'MOCK (I2C 비활성)' : 'RPI (I2C 활성)'}`);
  log.info(`이벤트 로그 파일: ${eventLogger.getPath()}`);

  eventLogger.append({ type: 'service_start', clientId: config.mqtt.clientId });

  const client = mqttClient.connect();

  client.once('connect', () => {
    // 첫 발행은 즉시, 이후 주기 발행
    publishSensorReading();
    publishTimer = setInterval(publishSensorReading, config.sensor.publishIntervalMs);
    log.info(`센서 발행 타이머 시작 (주기 ${config.sensor.publishIntervalMs}ms)`);
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
    await mqttClient.disconnect();
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
