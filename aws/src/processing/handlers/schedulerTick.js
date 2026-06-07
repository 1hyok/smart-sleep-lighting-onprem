'use strict';

const config = require('../lib/config');
const { scan, updateItem } = require('../lib/dynamodb');
const { triggerRoutineAsync } = require('../lib/routines');

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
  const nowMs = Date.now();
  return nowMs >= windowStartMs && nowMs <= scheduledMs;
}

function alreadyTriggeredNear(lastTriggered, scheduledAtDate) {
  if (!lastTriggered) return false;
  const triggered = new Date(lastTriggered).getTime();
  const scheduled = scheduledAtDate.getTime();
  return triggered >= scheduled - 90 * 1000 && triggered <= scheduled + 60 * 1000;
}

exports.handler = async () => {
  const rows = await scan(config.schedulesTable);
  const enabled = rows.filter((r) => r.enabled === 1 || r.enabled === true);
  const now = new Date();
  const triggered = [];

  for (const sched of enabled) {
    const sleepAt = nextOccurrenceOfClock(now, sched.sleep_time);
    const wakeAt = nextOccurrenceOfClock(now, sched.wake_time);

    if (
      scheduleWindowFired(sleepAt, sched.sleep_offset_min ?? 30)
      && !alreadyTriggeredNear(sched.last_sleep_triggered, sleepAt)
    ) {
      try {
        await triggerRoutineAsync(sched.user_id, 'sleep', sleepAt.toISOString());
        await updateItem(
          config.schedulesTable,
          { user_id: sched.user_id },
          'SET last_sleep_triggered = :t',
          undefined,
          { ':t': new Date().toISOString() },
        );
        triggered.push({ userId: sched.user_id, type: 'sleep' });
      } catch (err) {
        console.error('[SCHEDULER] 취침 루틴 실패:', err.message);
      }
    }

    if (
      scheduleWindowFired(wakeAt, sched.wake_offset_min ?? 15)
      && !alreadyTriggeredNear(sched.last_wake_triggered, wakeAt)
    ) {
      try {
        await triggerRoutineAsync(sched.user_id, 'wake', wakeAt.toISOString());
        await updateItem(
          config.schedulesTable,
          { user_id: sched.user_id },
          'SET last_wake_triggered = :t',
          undefined,
          { ':t': new Date().toISOString() },
        );
        triggered.push({ userId: sched.user_id, type: 'wake' });
      } catch (err) {
        console.error('[SCHEDULER] 기상 루틴 실패:', err.message);
      }
    }
  }

  return { checked: enabled.length, triggered };
};
