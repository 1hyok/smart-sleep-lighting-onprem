'use strict';

const config = require('../lib/config');
const { scan, putItem } = require('../lib/dynamodb');
const { getSleepByDate, yesterdayUtcDate } = require('../lib/fitbit');

async function persistSleepData(userId, data) {
  for (const s of data.sleep ?? []) {
    const logId = String(s.logId);
    const sk = `${s.dateOfSleep}#${logId}`;

    await putItem(config.sessionsTable, {
      user_id: userId,
      sk,
      fitbit_log_id: logId,
      date: s.dateOfSleep,
      start_time: s.startTime,
      end_time: s.endTime,
      duration_ms: s.duration,
      minutes_asleep: s.minutesAsleep,
      minutes_awake: s.minutesAwake,
      time_in_bed: s.timeInBed,
      efficiency: s.efficiency,
      is_main_sleep: s.isMainSleep ? 1 : 0,
      sleep_type: s.type ?? null,
      fetched_at: new Date().toISOString(),
    });

    const summary = s.levels?.summary ?? {};
    for (const [stage, info] of Object.entries(summary)) {
      await putItem(config.stagesTable, {
        session_id: logId,
        stage,
        minutes: info.minutes,
        count: info.count ?? null,
        thirty_day_avg_minutes: info.thirtyDayAvgMinutes ?? null,
      });
    }
  }
}

async function syncDate(userId, date) {
  console.log(`[FITBIT] 동기화 시작 user=${userId} date=${date}`);
  const data = await getSleepByDate(userId, date);

  if (!data.sleep?.length) {
    console.log(`[FITBIT] ${date} 수면 기록 없음`);
    return;
  }

  await persistSleepData(userId, data);
  console.log(`[FITBIT] ${date} 동기화 완료 (${data.sleep.length}건)`);
}

exports.handler = async () => {
  const date = yesterdayUtcDate();
  const users = await scan(config.tokensMetaTable);

  if (!users.length) {
    console.log('[FITBIT] 대상 사용자 없음');
    return { synced: 0, date };
  }

  const results = [];
  for (const meta of users) {
    try {
      await syncDate(meta.user_id, date);
      results.push({ userId: meta.user_id, ok: true });
    } catch (err) {
      console.error(`[FITBIT] user=${meta.user_id} 실패:`, err.message);
      results.push({ userId: meta.user_id, ok: false, error: err.message });
    }
  }

  return { date, results };
};
