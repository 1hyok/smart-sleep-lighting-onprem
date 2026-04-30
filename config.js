// ──────────────────────────────────────────────
// config.js
//  - .env 파싱 + 기본값.
//  - 엣지 노드의 단일 책임(센서 수집 → 노이즈 필터링 → MQTT 발행)에
//    필요한 설정만 보관.
// ──────────────────────────────────────────────

require('dotenv').config();

const config = {
  mqtt: {
    brokerUrl: process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883',
    clientId:
      process.env.MQTT_CLIENT_ID ||
      `rpi-edge-${Math.random().toString(16).slice(2, 8)}`,
    // Mosquitto 브로커 allow_anonymous=false 운영 시 필수.
    // undefined 로 두면 인증 없이 접속 시도 (익명 허용 브로커용).
    username: process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PASSWORD || undefined,
  },

  topics: {
    illuminance: process.env.TOPIC_SENSOR_ILLUMINANCE || 'home/sensor/illuminance',
    // LWT(Last Will & Testament) + 정상 접속/종료 알림용. 항상 retain=true 로
    // 발행하므로 구독자(백엔드)는 어느 시점에 붙어도 엣지 가용 여부를
    // 즉시 1건 read 로 파악 가능.
    deviceStatus: process.env.TOPIC_DEVICE_STATUS || 'home/edge/status',
    // 백엔드 → 엣지 조명 제어 명령 (Subscribe).
    //  - 페이로드: { level: 0..100, durationMs?: number }
    //  - lightController.setBrightness 로 라우팅.
    lightCommand: process.env.TOPIC_LIGHT_COMMAND || 'home/edge/light/command',
  },

  sensor: {
    publishIntervalMs: Number(process.env.SENSOR_PUBLISH_INTERVAL_MS) || 3000,

    // YL-40 (PCF8591) I2C 설정
    //  - i2cBus: RPi 의 /dev/i2c-N (Pi 2 이상은 1번 버스가 표준)
    //  - i2cAddress: PCF8591 칩 주소. A0/A1/A2 점퍼 미납땜 기본 = 0x48
    //  - channel: 조도(LDR) 가 연결된 아날로그 입력. YL-40 보드는 보통 AIN0
    //  - invert: 보드의 분압 회로상 "어두울수록 ADC ↑" 면 true
    i2cBus: Number(process.env.PCF8591_I2C_BUS) || 1,
    i2cAddress: Number(process.env.PCF8591_I2C_ADDRESS) || 0x48,
    channel: Math.max(0, Math.min(3, Number(process.env.PCF8591_CHANNEL) || 0)),
    invert: String(process.env.PCF8591_INVERT).toLowerCase() === 'true',

    // PC 개발 환경에서 실제 I2C 가 없을 때 mock 데이터로 폴백.
    mock: String(process.env.MOCK_SENSOR).toLowerCase() === 'true',
  },

  light: {
    // RPi 하드웨어 PWM 가능 핀: BCM 12, 13, 18, 19. 그 외도 소프트웨어 PWM 가능
    // 하지만 페이드의 부드러움/지터는 하드웨어 PWM 이 우월.
    pin: Number(process.env.LIGHT_GPIO_PIN) || 18,

    // PC 개발 환경 / pigpio 미설치 시 mock 으로 폴백 (sensor.js 와 동일 패턴).
    //  - mock 모드에서는 GPIO write 대신 듀티값을 로그로만 출력 → 페이드 동작
    //    검증은 가능하나 실제 LED 는 켜지지 않음.
    mock: String(process.env.MOCK_LIGHT).toLowerCase() === 'true',
  },

  eventLog: {
    filePath:
      process.env.EVENT_LOG_PATH ||
      '/home/pi/smart-sleep-lighting-onprem/service_log.jsonl',
  },
};

module.exports = config;
