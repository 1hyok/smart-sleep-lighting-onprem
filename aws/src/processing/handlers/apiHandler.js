'use strict';

const config = require('../lib/config');
const { getItem, putItem, deleteItem, query, scan } = require('../lib/dynamodb');
const { getPrimaryUserId } = require('../lib/users');
const { transformReport } = require('../lib/reports');
const { triggerRoutineAsync, SLEEP_STEPS, WAKE_STEPS } = require('../lib/routines');

const startTime = Date.now();

function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': process.env.CORS_ALLOW_ORIGIN || '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

function parseBody(event) {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    return null;
  }
}

function parseRoutineSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { error: 'steps must be a non-empty array' };
  }
  const parsed = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (typeof s.brightness !== 'number' || s.brightness < 0 || s.brightness > 100) {
      return { error: `step[${i}].brightness must be 0~100` };
    }
    if (typeof s.delayMs !== 'number' || s.delayMs < 0) {
      return { error: `step[${i}].delayMs must be a non-negative number` };
    }
    parsed.push({ brightness: s.brightness, delayMs: s.delayMs });
  }
  return { steps: parsed };
}

function formatSchedule(row) {
  return {
    id: row.user_id,
    sleepTime: row.sleep_time,
    wakeTime: row.wake_time,
    sleepOffsetMin: row.sleep_offset_min,
    wakeOffsetMin: row.wake_offset_min,
    enabled: !!(row.enabled === 1 || row.enabled === true),
    lastSleepTriggered: row.last_sleep_triggered ?? null,
    lastWakeTriggered: row.last_wake_triggered ?? null,
  };
}

async function handleHealth() {
  return json(200, { status: 'ok', uptime: (Date.now() - startTime) / 1000 });
}

async function handleReportByDate(params) {
  const date = params?.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return json(400, { error: 'date query required: YYYY-MM-DD' });
  }

  const userId = await getPrimaryUserId();
  const report = await getItem(config.reportsTable, { user_id: userId, report_date: date });
  if (!report) return json(404, { error: `리포트가 없습니다: ${date}` });
  return json(200, transformReport(report));
}

async function handleReportRecent(params) {
  const days = Math.max(1, Math.min(90, parseInt(params?.days, 10) || 7));
  const userId = await getPrimaryUserId();
  const reports = await query(config.reportsTable, {
    KeyConditionExpression: 'user_id = :u',
    ExpressionAttributeValues: { ':u': userId },
    ScanIndexForward: false,
    Limit: days,
  });
  return json(200, reports.map(transformReport));
}

async function handleIlluminanceCurrent() {
  const row = await getItem(config.illuminLatestTable, { device_id: config.defaultDeviceId });
  if (!row || row.source !== 'sensor') {
    return json(404, { error: '조도 데이터가 없습니다' });
  }
  return json(200, {
    deviceId: row.device_id,
    value: row.value,
    source: row.source,
    timestamp: row.recorded_at,
  });
}

async function handleIlluminanceHistory(params) {
  const hours = Math.max(1, Math.min(168, parseInt(params?.hours, 10) || 24));
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const rows = await query(config.illuminTable, {
    KeyConditionExpression: 'device_id = :d AND recorded_at >= :s',
    FilterExpression: '#src = :sensor',
    ExpressionAttributeNames: { '#src': 'source' },
    ExpressionAttributeValues: {
      ':d': config.defaultDeviceId,
      ':s': since,
      ':sensor': 'sensor',
    },
  });
  rows.sort((a, b) => (a.recorded_at < b.recorded_at ? -1 : 1));
  return json(200, {
    hours,
    count: rows.length,
    data: rows.map((r) => ({
      deviceId: r.device_id,
      value: r.value,
      timestamp: r.recorded_at,
    })),
  });
}

async function handleScheduleGet() {
  const userId = await getPrimaryUserId();
  const row = await getItem(config.schedulesTable, { user_id: userId });
  if (!row) return json(404, { error: '설정된 스케줄이 없습니다. POST로 설정하세요.' });
  return json(200, formatSchedule(row));
}

async function handleSchedulePost(body) {
  const { sleepTime, wakeTime, sleepOffsetMin, wakeOffsetMin, enabled } = body;
  if (!sleepTime || !wakeTime) {
    return json(400, { error: 'sleepTime과 wakeTime(HH:MM 형식)이 필요합니다.' });
  }
  if (!/^\d{2}:\d{2}$/.test(sleepTime) || !/^\d{2}:\d{2}$/.test(wakeTime)) {
    return json(400, { error: '시간 형식은 HH:MM이어야 합니다.' });
  }

  const sleepMin = sleepTime.split(':').map(Number).reduce((a, b) => a * 60 + b);
  const wakeMin = wakeTime.split(':').map(Number).reduce((a, b) => a * 60 + b);
  if (sleepMin === wakeMin) {
    return json(400, { error: '취침과 기상 시각이 같습니다.' });
  }

  const userId = await getPrimaryUserId();
  const item = {
    user_id: userId,
    sleep_time: sleepTime,
    wake_time: wakeTime,
    sleep_offset_min: parseInt(sleepOffsetMin, 10) || 30,
    wake_offset_min: parseInt(wakeOffsetMin, 10) || 15,
    enabled: enabled !== undefined ? (enabled ? 1 : 0) : 1,
    updated_at: new Date().toISOString(),
  };
  await putItem(config.schedulesTable, item);
  return json(200, { message: '스케줄이 저장되었습니다.', schedule: formatSchedule(item) });
}

async function handleScheduleDelete() {
  const userId = await getPrimaryUserId();
  const existing = await getItem(config.schedulesTable, { user_id: userId });
  if (!existing) return json(404, { error: '삭제할 스케줄이 없습니다.' });
  await deleteItem(config.schedulesTable, { user_id: userId });
  return json(200, { message: '스케줄이 삭제되었습니다.' });
}

async function handleFitbitStatus() {
  const userId = await getPrimaryUserId();
  const meta = await getItem(config.tokensMetaTable, { user_id: userId });

  if (!meta) {
    return json(200, {
      status: 'not_connected',
      message: 'Fitbit 연결 안됨. OAuth 인증 후 Secrets Manager에 토큰을 등록하세요.',
    });
  }

  const expired = meta.expires_at ? new Date(meta.expires_at) <= new Date() : true;
  const sessions = await query(config.sessionsTable, {
    KeyConditionExpression: 'user_id = :u',
    ExpressionAttributeValues: { ':u': userId },
    ScanIndexForward: false,
    Limit: 1,
  });

  return json(200, {
    status: expired ? 'expired' : 'connected',
    expiresAt: meta.expires_at ?? null,
    lastSyncAt: sessions[0]?.fetched_at ?? null,
    message: expired
      ? '토큰이 만료되었습니다. fitbitPoller가 갱신하거나 재인증이 필요합니다.'
      : 'Fitbit 연결 정상.',
  });
}

async function handleLightingRoutine(body) {
  const { type, steps, scheduledAt } = body;
  if (!type || !['sleep', 'wake'].includes(type)) {
    return json(400, { error: 'type must be "sleep" or "wake"' });
  }

  let parsedSteps = null;
  if (steps !== undefined) {
    const checked = parseRoutineSteps(steps);
    if (checked.error) return json(400, { error: checked.error });
    parsedSteps = checked.steps;
  }

  const scheduled = scheduledAt || new Date().toISOString();
  const userId = await getPrimaryUserId();

  try {
    const result = await triggerRoutineAsync(userId, type, scheduled, parsedSteps);
    return json(202, {
      success: result.success,
      routineId: result.routineId,
      message: `${type} 루틴이 Device Shadow로 전달되었습니다.`,
      steps: parsedSteps ?? (type === 'sleep' ? SLEEP_STEPS : WAKE_STEPS),
    });
  } catch (err) {
    console.error('[lighting] routine 오류:', err.message);
    return json(500, { error: err.message });
  }
}

async function handleDeviceStatus() {
  const rows = await scan(config.deviceStatusTable);
  return json(200, {
    devices: rows.map((r) => ({
      deviceId: r.device_id,
      status: r.status,
      timestamp: r.timestamp,
      reason: r.reason ?? null,
    })),
  });
}

const ROUTES = [
  { method: 'GET', pattern: /^\/api\/health$/, handler: handleHealth },
  { method: 'GET', pattern: /^\/api\/reports$/, handler: (_, qs) => handleReportByDate(qs) },
  { method: 'GET', pattern: /^\/api\/reports\/recent$/, handler: (_, qs) => handleReportRecent(qs) },
  { method: 'GET', pattern: /^\/api\/illuminance\/current$/, handler: handleIlluminanceCurrent },
  { method: 'GET', pattern: /^\/api\/illuminance\/history$/, handler: (_, qs) => handleIlluminanceHistory(qs) },
  { method: 'GET', pattern: /^\/api\/schedule$/, handler: handleScheduleGet },
  { method: 'POST', pattern: /^\/api\/schedule$/, handler: (body) => handleSchedulePost(body) },
  { method: 'DELETE', pattern: /^\/api\/schedule$/, handler: handleScheduleDelete },
  { method: 'GET', pattern: /^\/api\/fitbit\/status$/, handler: handleFitbitStatus },
  { method: 'POST', pattern: /^\/api\/lighting\/routine$/, handler: (body) => handleLightingRoutine(body) },
  { method: 'GET', pattern: /^\/api\/device\/status$/, handler: handleDeviceStatus },
];

exports.handler = async (event) => {
  const method = event.httpMethod || event.requestContext?.http?.method || 'GET';
  const path = event.path || event.rawPath || '/';

  if (method === 'OPTIONS') {
    return json(204, {});
  }

  const body = parseBody(event);
  if (body === null && event.body) {
    return json(400, { error: 'Invalid JSON body' });
  }

  const qs = event.queryStringParameters || {};

  for (const route of ROUTES) {
    if (route.method === method && route.pattern.test(path)) {
      try {
        return await route.handler(body, qs);
      } catch (err) {
        console.error(`[API] ${method} ${path} 오류:`, err.message);
        return json(500, { error: 'Internal server error' });
      }
    }
  }

  return json(404, { error: `404 Not Found: ${method} ${path}` });
};
