'use strict';

const config = require('./config');
const { query, putItem } = require('./dynamodb');
const { fitbitLocalToUtc, shiftIsoUtc } = require('./tz');

async function avgIlluminance(deviceId, startIso, endIso) {
  const rows = await query(config.illuminTable, {
    KeyConditionExpression: 'device_id = :d AND recorded_at BETWEEN :s AND :e',
    FilterExpression: '#src = :sensor',
    ExpressionAttributeNames: { '#src': 'source' },
    ExpressionAttributeValues: {
      ':d': deviceId,
      ':s': startIso,
      ':e': endIso,
      ':sensor': 'sensor',
    },
  });

  if (!rows.length) return null;
  const sum = rows.reduce((acc, r) => acc + Number(r.value), 0);
  return sum / rows.length;
}

async function findRoutinesForDate(userId, date, routineType) {
  const dayStart = `${date}T00:00:00.000Z`;
  const dayEnd = `${date}T23:59:59.999Z`;
  const rows = await query(config.routinesTable, {
    IndexName: 'by-user-date',
    KeyConditionExpression: 'user_id = :u AND scheduled_at BETWEEN :s AND :e',
    FilterExpression: 'routine_type = :t',
    ExpressionAttributeValues: {
      ':u': userId,
      ':s': dayStart,
      ':e': dayEnd,
      ':t': routineType,
    },
    ScanIndexForward: false,
    Limit: 1,
  });
  return rows[0]?.routine_id ?? null;
}

async function loadStages(sessionId) {
  const stages = await query(config.stagesTable, {
    KeyConditionExpression: 'session_id = :sid',
    ExpressionAttributeValues: { ':sid': sessionId },
  });
  const map = {};
  for (const st of stages) map[st.stage] = st;
  return map;
}

async function generateReport(userId, date) {
  const sessions = await query(config.sessionsTable, {
    KeyConditionExpression: 'user_id = :u AND begins_with(sk, :d)',
    ExpressionAttributeValues: { ':u': userId, ':d': `${date}#` },
  });

  const mainSessions = sessions
    .filter((s) => s.is_main_sleep === 1 || s.is_main_sleep === true)
    .sort((a, b) => (b.duration_ms || 0) - (a.duration_ms || 0));

  const session = mainSessions[0] ?? null;
  let avgBedtime = null;
  let avgWakeup = null;
  let snapshot = null;

  if (session) {
    const startUtc = fitbitLocalToUtc(session.start_time, config.userTzOffsetHours);
    const endUtc = fitbitLocalToUtc(session.end_time, config.userTzOffsetHours);

    avgBedtime = await avgIlluminance(
      config.defaultDeviceId,
      shiftIsoUtc(startUtc, -30 * 60 * 1000),
      startUtc,
    );
    avgWakeup = await avgIlluminance(
      config.defaultDeviceId,
      shiftIsoUtc(endUtc, -15 * 60 * 1000),
      shiftIsoUtc(endUtc, 15 * 60 * 1000),
    );

    const stages = await loadStages(session.fitbit_log_id);
    snapshot = {
      fitbit_log_id: session.fitbit_log_id,
      date: session.date,
      start_time: session.start_time,
      end_time: session.end_time,
      duration_ms: session.duration_ms,
      minutes_asleep: session.minutes_asleep,
      minutes_awake: session.minutes_awake,
      time_in_bed: session.time_in_bed,
      efficiency: session.efficiency,
      is_main_sleep: session.is_main_sleep,
      sleep_type: session.sleep_type,
      stages: Object.fromEntries(
        Object.entries(stages).map(([k, v]) => [k, v.minutes]),
      ),
    };
  }

  const sleepRoutineId = await findRoutinesForDate(userId, date, 'sleep');
  const wakeRoutineId = await findRoutinesForDate(userId, date, 'wake');

  await putItem(config.reportsTable, {
    user_id: userId,
    report_date: date,
    sleep_session_snapshot: snapshot,
    sleep_session_sk: session ? session.sk : null,
    sleep_routine_id: sleepRoutineId,
    wake_routine_id: wakeRoutineId,
    avg_illuminance_bedtime: avgBedtime,
    avg_illuminance_wakeup: avgWakeup,
    generated_at: new Date().toISOString(),
  });

  console.log(`[REPORT] ${date} 리포트 생성 완료 user=${userId}`);
}

function transformReport(report) {
  const snap = report.sleep_session_snapshot;
  return {
    date: report.report_date,
    sleep: snap?.minutes_asleep != null ? {
      startTime: snap.start_time,
      endTime: snap.end_time,
      minutesAsleep: snap.minutes_asleep,
      efficiency: snap.efficiency,
      stages: {
        deep: snap.stages?.deep ?? null,
        rem: snap.stages?.rem ?? null,
        light: snap.stages?.light ?? null,
        wake: snap.stages?.wake ?? null,
      },
    } : null,
    lighting: {
      sleepRoutineExecuted: !!report.sleep_routine_id,
      wakeRoutineExecuted: !!report.wake_routine_id,
      avgIlluminanceBedtime: report.avg_illuminance_bedtime ?? null,
      avgIlluminanceWakeup: report.avg_illuminance_wakeup ?? null,
    },
  };
}

module.exports = { generateReport, transformReport, avgIlluminance };
