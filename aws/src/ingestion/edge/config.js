// ──────────────────────────────────────────────
// config.js  (엣지 노드 — AWS IoT Core 발행/명령 수신)
//  - 프로젝트 6: 라즈베리파이가 로컬 Mosquitto 대신 AWS IoT Core 로 직접
//    MQTT over TLS 발행하고, Device Shadow 로 조명 명령을 받는다.
//  - 담당: 정일혁 (Ingestion Layer — spec-ingestion-iot.md)
//
//  ⚠️ 토픽/페이로드 계약 (변경 금지 — IoT Rule SQL·백엔드가 이 필드를 참조)
//   · home/sensor/illuminance : { deviceId, value, raw, source, unit, timestamp }
//   · home/edge/status        : { deviceId, status, timestamp, reason }  (LWT, retain)
//   deviceId = clientId = IoT Thing 이름.
//
//  ⚠️ dry-run 폴백
//   AWS 엔드포인트나 X.509 인증서가 없으면 실제 IoT Core 에 접속하지 않고
//   "발행될 내용"만 로깅 → 인증서 없는 PC 에서도 파이프라인 검증 가능.
// ──────────────────────────────────────────────

require('dotenv').config();

const fs = require('fs');

// 디바이스 식별자 규칙: rpi-edge-<room>-<seq> (= IoT Thing 이름 = deviceId)
const thingName = process.env.IOT_THING_NAME || 'rpi-edge-bedroom-01';

// 인증서 3종 경로 (개인키 / 디바이스 인증서 / Amazon Root CA).
const certs = {
  key: process.env.IOT_PRIVATE_KEY_PATH || './certs/private.pem.key',
  cert: process.env.IOT_CERT_PATH || './certs/device.pem.crt',
  ca: process.env.IOT_ROOT_CA_PATH || './certs/AmazonRootCA1.pem',
};

function certsPresent() {
  try {
    return [certs.key, certs.cert, certs.ca].every((p) => p && fs.existsSync(p));
  } catch {
    return false;
  }
}

// 엔드포인트 또는 인증서가 없으면 dry-run. MOCK_IOT=true 로 강제도 가능.
const dryRun =
  String(process.env.MOCK_IOT).toLowerCase() === 'true' ||
  !process.env.AWS_IOT_ENDPOINT ||
  !certsPresent();

const config = {
  iot: {
    // 예) xxxxxxxxxxxxxx-ats.iot.ap-northeast-2.amazonaws.com
    //   `aws iot describe-endpoint --endpoint-type iot:Data-ATS` 로 확인.
    endpoint: process.env.AWS_IOT_ENDPOINT,
    port: Number(process.env.AWS_IOT_PORT) || 8883, // IoT Core mTLS 전용 포트
    region: process.env.AWS_REGION || 'ap-northeast-2',

    thingName,
    deviceId: thingName, // 페이로드/DynamoDB device_id = Thing 이름
    // IoT Core 권장: clientId = thingName. 정책 변수(${iot:Connection.Thing.ThingName})/연결 추적이 깔끔.
    clientId: process.env.IOT_CLIENT_ID || thingName,

    certs,
    dryRun,
  },

  // 온프레미스(프로젝트 3)와 동일한 토픽 네임스페이스 유지 →
  // IoT Rule SQL 친화 + 백엔드(임형택) 구독 계약 일치 (spec §1).
  topics: {
    illuminance: 'home/sensor/illuminance', // QoS 1, retain false, 주기 발행
    status: 'home/edge/status', // QoS 1, retain TRUE, LWT
  },

  // 조명 actuation (Shadow desired 수신 시 엣지 로컬 GPIO 실행 — spec §5).
  lighting: {
    pwmGpio: Number(process.env.LIGHT_PWM_GPIO) || 18, // BCM 18 하드웨어 PWM
    // 데모용 시간 압축 배율 (1=실시간 30분/15분, 0.01=약 100배 빠름).
    timeScale: Number(process.env.LIGHTING_TIME_SCALE) || 1,
  },

  sensor: {
    publishIntervalMs: Number(process.env.SENSOR_PUBLISH_INTERVAL_MS) || 3000,

    // YL-40 (PCF8591) I2C 설정 — 온프렘과 동일.
    i2cBus: Number(process.env.PCF8591_I2C_BUS) || 1,
    i2cAddress: Number(process.env.PCF8591_I2C_ADDRESS) || 0x48,
    channel: Math.max(0, Math.min(3, Number(process.env.PCF8591_CHANNEL) || 0)),
    invert: String(process.env.PCF8591_INVERT).toLowerCase() === 'true',

    // PC 개발 환경에서 실제 I2C 가 없을 때 mock 데이터로 폴백.
    mock: String(process.env.MOCK_SENSOR).toLowerCase() === 'true',
  },
};

module.exports = config;
