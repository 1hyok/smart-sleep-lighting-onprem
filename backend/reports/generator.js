// 일일 수면 리포트 생성기.
// Fitbit 수면 세션 + 조명 루틴 실행 기록 + 조도 집계를 sleep_reports에 upsert.
//
// 집계 창:
//  - avg_illuminance_bedtime : 수면 시작 30분 전 ~ 수면 시작 시각
//  - avg_illuminance_wakeup  : 수면 종료 15분 전 ~ 수면 종료 15분 후

const { getDbAsync, persist } = require('../db/db');

function avgIlluminance(db, startIso, endIso) {
  const row = db.prepare(`
    SELECT AVG(value) AS avg_lux
    FROM illuminance_readings
    WHERE source = 'sensor'
      AND recorded_at >= ?
      AND recorded_at <= ?
  `).get(startIso, endIso);
  return row?.avg_lux ?? null;
}

function shiftMs(isoStr, deltaMs) {
  return new Date(new Date(isoStr).getTime() + deltaMs).toISOString();
}

// date: 'YYYY-MM-DD'
async function generateReport(userId, date) {
  const db = await getDbAsync();

  const session = db.prepare(`
    SELECT * FROM sleep_sessions
    WHERE user_id = ? AND date = ? AND is_main_sleep = 1
    ORDER BY duration_ms DESC
    LIMIT 1
  `).get(userId, date);

  let avgBedtime = null;
  let avgWakeup  = null;

  if (session) {
    // startTime은 Fitbit 로컬 시각 문자열("2026-04-26T23:00:00.000")
    // illuminance_readings.recorded_at은 ISO 8601 UTC
    // MVP에서는 RPi와 Fitbit이 같은 시간대(KST)라고 가정하고 직접 비교.
    avgBedtime = avgIlluminance(
      db,
      shiftMs(session.start_time, -30 * 60 * 1000),
      session.start_time,
    );
    avgWakeup = avgIlluminance(
      db,
      shiftMs(session.end_time, -15 * 60 * 1000),
      shiftMs(session.end_time,  15 * 60 * 1000),
    );
  }

  // 해당 날짜의 sleep / wake 루틴 실행 기록
  const sleepRoutine = db.prepare(`
    SELECT id FROM lighting_routines
    WHERE user_id = ? AND routine_type = 'sleep'
      AND DATE(scheduled_at) = ?
    ORDER BY scheduled_at DESC LIMIT 1
  `).get(userId, date);

  const wakeRoutine = db.prepare(`
    SELECT id FROM lighting_routines
    WHERE user_id = ? AND routine_type = 'wake'
      AND DATE(scheduled_at) = ?
    ORDER BY scheduled_at DESC LIMIT 1
  `).get(userId, date);

  db.prepare(`
    INSERT INTO sleep_reports
      (user_id, report_date, sleep_session_id, sleep_routine_id, wake_routine_id,
       avg_illuminance_bedtime, avg_illuminance_wakeup)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, report_date) DO UPDATE SET
      sleep_session_id        = excluded.sleep_session_id,
      sleep_routine_id        = excluded.sleep_routine_id,
      wake_routine_id         = excluded.wake_routine_id,
      avg_illuminance_bedtime = excluded.avg_illuminance_bedtime,
      avg_illuminance_wakeup  = excluded.avg_illuminance_wakeup,
      generated_at            = datetime('now')
  `  ).run(
    userId,
    date,
    session?.id ?? null,
    sleepRoutine?.id ?? null,
    wakeRoutine?.id ?? null,
    avgBedtime,
    avgWakeup,
  );

  persist();

  console.log(
    `[REPORT] ${date} 리포트 생성 완료` +
    (session
      ? ` (수면 ${session.minutes_asleep}분, 효율 ${session.efficiency}%)`
      : ' (수면 데이터 없음)'),
  );
}

module.exports = { generateReport };
