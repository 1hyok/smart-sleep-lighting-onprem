// ──────────────────────────────────────────────
// index.js
//  - 애플리케이션 진입점.
//  - 책임:
//     · MQTT 브로커 연결/구독/발행
//     · 가상 조도 센서 주기 발행            → home/sensor/lux
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
const webServer = require('./webServer');
const buildLogger = require('./logger');

const log = buildLogger('app');

let publishTimer = null;

/**
 * 가상 조도값 읽기 → MQTT 발행 + 워처 관찰.
 */
function publishSensorReading() {
  try {
    const lux = sensor.readIlluminance();
    const payload = {
      deviceId: config.mqtt.clientId,
      value: lux,
      unit: 'lux',
      timestamp: new Date().toISOString(),
    };

    mqttClient.publish(config.topics.lux, payload, { qos: 0, retain: false });
    log.info(`조도값 발행 → ${lux} lux  [${config.topics.lux}]`);

    // 웹 대시보드 SSE 클라이언트에도 실시간 푸시
    webServer.broadcastLux(payload);

    // 어두워짐/밝아짐 전이 감시 (추천 메시지 자동 발행)
    sensorWatcher.observe(lux);
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

  // Express 대시보드 서버 시작 (MQTT 연결과 병렬로 가동).
  // publishMqtt 주입 → 같은 프로세스 내 MQTT 클라이언트를 공유.
  webServer.start({
    publishMqtt: (topic, message) =>
      mqttClient.publish(topic, message, { qos: 1, retain: false }),
  });

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

async function shutdown(signal) {
  log.warn(`${signal} 수신 → 종료 절차 시작`);
  eventLogger.append({ type: 'service_stop', signal });
  try {
    if (publishTimer) clearInterval(publishTimer);
    routineController.cleanup();
    await mqttClient.disconnect();
    lightController.cleanup();
  } catch (err) {
    log.error('shutdown 중 오류:', err.message);
  } finally {
    log.info('프로세스 종료');
    process.exit(0);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  log.error('uncaughtException:', err);
  eventLogger.append({ type: 'uncaught_exception', message: err.message });
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection:', reason);
  eventLogger.append({
    type: 'unhandled_rejection',
    message: reason instanceof Error ? reason.message : String(reason),
  });
});

bootstrap();
