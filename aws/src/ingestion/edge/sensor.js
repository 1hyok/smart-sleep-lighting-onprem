// ──────────────────────────────────────────────
// sensor.js
//  - YL-40 모듈 (PCF8591 8-bit ADC) 의 아날로그 채널을 I2C 로 읽어
//    조도값(lux 추정) 을 반환. (온프렘 프로젝트 3에서 재사용 — 센서 수집/
//    노이즈 필터링은 디바이스 측 책임으로 클라우드 전환 후에도 그대로 유지, spec §1)
//  - MOCK_SENSOR=true 거나 i2c-bus / I2C 통신이 실패하면 가짜(mock) 데이터로
//    자동 폴백 → PC 개발 환경에서도 발행 파이프라인을 확인할 수 있음.
// ──────────────────────────────────────────────

const config = require('./config');
const buildLogger = require('./logger');
const log = buildLogger('sensor');

// PCF8591 control byte (single-ended, 명시적 채널 지정)
const PCF8591_CONTROL_BASE = 0x40;

let i2cBus = null;
let useMock = config.sensor.mock;

if (!useMock) {
  try {
    const i2c = require('i2c-bus');
    i2cBus = i2c.openSync(config.sensor.i2cBus);
    log.info(
      `[SENSOR] I2C bus ${config.sensor.i2cBus} opened. ` +
        `addr=0x${config.sensor.i2cAddress.toString(16)} ` +
        `channel=AIN${config.sensor.channel} invert=${config.sensor.invert}`,
    );
  } catch (err) {
    log.warn(`[WARNING] ⚠️  i2c-bus 초기화 실패 → MOCK 모드 전환: ${err.message}`);
    useMock = true;
  }
}

// 시간대별로 그럴듯한 가짜 lux 값 생성. 실제 센서가 아닐 때만 사용.
function generateMockLux() {
  const hour = new Date().getHours();
  const isDaytime = hour >= 6 && hour < 18;
  const min = isDaytime ? 300 : 0;
  const max = isDaytime ? 1000 : 200;
  return Number((Math.random() * (max - min) + min).toFixed(2));
}

// PCF8591 단일 채널 ADC 읽기 (0..255).
//  - control byte 직후 첫 read 는 "이전 변환 결과" 라 2바이트 받아 두 번째 채택.
function readPcf8591Channel(channel) {
  const addr = config.sensor.i2cAddress;
  const controlByte = (PCF8591_CONTROL_BASE | (channel & 0x03)) & 0xff;
  i2cBus.sendByteSync(addr, controlByte);
  const buf = Buffer.alloc(2);
  i2cBus.i2cReadSync(addr, 2, buf);
  return buf[1];
}

// 노이즈 필터링: 버스트 메디안(스파이크 제거) + 이동 평균(평활화)
const SAMPLE_BURST = 5;
const SMOOTH_WINDOW = 5;
const luxHistory = [];

function readBurstMedian() {
  const samples = [];
  for (let i = 0; i < SAMPLE_BURST; i++) {
    samples.push(readPcf8591Channel(config.sensor.channel));
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(SAMPLE_BURST / 2)];
}

function smoothLux(lux) {
  luxHistory.push(lux);
  if (luxHistory.length > SMOOTH_WINDOW) luxHistory.shift();
  const sum = luxHistory.reduce((a, b) => a + b, 0);
  return Number((sum / luxHistory.length).toFixed(2));
}

// PCF8591 raw ADC (0..255) → lux 추정값 (0..1000). 정밀 캘리브레이션 X.
function adcToLux(raw) {
  const oriented = config.sensor.invert ? 255 - raw : raw;
  return Number(((oriented / 255) * 1000).toFixed(2));
}

/**
 * 공개 API. 반환값: { lux, raw, source }
 *   - lux:    추정 조도값 (0~1000, "lux_estimate")
 *   - raw:    PCF8591 ADC 원시값 (0~255). mock 이면 null.
 *   - source: 'sensor' | 'mock'
 */
function readIlluminance() {
  if (useMock) {
    const lux = generateMockLux();
    log.warn(`[WARNING] ⚠️  Mock Mode. Generating Mock Data: ${lux} lux`);
    return { lux, raw: null, source: 'mock' };
  }

  try {
    const raw = readBurstMedian();
    const lux = smoothLux(adcToLux(raw));
    log.info(
      `[SENSOR] ✅ YL-40: ${lux} lux (raw ADC=${raw}/255, AIN${config.sensor.channel}, ` +
        `burst=${SAMPLE_BURST}, smooth=${SMOOTH_WINDOW})`,
    );
    return { lux, raw, source: 'sensor' };
  } catch (err) {
    // 일시적 I2C 오류 — 한 사이클 mock 으로 메꾸고 다음 주기 재시도(영구 전환 X).
    log.error(`[SENSOR] PCF8591 read 실패: ${err.message}`);
    const lux = generateMockLux();
    return { lux, raw: null, source: 'mock' };
  }
}

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
