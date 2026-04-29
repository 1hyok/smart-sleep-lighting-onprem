// GPIO PWM 제어 (npm pigpio Gpio.pwmWrite, 듀티 0–255).
// RPi/Linux + pigpio 설치 시에만 실제 PWM — 그 외 mock.

const fs = require('fs');

let isMock = true;
let led = null;
const PWM_GPIO = 18; // BCM 18 — 하드웨어 PWM 가능 핀 (보드별 확인)

if (fs.existsSync('/dev/gpiomem')) {
  try {
    const Gpio = require('pigpio').Gpio;
    led = new Gpio(PWM_GPIO, { mode: Gpio.OUTPUT });
    isMock = false;
    console.log('[GPIO] pigpio 초기화 — BCM %d pwmWrite(0–255)', PWM_GPIO);
  } catch (err) {
    console.warn(`[GPIO] pigpio 로드 실패 — mock 모드: ${err.message}`);
    isMock = true;
  }
} else {
  console.log('[GPIO] RPi 아님 — mock 모드 (Windows/클라우드)');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function brightnessToPwm(brightness) {
  return Math.round((Math.max(0, Math.min(100, brightness)) / 100) * 255);
}

function setBrightnessSync(brightness) {
  const pwm = brightnessToPwm(brightness);
  if (isMock || !led) {
    console.log(`[GPIO-MOCK] brightness=${brightness}% (pwm=${pwm})`);
    return;
  }
  try {
    led.pwmWrite(pwm);
  } catch (err) {
    console.error('[GPIO] pwmWrite 오류:', err.message);
  }
}

// gradual=true: 1초 간 10단계 fade (PWM 단계 보간)
async function setBrightness(brightness, gradual = false) {
  const pct = Math.max(0, Math.min(100, Math.round(brightness)));

  if (!gradual) {
    setBrightnessSync(pct);
    return;
  }

  const steps = 10;
  const intervalMs = 1000 / steps;
  const start = pct === 0 ? 100 : 0;
  const end = pct;
  for (let i = 1; i <= steps; i++) {
    const val = Math.round(start + (end - start) * (i / steps));
    setBrightnessSync(val);
    await sleep(intervalMs);
  }
}

function cleanup() {
  if (led) {
    try {
      led.pwmWrite(0);
    } catch {}
    led = null;
  }
}

module.exports = { setBrightness, setBrightnessSync, cleanup, isMock };
