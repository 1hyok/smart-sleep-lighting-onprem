// ──────────────────────────────────────────────
// lightController.js
//  - RGB LED(4핀) 를 3채널 PWM 으로 제어.
//  - 단순 밝기뿐 아니라 색상(R/G/B) 까지 런타임 제어 가능.
//  - Common Cathode / Common Anode 양쪽 모두 지원 (config.gpio.commonAnode).
//  - 기존 pigpio 락 충돌 우회 방침 유지: npm `pigpio` 가 C 라이브러리 직접 초기화,
//    pigpiod 데몬은 꺼둔 상태여야 함.
// ──────────────────────────────────────────────

const config = require('./config');
const buildLogger = require('./logger');
const log = buildLogger('light');

let PigpioGpio;
let useMock = config.gpio.mock;

if (!useMock) {
  try {
    PigpioGpio = require('pigpio').Gpio;
  } catch (err) {
    log.warn(
      'pigpio 라이브러리 로딩 실패 → MOCK 모드로 전환합니다.',
      err.message,
    );
    useMock = true;
  }
}

// 채널별 pigpio 핸들
const channels = { r: null, g: null, b: null };

// 마지막으로 실제 하드웨어에 기록된 RGB 값 (0~255). 상태 조회/로그용.
let lastWritten = { r: 0, g: 0, b: 0 };

// 직접 제어용 프리셋 팔레트
const PRESETS = {
  off:   [0, 0, 0],
  warm:  [255, 120, 40],
  cool:  [180, 200, 255],
  white: [255, 255, 255],
  red:   [255, 0, 0],
  green: [0, 255, 0],
  blue:  [0, 0, 255],
  amber: [255, 90, 20],
};

function clamp(n) {
  return Math.max(0, Math.min(255, Math.round(Number(n) || 0)));
}

// 감마 보정 (γ=2.2 기본).
//  - 인간 시각 응답이 로그 스케일이라 선형 보간 페이딩 끝부분에서
//    "급격히 어두워지는/밝아지는" 체감이 발생.
//  - 0..255 → 0..1 → ^γ → 0..255 비선형 매핑하여 자연스럽게 만듦.
//  - lastWritten 은 보정 전 값을 보관해 getState/상태 조회 의미를 일관되게 유지.
const GAMMA = Number(process.env.LIGHT_GAMMA) || 2.2;

// PWM 분해능 확장 — 기본 256 → PWM_RANGE
//  - 외부 인터페이스(R/G/B)는 0~255 그대로 유지하고, 듀티 변환 시점에만
//    0..PWM_RANGE 로 스케일 업. 어두운 영역(amber→off 끝부분)에서 RGB 1단위
//    변화도 듀티에 미세히 반영돼 계단(staircase) 현상이 줄어듦.
//  - pigpio software PWM frequency = sample_rate / range. 1000 으로 잡으면
//    기본 200Hz 대 → 사람 눈에 깜빡임 미인지.
const PWM_RANGE = Number(process.env.PWM_RANGE) || 1000;

// 0..255 RGB → 0..PWM_RANGE 듀티 (감마 보정 포함).
function gammaCorrect(v) {
  const norm = clamp(v) / 255;
  return Math.round(Math.pow(norm, GAMMA) * PWM_RANGE);
}

/**
 * 감마 보정 결과(0..PWM_RANGE)를 받아 Common Anode 일 경우 반전.
 *  - 기존 0..255 스케일에서 0..PWM_RANGE 스케일로 확장됨.
 */
function toDuty(value) {
  const v = Math.max(0, Math.min(PWM_RANGE, Math.round(Number(value) || 0)));
  return config.gpio.commonAnode ? PWM_RANGE - v : v;
}

/**
 * GPIO 초기화. 애플리케이션 시작 시 1회.
 */
function init() {
  if (useMock) {
    log.info(
      `[MOCK] RGB GPIO 초기화 (R=${config.gpio.rgb.r}, G=${config.gpio.rgb.g}, B=${config.gpio.rgb.b}, commonAnode=${config.gpio.commonAnode})`,
    );
    return;
  }

  try {
    channels.r = new PigpioGpio(config.gpio.rgb.r, { mode: PigpioGpio.OUTPUT });
    channels.g = new PigpioGpio(config.gpio.rgb.g, { mode: PigpioGpio.OUTPUT });
    channels.b = new PigpioGpio(config.gpio.rgb.b, { mode: PigpioGpio.OUTPUT });
    // PWM 분해능 확장 (기본 256 → PWM_RANGE). 저조도 구간 미세 제어용.
    channels.r.pwmRange(PWM_RANGE);
    channels.g.pwmRange(PWM_RANGE);
    channels.b.pwmRange(PWM_RANGE);
    // 초기값: 전체 OFF
    writeRgb(0, 0, 0);
    log.info(
      `RGB GPIO 초기화 완료 (R=${config.gpio.rgb.r}, G=${config.gpio.rgb.g}, B=${config.gpio.rgb.b}, ` +
        `commonAnode=${config.gpio.commonAnode}, pwmRange=${PWM_RANGE})`,
    );
  } catch (err) {
    log.error('RGB GPIO 초기화 실패:', err.message);
    throw err;
  }
}

/**
 * 내부 전용: 실제 하드웨어 기록 함수.
 *  - 세 채널 pwmWrite + 상태 기록.
 */
function writeRgb(r, g, b) {
  const R = clamp(r);
  const G = clamp(g);
  const B = clamp(b);

  if (useMock) {
    lastWritten = { r: R, g: G, b: B };
    return;
  }

  try {
    channels.r.pwmWrite(toDuty(gammaCorrect(R)));
    channels.g.pwmWrite(toDuty(gammaCorrect(G)));
    channels.b.pwmWrite(toDuty(gammaCorrect(B)));
    lastWritten = { r: R, g: G, b: B };
  } catch (err) {
    log.error(`RGB 쓰기 실패: ${err.message}`);
  }
}

/**
 * 공개 API: 절대 RGB 값으로 직접 설정 (각 0~255).
 */
function setRGB(r, g, b) {
  writeRgb(r, g, b);
  log.info(`RGB 설정: (${lastWritten.r}, ${lastWritten.g}, ${lastWritten.b})`);
}

/**
 * 공개 API: 현재 색상의 비율을 유지하면서 밝기(%)만 조정.
 *  - 현재 색 = (r,g,b). 밝기는 max 채널 기준 정규화.
 *  - 현재 값이 전부 0 이면 warm 프리셋을 기본 색으로 가정.
 * @param {number} pct 0~100
 */
function setBrightness(pct) {
  const p = Math.max(0, Math.min(100, Number(pct)));
  let base = [lastWritten.r, lastWritten.g, lastWritten.b];
  if (base.every((v) => v === 0)) base = PRESETS.warm; // 꺼진 상태면 warm 기본값

  const maxCh = Math.max(...base) || 1;
  const scale = (p / 100) * (255 / maxCh);
  const next = base.map((v) => clamp(v * scale));
  writeRgb(next[0], next[1], next[2]);
  log.info(`밝기 설정: ${p}% → RGB(${next[0]}, ${next[1]}, ${next[2]})`);
}

/**
 * 공개 API: ON/OFF.
 *  - ON  : 마지막 색 복원 (꺼져 있었다면 warm 프리셋 100%)
 *  - OFF : 0,0,0 으로 즉시 소등
 */
function setPower(state) {
  const on = String(state).toUpperCase() === 'ON';
  if (!on) {
    writeRgb(0, 0, 0);
    log.info('조명 꺼짐');
    return;
  }
  // 현재 값이 모두 0 이면 warm 100% 로 점등
  if ([lastWritten.r, lastWritten.g, lastWritten.b].every((v) => v === 0)) {
    writeRgb(...PRESETS.warm);
  } else {
    writeRgb(lastWritten.r, lastWritten.g, lastWritten.b);
  }
  log.info(`조명 켜짐 → RGB(${lastWritten.r}, ${lastWritten.g}, ${lastWritten.b})`);
}

/**
 * 공개 API: 프리셋 이름으로 설정.
 */
function setPreset(name) {
  const color = PRESETS[String(name || '').toLowerCase()];
  if (!color) {
    log.warn(`알 수 없는 프리셋: ${name} (가능: ${Object.keys(PRESETS).join(', ')})`);
    return false;
  }
  writeRgb(...color);
  log.info(`프리셋 "${name}" 적용 → RGB(${color.join(', ')})`);
  return true;
}

/**
 * 현재 기록된 RGB 상태 조회.
 */
function getState() {
  return { ...lastWritten };
}

/**
 * MQTT 제어 페이로드 파서.
 *  지원 포맷:
 *   · "ON" / "OFF"
 *   · "50"                                → 밝기 %
 *   · "warm"/"cool"/"red"/"green"/...     → 프리셋
 *   · {"power":"ON"} / {"brightness":70}
 *   · {"r":255,"g":0,"b":100}             → 직접 RGB
 *   · {"preset":"warm"}
 *   · {"hex":"#ff8800"}
 */
function handleControlMessage(rawPayload) {
  const text = rawPayload.toString().trim();
  log.info(`제어 명령 수신: "${text}"`);

  // 1) JSON 우선 시도
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object') {
      if (typeof obj.hex === 'string') {
        const c = hexToRgb(obj.hex);
        if (c) setRGB(c[0], c[1], c[2]);
      }
      if (typeof obj.preset === 'string') setPreset(obj.preset);
      if (Number.isFinite(obj.r) || Number.isFinite(obj.g) || Number.isFinite(obj.b)) {
        setRGB(obj.r ?? 0, obj.g ?? 0, obj.b ?? 0);
      }
      if (obj.power) setPower(obj.power);
      if (obj.brightness !== undefined) setBrightness(obj.brightness);
      return;
    }
  } catch (_) { /* fallthrough */ }

  // 2) 단순 문자열
  const upper = text.toUpperCase();
  if (upper === 'ON' || upper === 'OFF') { setPower(upper); return; }
  if (PRESETS[text.toLowerCase()]) { setPreset(text); return; }

  // 3) 숫자 → 밝기
  const num = Number(text);
  if (!Number.isNaN(num)) { setBrightness(num); return; }

  log.warn(`해석할 수 없는 제어 메시지: "${text}" (무시)`);
}

/**
 * "#RRGGBB" 또는 "RRGGBB" → [r,g,b] (실패 시 null).
 */
function hexToRgb(hex) {
  const s = String(hex).replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  return [
    parseInt(s.slice(0, 2), 16),
    parseInt(s.slice(2, 4), 16),
    parseInt(s.slice(4, 6), 16),
  ];
}

/**
 * 종료 시 채널 OFF + pigpio C 라이브러리 명시적 종료.
 *  - pwmWrite(0) 만 부르면 LED 는 꺼지지만 pigpio 가 핀 모드를 잡고 있는 상태.
 *  - terminate() 까지 부르면 다음 부팅/재실행 시 충돌 없이 깔끔하게 재초기화.
 */
function cleanup() {
  if (useMock) return;
  try {
    writeRgb(0, 0, 0);
    require('pigpio').terminate();
    log.info('RGB GPIO 자원 해제 완료 (pigpio terminated)');
  } catch (err) {
    log.error('cleanup 오류:', err.message);
  }
}

module.exports = {
  init,
  setRGB,
  setBrightness,
  setPower,
  setPreset,
  getState,
  handleControlMessage,
  cleanup,
  // routineController 가 직접 튜플 보간용으로 사용
  _writeRgb: writeRgb,
};
