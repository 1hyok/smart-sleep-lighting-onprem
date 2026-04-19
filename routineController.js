// ──────────────────────────────────────────────
// routineController.js
//  - 취침(sleep) / 기상(wakeup) 루틴의 부드러운 전환(Fading)을 담당.
//  - RGB 3채널을 동시에 선형 보간하여 색온도 + 밝기를 함께 변환.
//     · 취침: 따뜻한 앰버(255,90,20) → 완전 소등(0,0,0)
//     · 기상: 희미한 쿨 블루(5,8,20) → 쿨 화이트(180,200,255)
//  - setInterval 기반, 한 번에 하나의 루틴만 동작 (새 트리거 시 기존 취소).
//  - 모든 시작/종료/단계/취소 이벤트는 eventLogger 로 영속화.
// ──────────────────────────────────────────────

const config = require('./config');
const lightController = require('./lightController');
const eventLogger = require('./eventLogger');
const buildLogger = require('./logger');

const log = buildLogger('routine');

let activeTimer = null;
let activeName = null;
let activeMeta = null;

function toRgb(value, fallback) {
  if (Array.isArray(value) && value.length === 3) {
    return value.map((n) => Math.max(0, Math.min(255, Math.round(Number(n) || 0))));
  }
  return fallback;
}

/**
 * 실행 중인 루틴 즉시 취소.
 */
function cancel(reason = 'manual') {
  if (!activeTimer) return false;

  clearInterval(activeTimer);
  const cancelledName = activeName;
  const cancelledMeta = activeMeta;
  activeTimer = null;
  activeName = null;
  activeMeta = null;

  log.warn(`루틴 "${cancelledName}" 취소 (이유: ${reason})`);
  eventLogger.append({
    type: 'routine_cancelled',
    name: cancelledName,
    reason,
    meta: cancelledMeta,
  });
  return true;
}

/**
 * RGB 튜플 간 선형 보간 기반 페이딩.
 * @param {object} opts
 * @param {'sleep'|'wakeup'} opts.name
 * @param {[number,number,number]} opts.from  - 시작 RGB (0~255 x3)
 * @param {[number,number,number]} opts.to    - 종료 RGB
 * @param {number} opts.durationMs
 * @param {number} opts.steps
 */
function runFade({ name, from, to, durationMs, steps }) {
  cancel(`new_routine:${name}`);

  const startedAt = new Date().toISOString();
  const intervalMs = Math.max(50, Math.floor(durationMs / steps));
  // 채널별 스텝 증분
  const delta = [
    (to[0] - from[0]) / steps,
    (to[1] - from[1]) / steps,
    (to[2] - from[2]) / steps,
  ];

  log.info(
    `▶ ${name} 루틴 시작: RGB(${from.join(',')}) → RGB(${to.join(',')}) ` +
      `(총 ${durationMs}ms, ${steps}단계, 단계당 ${intervalMs}ms)`,
  );
  eventLogger.append({
    type: 'routine_start',
    name, from, to, durationMs, steps, intervalMs, startedAt,
  });

  // 시작값 즉시 반영
  lightController._writeRgb(from[0], from[1], from[2]);

  let i = 0;
  activeName = name;
  activeMeta = { from, to, durationMs, steps, startedAt };

  activeTimer = setInterval(() => {
    i += 1;
    // 마지막 스텝은 정확히 to 로 수렴
    const rgb = i >= steps
      ? [...to]
      : [
          Math.round(from[0] + delta[0] * i),
          Math.round(from[1] + delta[1] * i),
          Math.round(from[2] + delta[2] * i),
        ];

    lightController._writeRgb(rgb[0], rgb[1], rgb[2]);
    eventLogger.append({
      type: 'routine_step',
      name,
      step: i,
      total: steps,
      rgb,
    });

    // 10% 진행마다만 INFO 로 출력 (로그 과다 방지)
    const progressPct = Math.round((i / steps) * 100);
    if (i === 1 || i === steps || progressPct % 10 === 0) {
      log.info(`  · ${name} 진행률 ${progressPct}% → RGB(${rgb.join(',')})`);
    }

    if (i >= steps) {
      clearInterval(activeTimer);
      activeTimer = null;
      activeName = null;
      activeMeta = null;

      const endedAt = new Date().toISOString();
      log.info(`✔ ${name} 루틴 완료 (${startedAt} → ${endedAt})`);
      eventLogger.append({
        type: 'routine_end',
        name,
        startedAt,
        endedAt,
        finalRgb: rgb,
      });
    }
  }, intervalMs);
}

/**
 * 취침 루틴.
 *  - 기본: 팔레트(sleepFrom) → 팔레트(sleepTo)
 *  - payload 로 `from`/`to` (RGB 배열) 오버라이드 가능.
 */
function startSleep(opts = {}) {
  runFade({
    name: 'sleep',
    from: toRgb(opts.from, config.routines.palette.sleepFrom),
    to: toRgb(opts.to, config.routines.palette.sleepTo),
    durationMs: Number(opts.duration) || config.routines.sleepDurationMs,
    steps: Number(opts.steps) || config.routines.steps,
  });
}

/**
 * 기상 루틴.
 */
function startWakeup(opts = {}) {
  runFade({
    name: 'wakeup',
    from: toRgb(opts.from, config.routines.palette.wakeupFrom),
    to: toRgb(opts.to, config.routines.palette.wakeupTo),
    durationMs: Number(opts.duration) || config.routines.wakeupDurationMs,
    steps: Number(opts.steps) || config.routines.steps,
  });
}

/**
 * MQTT 페이로드 파싱 → 해당 루틴 실행 또는 취소.
 */
function handleRoutineMessage(routine, rawPayload) {
  const text = (rawPayload && rawPayload.toString().trim()) || '';
  log.info(`[${routine}] 루틴 트리거 수신. payload="${text || '(empty)'}"`);

  if (text.toLowerCase() === 'cancel') {
    cancel('mqtt_cancel');
    return;
  }

  let opts = {};
  if (text) {
    try { opts = JSON.parse(text); }
    catch (err) { log.warn(`payload JSON 파싱 실패 → 기본값. (${err.message})`); }
  }

  if (routine === 'sleep') startSleep(opts);
  else if (routine === 'wakeup') startWakeup(opts);
  else log.warn(`알 수 없는 루틴 이름: ${routine}`);
}

function cleanup() {
  if (activeTimer) {
    clearInterval(activeTimer);
    activeTimer = null;
    activeName = null;
    activeMeta = null;
  }
}

module.exports = {
  startSleep,
  startWakeup,
  handleRoutineMessage,
  cancel,
  cleanup,
};
