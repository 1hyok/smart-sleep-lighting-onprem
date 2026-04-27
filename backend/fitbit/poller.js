// Fitbit 수면 데이터 일별 동기화.
// 기동 시 전날 데이터를 즉시 한 번 fetch하고, 이후 cron 스케줄로 반복.

const cron = require('node-cron');
const config = require('../config');
const { getDb } = require('../db/db');
const { getSleepByDate } = require('./client');
const mockData = require('./mockData');
const { generateReport } = require('../reports/generator');

function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

const insertSession = () =>
  getDb().prepare(`
    INSERT INTO sleep_sessions
      (user_id, fitbit_log_id, date, start_time, end_time, duration_ms,
       minutes_asleep, minutes_awake, time_in_bed, efficiency, is_main_sleep, sleep_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(fitbit_log_id) DO UPDATE SET
      minutes_asleep = excluded.minutes_asleep,
      minutes_awake  = excluded.minutes_awake,
      efficiency     = excluded.efficiency,
      fetched_at     = datetime('now')
  `);

const insertStage = () =>
  getDb().prepare(`
    INSERT INTO sleep_stages (session_id, stage, minutes, count, thirty_day_avg_minutes)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_id, stage) DO UPDATE SET
      minutes                = excluded.minutes,
      count                  = excluded.count,
      thirty_day_avg_minutes = excluded.thirty_day_avg_minutes
  `);

function persistSleepData(userId, data) {
  const db = getDb();
  const stmtSession = insertSession();
  const stmtStage   = insertStage();

  const sync = db.transaction(() => {
    for (const s of data.sleep) {
      stmtSession.run(
        userId,
        String(s.logId),
        s.dateOfSleep,
        s.startTime,
        s.endTime,
        s.duration,
        s.minutesAsleep,
        s.minutesAwake,
        s.timeInBed,
        s.efficiency,
        s.isMainSleep ? 1 : 0,
        s.type ?? null,
      );

      const row = db
        .prepare('SELECT id FROM sleep_sessions WHERE fitbit_log_id = ?')
        .get(String(s.logId));

      const summary = s.levels?.summary ?? {};
      for (const [stage, info] of Object.entries(summary)) {
        stmtStage.run(
          row.id,
          stage,
          info.minutes,
          info.count ?? null,
          info.thirtyDayAvgMinutes ?? null,
        );
      }
    }
  });

  sync();
}

async function syncDate(userId, date) {
  console.log(`[FITBIT] 수면 데이터 동기화 시작: ${date}`);

  let data;
  if (config.fitbit.mock) {
    data = mockData.sleepForDate(date);
    console.log(`[FITBIT] Mock 데이터 사용 (${date})`);
  } else {
    data = await getSleepByDate(userId, date);
  }

  if (!data.sleep?.length) {
    console.log(`[FITBIT] ${date} 수면 기록 없음`);
    return;
  }

  persistSleepData(userId, data);
  console.log(`[FITBIT] ${date} 동기화 완료 (${data.sleep.length}건)`);

  // 수면 데이터 저장 직후 일일 리포트 생성
  generateReport(userId, date);
}

async function runDailySync(userId) {
  try {
    await syncDate(userId, yesterday());
  } catch (err) {
    console.error('[FITBIT] 동기화 실패:', err.message);
  }
}

function startPoller(userId) {
  console.log(`[FITBIT] 폴러 시작 (cron: ${config.fitbit.pollCron})`);

  // 기동 즉시 1회 실행 (재시작 후 누락 데이터 복구)
  runDailySync(userId);

  cron.schedule(config.fitbit.pollCron, () => runDailySync(userId));
}

module.exports = { startPoller, syncDate };
