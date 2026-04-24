// ──────────────────────────────────────────────
// config.js
//  - .env 파싱 + 기본값 + 파생값 계산.
// ──────────────────────────────────────────────

require('dotenv').config();

/**
 * "R,G,B" 형식 문자열을 [r,g,b] 배열(각 0~255, clamp)로 파싱.
 */
function parseRgb(str, fallback) {
  if (!str) return fallback;
  const parts = String(str).split(',').map((s) => Number(s.trim()));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return fallback;
  return parts.map((n) => Math.max(0, Math.min(255, Math.round(n))));
}

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

  web: {
    // Express 대시보드 HTTP 포트 (0.0.0.0 바인딩)
    port: Number(process.env.WEB_PORT) || 3000,
  },

  topics: {
    lux: process.env.TOPIC_SENSOR_LUX || 'home/sensor/lux',
    lightControl: process.env.TOPIC_LIGHT_CONTROL || 'home/bedroom/light/control',
    routineSleep: process.env.TOPIC_ROUTINE_SLEEP || 'routine/sleep',
    routineWakeup: process.env.TOPIC_ROUTINE_WAKEUP || 'routine/wakeup',
    routineSuggestion:
      process.env.TOPIC_ROUTINE_SUGGESTION || 'home/bedroom/routine_suggestion',
  },

  sensor: {
    publishIntervalMs: Number(process.env.SENSOR_PUBLISH_INTERVAL_MS) || 3000,
    darkLux: Number(process.env.SENSOR_DARK_LUX) || 100,
    brightLux: Number(process.env.SENSOR_BRIGHT_LUX) || 400,
    // 연속 N개 샘플이 조건을 만족해야 상태 전이 (히스테리시스)
    window: Number(process.env.SENSOR_WINDOW) || 2,
  },

  routines: {
    sleepDurationMs: Number(process.env.SLEEP_DURATION_MS) || 600_000,
    wakeupDurationMs: Number(process.env.WAKEUP_DURATION_MS) || 600_000,
    steps: Number(process.env.ROUTINE_STEPS) || 50,

    // 색 팔레트 — 루틴 페이딩 시 RGB 선형보간의 양 끝점.
    palette: {
      sleepFrom: parseRgb(process.env.SLEEP_COLOR_FROM, [255, 90, 20]),
      sleepTo: parseRgb(process.env.SLEEP_COLOR_TO, [0, 0, 0]),
      wakeupFrom: parseRgb(process.env.WAKEUP_COLOR_FROM, [5, 8, 20]),
      wakeupTo: parseRgb(process.env.WAKEUP_COLOR_TO, [180, 200, 255]),
    },
  },

  eventLog: {
    filePath:
      process.env.EVENT_LOG_PATH ||
      '/home/pi/smart-sleep-lighting-onprem/service_log.jsonl',
  },

  gpio: {
    // 4핀 RGB LED 의 R / G / B 각 채널
    rgb: {
      r: Number(process.env.RGB_PIN_R) || 17,
      g: Number(process.env.RGB_PIN_G) || 27,
      b: Number(process.env.RGB_PIN_B) || 22,
    },
    // Common Anode 타입이면 듀티 사이클을 반전(255-x)시켜 써야 함.
    commonAnode: String(process.env.RGB_COMMON_ANODE).toLowerCase() === 'true',
    mock: String(process.env.MOCK_GPIO).toLowerCase() === 'true',
  },
};

module.exports = config;
