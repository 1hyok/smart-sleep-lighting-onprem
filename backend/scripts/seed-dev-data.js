// backend/scripts/seed-dev-data.js
//
// 개발/UI 검증용 가짜 데이터 시딩 스크립트.
// - 최근 N일 sleep_sessions + sleep_stages
// - 최근 24시간 illuminance_readings (source='sensor')
// - 매일 sleep/wake lighting_routines (성공 처리)
// - 위 데이터를 묶은 sleep_reports
//
// 사용법:
//   cd backend
//   node scripts/seed-dev-data.js          # 최근 14일 시딩 (기본)
//   node scripts/seed-dev-data.js --days 7 # 최근 7일
//   node scripts/seed-dev-data.js --reset  # 시딩 전 기존 dev 데이터 삭제
//
// 주의:
//   - 이 스크립트는 user_id=1(default) 에 데이터를 삽입합니다.
//   - 기존 fitbit_log_id 충돌은 'dev-seed-' prefix로 회피합니다.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { getDbAsync, persist } = require('../db/db');

const args = process.argv.slice(2);
const DAYS = parseIntArg('--days', 14);
const RESET = args.includes('--reset');
const USER_ID = 1;
const DEVICE_ID = 'rpi-edge-bedroom-01';

function parseIntArg(flag, fallback) {
  const idx = args.indexOf(flag);
  if (idx === -1) return fallback;
  const value = parseInt(args[idx + 1], 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function isoLocal(d) {
  // 'YYYY-MM-DDTHH:mm:ss.sss' (Fitbit 로컬 시각 형식)
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

function isoUtc(d) {
  return d.toISOString();
}

function dateOnly(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function jitter(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

// ── 데이터 생성 ───────────────────────────────────────────────────────────────

function buildSleepRow(targetDate) {
  // targetDate 의 전날 23:00 ± 30분 취침 → 당일 07:00 ± 20분 기상
  const start = new Date(targetDate);
  start.setDate(start.getDate() - 1);
  start.setHours(23, jitter(-30, 30), 0, 0);

  const end = new Date(targetDate);
  end.setHours(7, jitter(-20, 20), 0, 0);

  const durationMs = end.getTime() - start.getTime();
  const totalMin = Math.round(durationMs / 60_000);
  const wake = Math.floor(totalMin * 0.06);
  const deep = Math.floor(totalMin * 0.20);
  const rem = Math.floor(totalMin * 0.22);
  const light = totalMin - deep - rem - wake;
  const efficiency = 86 + Math.floor(Math.random() * 10);

  return {
    fitbit_log_id: `dev-seed-${dateOnly(targetDate)}`,
    date: dateOnly(targetDate),
    start_time: isoLocal(start),
    end_time: isoLocal(end),
    duration_ms: durationMs,
    minutes_asleep: totalMin - wake,
    minutes_awake: wake,
    time_in_bed: totalMin,
    efficiency,
    is_main_sleep: 1,
    sleep_type: 'stages',
    stages: { deep, light, rem, wake },
    bedStart: start,
    wakeEnd: end,
  };
}

function buildIlluminanceSeries(now) {
  // 직전 24시간, 5분 간격 sample
  const points = [];
  const step = 5 * 60 * 1000;
  for (let t = now.getTime() - 24 * 3600 * 1000; t <= now.getTime(); t += step) {
    const d = new Date(t);
    const hour = d.getHours() + d.getMinutes() / 60;
    // 낮(8~18시) 200~600 lux, 밤 0~30 lux 정도
    let base;
    if (hour >= 7 && hour <= 19) {
      const peak = 12;
      const dist = Math.abs(hour - peak);
      base = Math.max(50, 600 - dist * 60);
    } else {
      base = 5 + Math.random() * 25;
    }
    const noise = (Math.random() - 0.5) * 30;
    points.push({
      device_id: DEVICE_ID,
      value: Math.max(0, +(base + noise).toFixed(1)),
      raw: Math.floor(Math.random() * 256),
      source: 'sensor',
      recorded_at: isoUtc(d),
    });
  }
  return points;
}

// ── 메인 ─────────────────────────────────────────────────────────────────────

async function main() {
  const db = await getDbAsync();
  console.log(`[SEED] user_id=${USER_ID}, days=${DAYS}, reset=${RESET}`);

  if (RESET) {
    const deleted = {
      reports: db.prepare("DELETE FROM sleep_reports WHERE user_id = ?").run(USER_ID).changes,
      stages: db.prepare(
        "DELETE FROM sleep_stages WHERE session_id IN (SELECT id FROM sleep_sessions WHERE fitbit_log_id LIKE 'dev-seed-%')"
      ).run().changes,
      sessions: db.prepare("DELETE FROM sleep_sessions WHERE fitbit_log_id LIKE 'dev-seed-%'").run().changes,
      routines: db.prepare("DELETE FROM lighting_routines WHERE notes = 'dev-seed'").run().changes,
      illuminance: db.prepare("DELETE FROM illuminance_readings WHERE device_id = ?").run(DEVICE_ID).changes,
    };
    console.log("[SEED] reset:", deleted);
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // 1) sleep_sessions + sleep_stages
  let sessionCount = 0;
  let routineCount = 0;
  let reportCount = 0;
  for (let i = 0; i < DAYS; i++) {
    const target = new Date(today);
    target.setDate(target.getDate() - i);
    const row = buildSleepRow(target);

    const sessionRes = db.prepare(`
      INSERT INTO sleep_sessions
        (user_id, fitbit_log_id, date, start_time, end_time, duration_ms,
         minutes_asleep, minutes_awake, time_in_bed, efficiency, is_main_sleep, sleep_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(fitbit_log_id) DO UPDATE SET
        minutes_asleep = excluded.minutes_asleep,
        efficiency = excluded.efficiency,
        fetched_at = datetime('now')
    `).run(
      USER_ID, row.fitbit_log_id, row.date, row.start_time, row.end_time, row.duration_ms,
      row.minutes_asleep, row.minutes_awake, row.time_in_bed, row.efficiency,
      row.is_main_sleep, row.sleep_type,
    );

    // 신규 INSERT가 아닐 수도 있으니 fitbit_log_id로 다시 조회
    const session = db.prepare("SELECT id FROM sleep_sessions WHERE fitbit_log_id = ?")
      .get(row.fitbit_log_id);

    for (const [stage, minutes] of Object.entries(row.stages)) {
      db.prepare(`
        INSERT INTO sleep_stages (session_id, stage, minutes, count, thirty_day_avg_minutes)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id, stage) DO UPDATE SET
          minutes = excluded.minutes,
          count = excluded.count,
          thirty_day_avg_minutes = excluded.thirty_day_avg_minutes
      `).run(session.id, stage, minutes, 5, minutes - 2);
    }
    sessionCount++;
    sessionRes.changes; // suppress unused

    // 2) lighting_routines (sleep + wake)
    const sleepRoutineRes = db.prepare(`
      INSERT INTO lighting_routines
        (user_id, routine_type, scheduled_at, started_at, completed_at, success, notes)
      VALUES (?, 'sleep', ?, ?, ?, 1, 'dev-seed')
    `).run(
      USER_ID,
      isoLocal(new Date(row.bedStart.getTime() - 30 * 60 * 1000)),
      isoLocal(new Date(row.bedStart.getTime() - 30 * 60 * 1000)),
      isoLocal(row.bedStart),
    );
    const wakeRoutineRes = db.prepare(`
      INSERT INTO lighting_routines
        (user_id, routine_type, scheduled_at, started_at, completed_at, success, notes)
      VALUES (?, 'wake', ?, ?, ?, 1, 'dev-seed')
    `).run(
      USER_ID,
      isoLocal(new Date(row.wakeEnd.getTime() - 15 * 60 * 1000)),
      isoLocal(new Date(row.wakeEnd.getTime() - 15 * 60 * 1000)),
      isoLocal(row.wakeEnd),
    );
    routineCount += 2;

    // 3) sleep_reports
    db.prepare(`
      INSERT INTO sleep_reports
        (user_id, report_date, sleep_session_id, sleep_routine_id, wake_routine_id,
         avg_illuminance_bedtime, avg_illuminance_wakeup)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, report_date) DO UPDATE SET
        sleep_session_id = excluded.sleep_session_id,
        sleep_routine_id = excluded.sleep_routine_id,
        wake_routine_id = excluded.wake_routine_id,
        avg_illuminance_bedtime = excluded.avg_illuminance_bedtime,
        avg_illuminance_wakeup = excluded.avg_illuminance_wakeup,
        generated_at = datetime('now')
    `).run(
      USER_ID,
      row.date,
      session.id,
      sleepRoutineRes.lastInsertRowid,
      wakeRoutineRes.lastInsertRowid,
      +(20 + Math.random() * 30).toFixed(1),
      +(280 + Math.random() * 80).toFixed(1),
    );
    reportCount++;
  }

  // 4) illuminance_readings (최근 24시간)
  const now = new Date();
  const points = buildIlluminanceSeries(now);
  const stmt = db.prepare(`
    INSERT INTO illuminance_readings (device_id, value, raw, source, recorded_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const p of points) {
    stmt.run(p.device_id, p.value, p.raw, p.source, p.recorded_at);
  }

  persist();

  console.log(`[SEED] sleep_sessions: ${sessionCount}건`);
  console.log(`[SEED] lighting_routines: ${routineCount}건`);
  console.log(`[SEED] sleep_reports: ${reportCount}건`);
  console.log(`[SEED] illuminance_readings: ${points.length}건`);
  console.log("[SEED] 완료. 백엔드를 재시작하지 않아도 즉시 조회됩니다.");
}

main().catch((err) => {
  console.error("[SEED] 실패:", err);
  process.exit(1);
});
