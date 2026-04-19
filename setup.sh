#!/usr/bin/env bash
# ==========================================================
# smart-sleep-lighting-onprem 원클릭 셋업 스크립트
#   - 프로젝트 폴더 생성
#   - 7개 소스 파일 생성 (.env / index.js / config.js /
#     logger.js / mqttClient.js / sensor.js / lightController.js)
#   - npm init + npm install
#
# 사용법 (라즈베리파이 터미널):
#   bash setup.sh
# 또는
#   curl -sL <url> | bash
# ==========================================================

set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-$HOME/smart-sleep-lighting-onprem}"

echo "── [1/4] 프로젝트 폴더 생성: $PROJECT_DIR"
mkdir -p "$PROJECT_DIR"
cd "$PROJECT_DIR"

# ----------------------------------------------------------
# .env
# ----------------------------------------------------------
echo "── [2/4] 소스 파일 생성"
cat << 'EOF' > .env
# ──────────────────────────────────────────────
# 환경변수 설정 파일
#  - 민감정보/환경별 값은 코드가 아닌 이곳에서 관리합니다.
# ──────────────────────────────────────────────

# [MQTT 브로커 설정] 로컬 Mosquitto 기본값
MQTT_BROKER_URL=mqtt://localhost:1883
MQTT_CLIENT_ID=rpi-edge-bedroom-01

# [토픽 설정]
TOPIC_ILLUMINANCE=home/bedroom/illuminance
TOPIC_LIGHT_CONTROL=home/bedroom/light/control

# [센서 발행 주기 (ms)]
SENSOR_PUBLISH_INTERVAL_MS=3000

# [GPIO 핀 번호 (BCM 기준)]
#  - LED_PIN : 단일 LED ON/OFF 용 (onoff)
#  - PWM_PIN : 밝기(디밍) 용 (pigpio, 하드웨어 PWM 권장: 12/13/18/19)
LED_PIN=17
PWM_PIN=18

# [개발 모드]
#  - true 로 설정하면 실제 GPIO 를 건드리지 않고 로그만 출력 (Mac/PC 테스트용)
MOCK_GPIO=false
EOF

# ----------------------------------------------------------
# config.js
# ----------------------------------------------------------
cat << 'EOF' > config.js
// ──────────────────────────────────────────────
// config.js
//  - .env 파일을 읽어 애플리케이션 전역에서 사용할
//    설정 객체를 생성합니다.
// ──────────────────────────────────────────────

require('dotenv').config(); // .env 파일 로딩 (process.env 에 주입)

const config = {
  mqtt: {
    brokerUrl: process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883',
    // 클라이언트 ID 충돌 방지: 미설정 시 랜덤 suffix
    clientId:
      process.env.MQTT_CLIENT_ID ||
      `rpi-edge-${Math.random().toString(16).slice(2, 8)}`,
  },

  topics: {
    illuminance: process.env.TOPIC_ILLUMINANCE || 'home/bedroom/illuminance',
    lightControl: process.env.TOPIC_LIGHT_CONTROL || 'home/bedroom/light/control',
  },

  sensor: {
    publishIntervalMs: Number(process.env.SENSOR_PUBLISH_INTERVAL_MS) || 3000,
  },

  gpio: {
    ledPin: Number(process.env.LED_PIN) || 17,
    pwmPin: Number(process.env.PWM_PIN) || 18,
    mock: String(process.env.MOCK_GPIO).toLowerCase() === 'true',
  },
};

module.exports = config;
EOF

# ----------------------------------------------------------
# logger.js
# ----------------------------------------------------------
cat << 'EOF' > logger.js
// ──────────────────────────────────────────────
// logger.js
//  - 시간 + 로그레벨 + 태그(모듈명) 형태의 콘솔 로거.
// ──────────────────────────────────────────────

function ts() {
  return new Date().toISOString();
}

function buildLogger(tag) {
  const prefix = `[${tag}]`;
  return {
    info:  (...args) => console.log  (`${ts()}  INFO  ${prefix}`, ...args),
    warn:  (...args) => console.warn (`${ts()}  WARN  ${prefix}`, ...args),
    error: (...args) => console.error(`${ts()}  ERROR ${prefix}`, ...args),
    debug: (...args) => {
      if (process.env.DEBUG === 'true') {
        console.log(`${ts()}  DEBUG ${prefix}`, ...args);
      }
    },
  };
}

module.exports = buildLogger;
EOF

# ----------------------------------------------------------
# sensor.js
# ----------------------------------------------------------
cat << 'EOF' > sensor.js
// ──────────────────────────────────────────────
// sensor.js
//  - 조도 센서 값 읽기. 보일러플레이트에서는 "가상 값" 생성.
//  - 실제 센서로 교체 시 readIlluminance() 내부만 수정하면 됨.
// ──────────────────────────────────────────────

const buildLogger = require('./logger');
const log = buildLogger('sensor');

/**
 * 가상의 조도값(lux) 반환
 *  - 06:00~18:00 : 300~1000 lux (주간)
 *  - 그 외       :   0~200  lux (야간)
 */
function readIlluminance() {
  try {
    const hour = new Date().getHours();
    const isDaytime = hour >= 6 && hour < 18;
    const min = isDaytime ? 300 : 0;
    const max = isDaytime ? 1000 : 200;
    const lux = Math.random() * (max - min) + min;
    return Number(lux.toFixed(2));
  } catch (err) {
    log.error('조도 센서 읽기 실패:', err.message);
    throw err;
  }
}

module.exports = { readIlluminance };
EOF

# ----------------------------------------------------------
# lightController.js
# ----------------------------------------------------------
cat << 'EOF' > lightController.js
// ──────────────────────────────────────────────
// lightController.js
//  - 실제 GPIO 핀으로 조명(LED) ON/OFF 및 밝기 제어.
//  - ON/OFF  : onoff
//  - 디밍     : pigpio (하드웨어 PWM)
//  - MOCK 모드 : 실제 핀 접근 없이 로그만 출력 (Mac/PC 테스트용)
// ──────────────────────────────────────────────

const config = require('./config');
const buildLogger = require('./logger');
const log = buildLogger('light');

let Gpio;         // onoff
let PigpioGpio;   // pigpio
let useMock = config.gpio.mock;

if (!useMock) {
  try {
    Gpio = require('onoff').Gpio;
    PigpioGpio = require('pigpio').Gpio;
  } catch (err) {
    log.warn(
      'GPIO 라이브러리 로딩 실패 → MOCK 모드로 전환합니다. (라즈베리파이 외 환경에서는 정상)',
      err.message,
    );
    useMock = true;
  }
}

let ledPin = null; // onoff 핸들 (ON/OFF)
let pwmPin = null; // pigpio 핸들 (디밍)

function init() {
  if (useMock) {
    log.info(`[MOCK] GPIO 초기화 (LED pin=${config.gpio.ledPin}, PWM pin=${config.gpio.pwmPin})`);
    return;
  }

  try {
    ledPin = new Gpio(config.gpio.ledPin, 'out');
    pwmPin = new PigpioGpio(config.gpio.pwmPin, { mode: PigpioGpio.OUTPUT });
    pwmPin.pwmWrite(0); // 초기값: 꺼짐
    log.info(`GPIO 초기화 완료 (LED pin=${config.gpio.ledPin}, PWM pin=${config.gpio.pwmPin})`);
  } catch (err) {
    log.error('GPIO 초기화 실패:', err.message);
    throw err;
  }
}

function setPower(state) {
  const on = state === 'ON';
  if (useMock) {
    log.info(`[MOCK] 조명 ${on ? '켜짐' : '꺼짐'}`);
    return;
  }
  try {
    ledPin.writeSync(on ? 1 : 0);
    pwmPin.pwmWrite(on ? 255 : 0);
    log.info(`조명 ${on ? '켜짐' : '꺼짐'}`);
  } catch (err) {
    log.error('조명 전원 제어 실패:', err.message);
  }
}

function setBrightness(level) {
  const clamped = Math.max(0, Math.min(100, Number(level)));
  const duty = Math.round((clamped / 100) * 255); // pigpio: 0~255
  if (useMock) {
    log.info(`[MOCK] 밝기 설정: ${clamped}% (duty=${duty})`);
    return;
  }
  try {
    pwmPin.pwmWrite(duty);
    ledPin.writeSync(clamped > 0 ? 1 : 0);
    log.info(`밝기 설정: ${clamped}% (duty=${duty})`);
  } catch (err) {
    log.error('밝기 제어 실패:', err.message);
  }
}

/**
 * MQTT 제어 페이로드 파서.
 * 지원 포맷:
 *   "ON" / "OFF" / "0~100"
 *   { "power": "ON" }
 *   { "brightness": 70 }
 *   { "power": "ON", "brightness": 30 }
 */
function handleControlMessage(rawPayload) {
  const text = rawPayload.toString().trim();
  log.info(`제어 명령 수신: "${text}"`);

  // 1) JSON
  try {
    const obj = JSON.parse(text);
    if (typeof obj === 'object' && obj !== null) {
      if (obj.power) setPower(String(obj.power).toUpperCase());
      if (obj.brightness !== undefined) setBrightness(obj.brightness);
      return;
    }
  } catch (_) { /* fallthrough */ }

  // 2) ON / OFF
  const upper = text.toUpperCase();
  if (upper === 'ON' || upper === 'OFF') {
    setPower(upper);
    return;
  }

  // 3) 숫자 → 밝기 %
  const num = Number(text);
  if (!Number.isNaN(num)) {
    setBrightness(num);
    return;
  }

  log.warn(`해석할 수 없는 제어 메시지: "${text}" (무시)`);
}

function cleanup() {
  if (useMock) return;
  try {
    if (ledPin) {
      ledPin.writeSync(0);
      ledPin.unexport();
    }
    if (pwmPin) pwmPin.pwmWrite(0);
    log.info('GPIO 자원 해제 완료');
  } catch (err) {
    log.error('GPIO cleanup 중 오류:', err.message);
  }
}

module.exports = {
  init,
  setPower,
  setBrightness,
  handleControlMessage,
  cleanup,
};
EOF

# ----------------------------------------------------------
# mqttClient.js
# ----------------------------------------------------------
cat << 'EOF' > mqttClient.js
// ──────────────────────────────────────────────
// mqttClient.js
//  - mqtt.js 기반 브로커 연결/구독/발행 래퍼.
//  - 자동 재연결 + 재구독.
// ──────────────────────────────────────────────

const mqtt = require('mqtt');
const config = require('./config');
const buildLogger = require('./logger');
const log = buildLogger('mqtt');

const handlers = new Map(); // topic → callback
let client = null;

function connect() {
  log.info(`브로커 연결 시도: ${config.mqtt.brokerUrl} (clientId=${config.mqtt.clientId})`);

  client = mqtt.connect(config.mqtt.brokerUrl, {
    clientId: config.mqtt.clientId,
    clean: true,
    reconnectPeriod: 2000,
    connectTimeout: 10_000,
  });

  client.on('connect', () => {
    log.info('브로커 연결 성공');
    // 재연결 시 기존 토픽 자동 재구독
    for (const topic of handlers.keys()) {
      client.subscribe(topic, { qos: 1 }, (err) => {
        if (err) log.error(`재구독 실패 [${topic}]:`, err.message);
        else log.info(`재구독 완료 [${topic}]`);
      });
    }
  });

  client.on('reconnect', () => log.warn('브로커 재연결 시도 중...'));
  client.on('close',     () => log.warn('브로커 연결 종료'));
  client.on('offline',   () => log.warn('브로커와 오프라인 상태'));
  client.on('error',   (err) => log.error('MQTT 에러:', err.message));

  client.on('message', (topic, payload) => {
    const handler = handlers.get(topic);
    if (!handler) {
      log.debug(`핸들러 없는 토픽 메시지 수신 [${topic}]`);
      return;
    }
    try {
      handler(payload, topic);
    } catch (err) {
      log.error(`메시지 처리 중 예외 [${topic}]:`, err.message);
    }
  });

  return client;
}

function subscribe(topic, handler) {
  if (!client) throw new Error('connect() 호출 후 subscribe() 를 사용하세요.');
  handlers.set(topic, handler);

  client.subscribe(topic, { qos: 1 }, (err) => {
    if (err) log.error(`구독 실패 [${topic}]:`, err.message);
    else log.info(`구독 완료 [${topic}]`);
  });
}

function publish(topic, message, options = { qos: 0, retain: false }) {
  if (!client || !client.connected) {
    log.warn(`발행 보류 (미연결 상태) [${topic}]`);
    return;
  }
  const payload =
    typeof message === 'string' || Buffer.isBuffer(message)
      ? message
      : JSON.stringify(message);

  client.publish(topic, payload, options, (err) => {
    if (err) log.error(`발행 실패 [${topic}]:`, err.message);
    else log.debug(`발행 완료 [${topic}] → ${payload}`);
  });
}

function disconnect() {
  return new Promise((resolve) => {
    if (!client) return resolve();
    client.end(false, {}, () => {
      log.info('브로커 연결 정상 종료');
      resolve();
    });
  });
}

module.exports = { connect, subscribe, publish, disconnect };
EOF

# ----------------------------------------------------------
# index.js
# ----------------------------------------------------------
cat << 'EOF' > index.js
// ──────────────────────────────────────────────
// index.js
//  - 애플리케이션 진입점.
//  - 센서 주기 발행 + 제어 명령 구독→GPIO 제어 조립.
// ──────────────────────────────────────────────

const config = require('./config');
const mqttClient = require('./mqttClient');
const lightController = require('./lightController');
const sensor = require('./sensor');
const buildLogger = require('./logger');

const log = buildLogger('app');

let publishTimer = null;

function publishSensorReading() {
  try {
    const lux = sensor.readIlluminance();
    const payload = {
      deviceId: config.mqtt.clientId,
      value: lux,
      unit: 'lux',
      timestamp: new Date().toISOString(),
    };
    mqttClient.publish(config.topics.illuminance, payload, { qos: 0, retain: false });
    log.info(`조도값 발행 → ${lux} lux`);
  } catch (err) {
    // 센서 오류가 있어도 프로세스는 유지 (다음 주기에 재시도)
    log.error('센서 주기 발행 실패:', err.message);
  }
}

function bootstrap() {
  log.info('── 스마트 수면 조명 엣지 노드 기동 ──');
  log.info(`모드: ${config.gpio.mock ? 'MOCK (GPIO 비활성)' : 'RPI (GPIO 활성)'}`);

  lightController.init();
  const client = mqttClient.connect();

  client.once('connect', () => {
    mqttClient.subscribe(config.topics.lightControl, (payload) => {
      lightController.handleControlMessage(payload);
    });

    publishSensorReading(); // 부팅 직후 1회
    publishTimer = setInterval(publishSensorReading, config.sensor.publishIntervalMs);
    log.info(`센서 발행 타이머 시작 (주기 ${config.sensor.publishIntervalMs}ms)`);
  });
}

async function shutdown(signal) {
  log.warn(`${signal} 수신 → 종료 절차 시작`);
  try {
    if (publishTimer) clearInterval(publishTimer);
    await mqttClient.disconnect();
    lightController.cleanup();
  } catch (err) {
    log.error('shutdown 중 오류:', err.message);
  } finally {
    log.info('프로세스 종료');
    process.exit(0);
  }
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException',  (err)    => log.error('uncaughtException:', err));
process.on('unhandledRejection', (reason) => log.error('unhandledRejection:', reason));

bootstrap();
EOF

# ----------------------------------------------------------
# package.json 초기화 및 의존성 설치
# ----------------------------------------------------------
echo "── [3/4] npm init"
if [ ! -f package.json ]; then
  npm init -y >/dev/null
fi

# 실행 스크립트 등록 (npm start / npm run dev)
node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
  p.main = "index.js";
  p.scripts = Object.assign({}, p.scripts, {
    start: "node index.js",
    dev:   "MOCK_GPIO=true node index.js"
  });
  fs.writeFileSync("package.json", JSON.stringify(p, null, 2));
'

echo "── [4/4] npm install (mqtt, onoff, pigpio, dotenv)"
# onoff / pigpio 는 라즈베리파이 외 환경에서 네이티브 빌드가 실패할 수 있으므로
# 실패해도 스크립트가 멈추지 않도록 분리 설치합니다.
npm install mqtt dotenv
npm install onoff pigpio || {
  echo "⚠️  onoff/pigpio 설치가 실패했습니다. (라즈베리파이가 아닌 환경이라면 정상)"
  echo "    .env 의 MOCK_GPIO=true 로 두면 MOCK 모드로 실행할 수 있습니다."
}

echo ""
echo "✅ 셋업 완료 → $PROJECT_DIR"
echo ""
echo "▶ 실행:"
echo "    cd $PROJECT_DIR"
echo "    sudo node index.js          # 라즈베리파이 (GPIO 사용)"
echo "    npm run dev                 # MOCK 모드 (Mac/PC 테스트)"
echo ""
echo "▶ 테스트 (다른 터미널):"
echo "    mosquitto_sub -h localhost -t 'home/bedroom/illuminance' -v"
echo "    mosquitto_pub -h localhost -t 'home/bedroom/light/control' -m 'ON'"
echo "    mosquitto_pub -h localhost -t 'home/bedroom/light/control' -m '50'"
echo "    mosquitto_pub -h localhost -t 'home/bedroom/light/control' -m '{\"power\":\"ON\",\"brightness\":30}'"
