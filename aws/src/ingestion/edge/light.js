// ──────────────────────────────────────────────
// light.js — 엣지 조명 actuation (GPIO PWM)
//  - spec §5: 조명 명령은 클라우드 Lambda 가 Device Shadow desired 로 내리고,
//    실제 실행은 엣지 로컬에서 한다(연결이 끊겨도 재접속 시 마지막 desired 동기화).
//  - 온프렘 backend/gpio/light.js(PWM 제어) + services/lightingExecutor.js(SLEEP/WAKE
//    단계 테이블)를 엣지로 이전·통합한 모듈.
//  - RPi + pigpio 설치 시에만 실제 PWM, 그 외(PC/클라우드)에서는 mock 로깅.
//  - 담당: 정일혁
// ──────────────────────────────────────────────

const fs = require('fs');
const config = require('./config');
const buildLogger = require('./logger');
const log = buildLogger('light');

const PWM_GPIO = config.lighting.pwmGpio; // BCM 18 — 하드웨어 PWM 가능 핀
const TIME_SCALE = config.lighting.timeScale; // 데모용 시간 압축 (1=실시간)

let isMock = true;
let led = null;
let currentBrightness = 0;
let routineToken = 0; // 새 루틴 수신 시 진행 중 루틴을 취소하기 위한 토큰

if (fs.existsSync('/dev/gpiomem')) {
  try {
    const Gpio = require('pigpio').Gpio;
    led = new Gpio(PWM_GPIO, { mode: Gpio.OUTPUT });
    isMock = false;
    log.info(`pigpio 초기화 — BCM ${PWM_GPIO} pwmWrite(0–255)`);
  } catch (err) {
    log.warn(`pigpio 로드 실패 — GPIO mock 모드: ${err.message}`);
    isMock = true;
  }
} else {
  log.info('RPi 아님 — GPIO mock 모드 (PC/클라우드)');
}

// 단계 테이블 (온프렘 lightingExecutor.js 와 동일 타이밍).
//  SLEEP: 80→60→40→20→0 (~30분), WAKE: 20→50→80→100 (~15분).
const SLEEP_STEPS = [
  { brightness: 80, delayMs: 10 * 60 * 1000 },
  { brightness: 60, delayMs: 10 * 60 * 1000 },
  { brightness: 40, delayMs: 5 * 60 * 1000 },
  { brightness: 20, delayMs: 3 * 60 * 1000 },
  { brightness: 0, delayMs: 2 * 60 * 1000 },
];
const WAKE_STEPS = [
  { brightness: 20, delayMs: 3 * 60 * 1000 },
  { brightness: 50, delayMs: 4 * 60 * 1000 },
  { brightness: 80, delayMs: 4 * 60 * 1000 },
  { brightness: 100, delayMs: 4 * 60 * 1000 },
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 밝기(0~100%) → PWM 듀티(0~255).
function brightnessToPwm(brightness) {
  return Math.round((Math.max(0, Math.min(100, brightness)) / 100) * 255);
}

function setBrightness(brightness) {
  const pct = Math.max(0, Math.min(100, Math.round(brightness)));
  currentBrightness = pct;
  const pwm = brightnessToPwm(pct);
  if (isMock || !led) {
    log.info(`[GPIO-MOCK] brightness=${pct}% (pwm=${pwm})`);
    return;
  }
  try {
    led.pwmWrite(pwm);
  } catch (err) {
    log.error('pwmWrite 오류:', err.message);
  }
}

/**
 * 조명 루틴 실행. SLEEP/WAKE 단계를 순차 적용.
 *  - 진행 중 새 루틴/명령이 오면 routineToken 으로 기존 루틴을 취소(중복 제어 방지).
 *  - TIME_SCALE 로 데모 시 시간 압축(예: LIGHTING_TIME_SCALE=0.01 → 약 100배 빠름).
 * @param {'sleep'|'wake'} type
 * @param {Array<{brightness:number, delayMs:number}>} [customSteps]
 */
async function runRoutine(type, customSteps) {
  const steps = customSteps || (type === 'wake' ? WAKE_STEPS : SLEEP_STEPS);
  const myToken = ++routineToken;
  log.info(`조명 루틴 시작: ${type} (${steps.length}단계, time_scale=${TIME_SCALE})`);

  for (let i = 0; i < steps.length; i++) {
    if (myToken !== routineToken) {
      log.warn(`조명 루틴 취소: ${type} (새 명령 수신)`);
      return { type, state: 'cancelled', brightness: currentBrightness };
    }
    setBrightness(steps[i].brightness);
    log.info(`${type} step ${i + 1}/${steps.length}: brightness=${steps[i].brightness}%`);
    if (i < steps.length - 1) await sleep(Math.round(steps[i].delayMs * TIME_SCALE));
  }
  log.info(`조명 루틴 완료: ${type}`);
  return { type, state: 'completed', brightness: currentBrightness };
}

function getCurrentBrightness() {
  return currentBrightness;
}

function cleanup() {
  routineToken += 1; // 진행 중 루틴 취소
  if (led) {
    try {
      led.pwmWrite(0);
    } catch {}
    led = null;
  }
}

module.exports = {
  setBrightness,
  runRoutine,
  getCurrentBrightness,
  brightnessToPwm,
  cleanup,
  isMock,
  SLEEP_STEPS,
  WAKE_STEPS,
};
