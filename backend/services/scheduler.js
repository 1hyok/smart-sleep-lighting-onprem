// 수면 루틴 스케줄러.
// 매분 실행 → schedules 참조. sleep/wake 각각 next 로컬 시각·별도 last_* 로 중복 방지.

const cron = require('node-cron');
const { getDbAsync } = require('../db/db');
const { executeRoutine } = require('./lightingExecutor');

const CRON_EVERY_MIN = '* * * * *';

/** now 기준으로 해당 HH:MM 의 다음 발생 시각 (로컬). 지난 시각이면 내일로 롤 */
function nextOccurrenceOfClock(now, timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  const sod = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  let t = new Date(sod.getTime() + (h * 60 + m) * 60 * 1000);
  if (t.getTime() <= now.getTime()) {
    t = new Date(t.getTime() + 24 * 60 * 60 * 1000);
  }
  return t;
}

function scheduleWindowFired(scheduledAtDate, offsetMin) {
  const scheduledMs = scheduledAtDate.getTime();
  const windowStartMs = scheduledMs - offsetMin * 60 * 1000;
  const windowEndMs = scheduledMs;
  const nowMs = Date.now();
  return nowMs >= windowStartMs && nowMs <= windowEndMs;
}

/** 해당 예정 시각 주변에서 이미 실행했는지 여부 */
function alreadyTriggeredNear(lastTriggered, scheduledAtDate) {
  if (!lastTriggered) return false;
  const triggered = new Date(lastTriggered).getTime();
  const scheduled = scheduledAtDate.getTime();
  const windowStart = scheduled - 90 * 1000;
  const windowEnd = scheduled + 60 * 1000;
  return triggered >= windowStart && triggered <= windowEnd;
}

async function tick() {
  const db = await getDbAsync();
  const rows = db.prepare('SELECT * FROM schedules WHERE enabled = 1').all();
  if (!rows.length) return;

  const now = new Date();

  for (const sched of rows) {
    const sleepAt = nextOccurrenceOfClock(now, sched.sleep_time);
    const wakeAt = nextOccurrenceOfClock(now, sched.wake_time);

    const sleepAtIso = sleepAt.toISOString();
    const wakeAtIso = wakeAt.toISOString();

    if (
      scheduleWindowFired(sleepAt, sched.sleep_offset_min) &&
      !alreadyTriggeredNear(sched.last_sleep_triggered, sleepAt)
    ) {
      console.log(
        `[SCHEDULER] 취침 루틴 (${sched.sleep_time} 목표 ${sleepAtIso}, ${sched.sleep_offset_min}분 전 창)`,
      );
      try {
        await executeRoutine(sched.user_id, 'sleep', sleepAtIso);
        db.prepare(
          "UPDATE schedules SET last_sleep_triggered = datetime('now') WHERE id = ?",
        ).run(sched.id);
      } catch (err) {
        console.error('[SCHEDULER] 취침 루틴 실패:', err.message);
      }
    }

    if (
      scheduleWindowFired(wakeAt, sched.wake_offset_min) &&
      !alreadyTriggeredNear(sched.last_wake_triggered, wakeAt)
    ) {
      console.log(
        `[SCHEDULER] 기상 루틴 (${sched.wake_time} 목표 ${wakeAtIso}, ${sched.wake_offset_min}분 전 창)`,
      );
      try {
        await executeRoutine(sched.user_id, 'wake', wakeAtIso);
        db.prepare(
          "UPDATE schedules SET last_wake_triggered = datetime('now') WHERE id = ?",
        ).run(sched.id);
      } catch (err) {
        console.error('[SCHEDULER] 기상 루틴 실패:', err.message);
      }
    }
  }
}

let job = null;

function start() {
  if (job) return;
  job = cron.schedule(CRON_EVERY_MIN, tick, { scheduled: true });
  console.log('[SCHEDULER] 수면 루틴 스케줄러 시작 (매분 실행)');
}

function stop() {
  if (job) {
    job.stop();
    job = null;
    console.log('[SCHEDULER] 스케줄러 중지');
  }
}

module.exports = { start, stop };
