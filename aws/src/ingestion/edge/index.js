// ──────────────────────────────────────────────
// index.js — 엣지 노드 진입점 (프로젝트 6: AWS IoT Core)
//  책임:
//    YL-40(PCF8591) 조도 센서 수집 → 노이즈 필터링(sensor.js)
//    → AWS IoT Core 의 home/sensor/illuminance 토픽으로 mTLS 발행(QoS 1)
//    → Device Shadow 로 조명 명령 수신 + 엣지 로컬 GPIO 실행(shadow.js + light.js)
//  비즈니스 로직(수면 분석/추천/스케줄링, desired 작성)은 클라우드(임형택) 책임.
//  담당: 정일혁
// ──────────────────────────────────────────────

const config = require('./config');
const iot = require('./iotClient');
const shadow = require('./shadow');
const sensor = require('./sensor');
const light = require('./light');
const buildLogger = require('./logger');

const log = buildLogger('app');

let publishTimer = null;
let publishingStarted = false;

/**
 * 조도값 1회 읽기 → IoT Core 발행.
 *  페이로드 스키마 (spec §1 계약 — IoT Rule SQL·백엔드가 이 필드를 참조):
 *    deviceId   string  — 디바이스 식별 (= Thing 이름 = DynamoDB device_id)
 *    value      number  — 추정 조도(lux, 캘리브레이션 X)
 *    raw        number? — PCF8591 8bit ADC(0..255). mock 이면 null
 *    source     string  — "sensor" | "mock"  (IoT Rule 이 WHERE source='sensor' 로 mock 제외)
 *    unit       string  — "lux_estimate"
 *    timestamp  string  — ISO 8601 (DynamoDB recorded_at)
 */
function publishSensorReading() {
  try {
    const r = sensor.readIlluminance();
    const payload = {
      deviceId: config.iot.deviceId,
      value: r.lux,
      raw: r.raw,
      source: r.source,
      unit: 'lux_estimate',
      timestamp: new Date().toISOString(),
    };
    iot.publish(config.topics.illuminance, payload, { qos: 1, retain: false });
    log.info(
      `조도 발행 → ${payload.value} ${payload.unit} ` +
        `[${config.topics.illuminance}] (source=${payload.source})`,
    );
  } catch (err) {
    log.error('센서 주기 발행 실패:', err.message);
  }
}

function bootstrap() {
  log.info('── 스마트 수면 조명 엣지 노드 기동 (P6: AWS IoT Core) ──');
  log.info(
    `Thing=${config.iot.thingName} | 연결: ${config.iot.dryRun ? 'DRY-RUN' : 'IoT Core mTLS'} | ` +
      `센서: ${config.sensor.mock ? 'MOCK' : 'I2C'} | GPIO: ${light.isMock ? 'MOCK' : 'PWM'}`,
  );

  const client = iot.connect();
  shadow.init(client); // 메시지 핸들러 1회 바인딩

  // 매 (재)연결마다: Shadow 재구독+get(누락 desired 복구), 발행 타이머는 1회만 시작.
  client.on('connect', () => {
    shadow.onConnect();
    if (!publishingStarted) {
      publishingStarted = true;
      publishSensorReading(); // 첫 발행 즉시
      publishTimer = setInterval(publishSensorReading, config.sensor.publishIntervalMs);
      log.info(`센서 발행 타이머 시작 (주기 ${config.sensor.publishIntervalMs}ms)`);
    }
  });
}

// ── graceful shutdown (온프렘과 동일한 중복 진입 가드) ──
let isShuttingDown = false;

async function shutdown(signal, exitCode = 0) {
  if (isShuttingDown) {
    log.warn(`${signal} 수신 — 이미 종료 진행 중, 무시`);
    return;
  }
  isShuttingDown = true;
  log.warn(`${signal} 수신 → 종료 절차 시작`);
  try {
    if (publishTimer) clearInterval(publishTimer);
    await iot.disconnect();
    sensor.cleanup();
    light.cleanup();
  } catch (err) {
    log.error('shutdown 중 오류:', err.message);
  } finally {
    log.info('프로세스 종료');
    process.exit(exitCode);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  log.error('uncaughtException:', err);
  shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection:', reason);
  shutdown('unhandledRejection', 1);
});

bootstrap();
