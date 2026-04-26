// ──────────────────────────────────────────────
// scheduler.js
//  - 시간 기반 폴백 자동 스케줄러.
//  - 외부 서버(Fitbit 데이터 분석 등) 와 무관하게 엣지 단독으로도
//    설정된 취침/기상 시각에 루틴이 발동되도록 보장.
//  - .env: SCHEDULE_SLEEP=23:30, SCHEDULE_WAKEUP=07:00 (HH:MM, 24h)
//  - 매 발동 후 다음 날 동일 시각으로 재예약.
// ──────────────────────────────────────────────

const routineController = require('./routineController');
const eventLogger = require('./eventLogger');
const buildLogger = require('./logger');

const log = buildLogger('scheduler');

/**
 * "HH:MM" 문자열 파싱. 잘못된 형식이면 null.
 */
function parseHHMM(s) {
  if (!s || !/^\d{1,2}:\d{2}$/.test(s)) return null;
  const [h, m] = s.split(':').map(Number);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { h, m };
}

/**
 * 다음 발동 시각까지의 ms. 이미 지난 시각이면 익일로 산정.
 */
function nextFireDelayMs(target) {
  const now = new Date();
  const fire = new Date(now);
  fire.setHours(target.h, target.m, 0, 0);
  if (fire <= now) fire.setDate(fire.getDate() + 1);
  return fire - now;
}

/**
 * 단일 스케줄 등록 + 발동 후 자동 재예약.
 */
function arm(name, hhmm, runFn) {
  const target = parseHHMM(hhmm);
  if (!target) {
    log.warn(`스케줄 미설정 또는 형식 오류: ${name} (값="${hhmm}")`);
    return;
  }
  const delay = nextFireDelayMs(target);
  log.info(
    `${name} 다음 실행 예약: ${hhmm} (${Math.round(delay / 60000)}분 후)`,
  );
  setTimeout(() => {
    log.info(`⏰ 스케줄 발동: ${name}`);
    eventLogger.append({
      type: 'schedule_fired',
      name,
      scheduledAt: hhmm,
    });
    try {
      runFn();
    } catch (err) {
      log.error(`스케줄 실행 실패 (${name}): ${err.message}`);
      eventLogger.append({
        type: 'schedule_error',
        name,
        message: err.message,
      });
    }
    arm(name, hhmm, runFn); // 익일 재예약
  }, delay);
}

/**
 * 모든 스케줄 활성화. index.js 의 bootstrap() 에서 1회 호출.
 */
function start() {
  arm('sleep', process.env.SCHEDULE_SLEEP, () => routineController.startSleep());
  arm('wakeup', process.env.SCHEDULE_WAKEUP, () => routineController.startWakeup());
}

module.exports = { start };
