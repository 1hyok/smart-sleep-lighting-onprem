// ──────────────────────────────────────────────
// sensor.js
//  - YL-40 모듈 (PCF8591 8-bit ADC) 의 아날로그 채널을 I2C 로 읽어
//    조도값(lux 추정) 을 반환.
//  - .env 의 MOCK_GPIO=true 거나 i2c-bus / I2C 통신 자체가 실패하면
//    가짜(mock) 데이터로 자동 폴백 → PC 개발 환경에서도 서버는 살아있음.
//  - 실제 센서 동작 / mock 동작을 절대 헷갈리지 않도록 로그 prefix 를
//    분리해 둠 ("[SENSOR] ✅ ..." vs "[WARNING] ⚠️ ...").
// ──────────────────────────────────────────────

const config = require('./config');
const buildLogger = require('./logger');
const log = buildLogger('sensor');

// PCF8591 control byte:
//   bit7 0
//   bit6 analog output enable (0 = disable, 충분히 빠른 변환)
//   bit5..4 input mode (00 = 4 single-ended)
//   bit3 0
//   bit2 auto-increment (0 = off, 우리는 명시적으로 채널 지정)
//   bit1..0 channel select (0..3)
const PCF8591_CONTROL_BASE = 0x40;

let i2cBus = null;
let useMock = config.gpio.mock;

if (!useMock) {
  try {
    const i2c = require('i2c-bus');
    i2cBus = i2c.openSync(config.sensor.i2cBus);
    log.info(
      `[SENSOR] I2C bus ${config.sensor.i2cBus} opened. ` +
        `target PCF8591 addr=0x${config.sensor.i2cAddress.toString(16)} ` +
        `channel=AIN${config.sensor.channel} invert=${config.sensor.invert}`,
    );
  } catch (err) {
    log.warn(
      `[WARNING] ⚠️  i2c-bus 초기화 실패 → MOCK 모드로 전환합니다: ${err.message}`,
    );
    useMock = true;
  }
}

/**
 * 시간대별로 그럴듯한 가짜 lux 값 생성. 실제 센서가 아닐 때만 사용.
 */
function generateMockLux() {
  const hour = new Date().getHours();
  const isDaytime = hour >= 6 && hour < 18;
  const min = isDaytime ? 300 : 0;
  const max = isDaytime ? 1000 : 200;
  const lux = Math.random() * (max - min) + min;
  return Number(lux.toFixed(2));
}

/**
 * PCF8591 단일 채널 ADC 읽기 (0..255).
 *  - 데이터시트상 control byte 전송 직후의 첫 read 는 "이전 변환 결과" 가
 *    돌아오므로, 2바이트를 연속으로 받아 두 번째 바이트를 채택한다.
 */
function readPcf8591Channel(channel) {
  const addr = config.sensor.i2cAddress;
  const controlByte = (PCF8591_CONTROL_BASE | (channel & 0x03)) & 0xff;

  i2cBus.sendByteSync(addr, controlByte);
  const buf = Buffer.alloc(2);
  i2cBus.i2cReadSync(addr, 2, buf);
  return buf[1];
}

// 노이즈 필터링 파라미터
//  - SAMPLE_BURST: 한 주기 내 연속 ADC read 횟수 (메디안으로 스파이크 제거)
//  - SMOOTH_WINDOW: 주기 간 이동 평균 윈도우 (잔여 노이즈 평활화)
const SAMPLE_BURST = 5;
const SMOOTH_WINDOW = 5;
const luxHistory = [];

/**
 * 한 주기 내 SAMPLE_BURST 회 연속 read 후 메디안 채택.
 *  - 단발성 스파이크/이상치를 제거 (PCF8591 8bit 분해능상 ±몇 lux 튐).
 */
function readBurstMedian() {
  const samples = [];
  for (let i = 0; i < SAMPLE_BURST; i++) {
    samples.push(readPcf8591Channel(config.sensor.channel));
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(SAMPLE_BURST / 2)];
}

/**
 * 주기 간 이동 평균. 메디안 후 잔여 노이즈를 부드럽게 평활화.
 */
function smoothLux(lux) {
  luxHistory.push(lux);
  if (luxHistory.length > SMOOTH_WINDOW) luxHistory.shift();
  const sum = luxHistory.reduce((a, b) => a + b, 0);
  return Number((sum / luxHistory.length).toFixed(2));
}

/**
 * PCF8591 raw ADC (0..255) → lux 추정값 (0..1000).
 *  - 정밀 캘리브레이션은 하지 않은 선형 매핑.
 *  - sensorWatcher 의 dark/bright 임계값 (기본 100 / 400) 과 같은 스케일.
 */
function adcToLux(raw) {
  const oriented = config.sensor.invert ? 255 - raw : raw;
  return Number(((oriented / 255) * 1000).toFixed(2));
}

/**
 * 외부에서 호출하는 공개 API.
 *  반환값: { lux, raw, source }
 *   - lux:    추정 조도값 (0~1000, 캘리브레이션 X — "lux_estimate")
 *   - raw:    PCF8591 ADC 원시값 (0~255). mock 인 경우 null.
 *   - source: 'sensor' | 'mock' — 다운스트림(데이터팀)이 mock 샘플을 필터링
 *             하거나 신뢰 가중치를 다르게 줄 수 있도록.
 *  성공 시: 실제 센서 prefix "[SENSOR] ✅"
 *  실패/Mock 시: "[WARNING] ⚠️" — 서버 자체는 죽지 않음.
 */
function readIlluminance() {
  if (useMock) {
    const lux = generateMockLux();
    log.warn(
      `[WARNING] ⚠️  Sensor not found/Mock Mode. Generating Mock Data: ${lux} lux`,
    );
    return { lux, raw: null, source: 'mock' };
  }

  try {
    // 단일 read → burst 메디안 + 이동 평균으로 노이즈 필터링.
    const raw = readBurstMedian();
    const lux = smoothLux(adcToLux(raw));
    log.info(
      `[SENSOR] ✅ Reading from YL-40: ${lux} lux ` +
        `(raw ADC=${raw}/255, AIN${config.sensor.channel}, ` +
        `burst=${SAMPLE_BURST}, smooth=${SMOOTH_WINDOW})`,
    );
    return { lux, raw, source: 'sensor' };
  } catch (err) {
    // I2C 통신 자체가 일시적으로 깨진 경우 — 한 사이클 mock 으로 메꿔
    // 다음 주기에 다시 시도. useMock 을 영구 전환하지는 않음.
    log.error(`[SENSOR] PCF8591 read 실패: ${err.message}`);
    const lux = generateMockLux();
    log.warn(
      `[WARNING] ⚠️  Sensor not found/Mock Mode. Generating Mock Data: ${lux} lux`,
    );
    return { lux, raw: null, source: 'mock' };
  }
}

/**
 * 프로세스 종료 시 I2C 버스 핸들 해제.
 */
function cleanup() {
  if (!i2cBus) return;
  try {
    i2cBus.closeSync();
    log.info('[SENSOR] I2C bus 자원 해제 완료');
  } catch (err) {
    log.warn(`[SENSOR] I2C close 오류: ${err.message}`);
  }
}

module.exports = { readIlluminance, cleanup };
