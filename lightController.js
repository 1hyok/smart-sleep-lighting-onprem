// ──────────────────────────────────────────────
// lightController.js
//  - 백엔드의 조명 제어 명령(MQTT)을 수신해 RPi GPIO 의 LED 를
//    PWM 으로 점진(Fade) 제어.
//  - pigpio C 라이브러리 미설치(macOS 등 PC 개발) 또는 MOCK_LIGHT=true
//    인 경우 mock 폴백 → 듀티값을 로그로만 출력. (sensor.js 의 i2c-bus
//    폴백 패턴과 동일.)
//  - 책임 (스켈레톤):
//     · level(0..100) → 듀티(0..255) 변환
//     · setBrightness(level, durationMs) — durationMs 동안 부드러운 페이드
//     · 진행 중 페이드가 있으면 취소하고 새 명령 우선 (timer 누수 방지)
//     · cleanup() — 종료 시 LED 소등 + 인터벌 해제
// ──────────────────────────────────────────────

const config = require('./config');
const buildLogger = require('./logger');
const log = buildLogger('light');

// pigpio 가용성 검사.
//  - pigpio 모듈이 설치되지 않았거나, libpigpio 가 없어 native 바인딩 로드가
//    실패해도 require 자체에서 예외가 떨어짐 → mock 폴백.
//  - new Gpio() 가 실패하는 경우(예: pigpiod 미실행, sudo 권한 부족)도 동일.
let led = null;
let useMock = config.light.mock;

if (!useMock) {
  try {
    const { Gpio } = require('pigpio');
    led = new Gpio(config.light.pin, { mode: Gpio.OUTPUT });
    led.pwmWrite(0); // 초기 상태: 소등
    log.info(
      `[LIGHT] ✅ pigpio 초기화 완료 — GPIO=${config.light.pin}, 초기 듀티=0`,
    );
  } catch (err) {
    log.warn(
      `[WARNING] ⚠️  pigpio 초기화 실패 → MOCK 모드로 전환합니다: ${err.message}`,
    );
    useMock = true;
    led = null;
  }
}

// 페이드 파라미터
//  - FADE_TICK_MS: 듀티 업데이트 주기. 50ms ≈ 20Hz → 시각적으로 충분히 부드러움.
//    더 낮추면 RPi CPU 부하만 증가하고 인지 향상 없음.
const FADE_TICK_MS = 50;

let currentDuty = 0; // 0..255 (pigpio.pwmWrite 범위)
let fadeInterval = null; // 진행 중인 페이드 인터벌 핸들

/**
 * level(0..100) → PWM 듀티(0..255).
 *  - 인간 시각은 비선형(웨버-페히너)이라 균등 매핑 시 어두운 구간 변화가
 *    크게 느껴짐. 추후 감마 보정(level^2.2) 으로 교체 가능.
 */
function levelToDuty(level) {
  const safe = Math.max(0, Math.min(100, Number(level) || 0));
  return Math.round((safe / 100) * 255);
}

function writeDuty(duty) {
  const clamped = Math.max(0, Math.min(255, Math.round(duty)));
  currentDuty = clamped;
  if (useMock) {
    log.debug(`[LIGHT][MOCK] duty=${clamped}`);
    return;
  }
  led.pwmWrite(clamped);
}

/**
 * 점진(Fade) 밝기 제어.
 *  - level: 0~100 (%)
 *  - durationMs: 페이드 소요 시간. 0/음수면 즉시 점프.
 *  - 진행 중 페이드가 있으면 취소하고 현재 듀티에서 새 타겟까지 다시 페이드.
 *    (timer 중첩 누수 + LED 깜빡임 방지)
 */
function setBrightness(level, durationMs = 0) {
  if (fadeInterval) {
    clearInterval(fadeInterval);
    fadeInterval = null;
  }

  const targetDuty = levelToDuty(level);

  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    writeDuty(targetDuty);
    log.info(`[LIGHT] 즉시 변경: level=${level}% (duty ${currentDuty})`);
    return;
  }

  const startDuty = currentDuty;
  const startTime = Date.now();
  log.info(
    `[LIGHT] 페이드 시작: duty ${startDuty} → ${targetDuty} ` +
      `over ${durationMs}ms (level=${level}%)`,
  );

  fadeInterval = setInterval(() => {
    const elapsed = Date.now() - startTime;
    const t = Math.min(1, elapsed / durationMs);
    const duty = startDuty + (targetDuty - startDuty) * t;
    writeDuty(duty);
    if (t >= 1) {
      clearInterval(fadeInterval);
      fadeInterval = null;
      log.info(`[LIGHT] 페이드 완료: duty=${currentDuty}`);
    }
  }, FADE_TICK_MS);
}

/**
 * 현재 LED 상태 스냅샷 (디버깅/추후 state echo 용).
 */
function getState() {
  return {
    duty: currentDuty,
    level: Math.round((currentDuty / 255) * 100),
    fading: fadeInterval !== null,
    source: useMock ? 'mock' : 'pigpio',
  };
}

/**
 * 종료 시 자원 해제.
 *  - 진행 중 페이드 인터벌 정리
 *  - LED 소등 (잔상 방지)
 *  - pigpio 핸들은 프로세스 종료와 함께 OS 가 회수.
 */
function cleanup() {
  if (fadeInterval) {
    clearInterval(fadeInterval);
    fadeInterval = null;
  }
  if (!led) return;
  try {
    led.pwmWrite(0);
    currentDuty = 0;
    log.info('[LIGHT] LED 소등 후 자원 해제 완료');
  } catch (err) {
    log.warn(`[LIGHT] cleanup 오류: ${err.message}`);
  }
}

module.exports = { setBrightness, getState, cleanup };
