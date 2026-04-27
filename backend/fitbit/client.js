// Fitbit Web API 클라이언트.
// 토큰 만료 5분 전 자동 갱신, 401 응답 시 1회 강제 갱신 후 재시도.

const config = require('../config');
const { getDb } = require('../db/db');

const BASE_URL = 'https://api.fitbit.com';
const TOKEN_URL = 'https://api.fitbit.com/oauth2/token';

function basicAuth() {
  return Buffer.from(
    `${config.fitbit.clientId}:${config.fitbit.clientSecret}`,
  ).toString('base64');
}

async function doRefresh(userId) {
  const db = getDb();
  const row = db
    .prepare('SELECT refresh_token FROM fitbit_tokens WHERE user_id = ?')
    .get(userId);
  if (!row) throw new Error(`userId=${userId} 의 Fitbit 토큰이 없습니다`);

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth()}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: row.refresh_token,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`토큰 갱신 실패 ${res.status}: ${body}`);
  }

  const data = await res.json();
  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

  db.prepare(`
    UPDATE fitbit_tokens
    SET access_token  = ?,
        refresh_token = ?,
        expires_at    = ?,
        updated_at    = datetime('now')
    WHERE user_id = ?
  `).run(data.access_token, data.refresh_token, expiresAt, userId);

  console.log(`[FITBIT] 액세스 토큰 갱신 완료 (user_id=${userId})`);
  return data.access_token;
}

async function getToken(userId) {
  const db = getDb();
  const row = db
    .prepare('SELECT access_token, expires_at FROM fitbit_tokens WHERE user_id = ?')
    .get(userId);
  if (!row) throw new Error(`userId=${userId} 의 Fitbit 토큰이 없습니다`);

  // 만료 5분 전이면 선제적으로 갱신
  if (Date.now() >= new Date(row.expires_at).getTime() - 5 * 60 * 1000) {
    return doRefresh(userId);
  }
  return row.access_token;
}

async function fitbitGet(userId, apiPath) {
  const token = await getToken(userId);
  const res = await fetch(`${BASE_URL}${apiPath}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  // 401이면 강제 갱신 후 1회 재시도
  if (res.status === 401) {
    const newToken = await doRefresh(userId);
    const retry = await fetch(`${BASE_URL}${apiPath}`, {
      headers: { Authorization: `Bearer ${newToken}` },
    });
    if (!retry.ok) throw new Error(`Fitbit API 오류 ${retry.status}: ${apiPath}`);
    return retry.json();
  }

  if (!res.ok) throw new Error(`Fitbit API 오류 ${res.status}: ${apiPath}`);
  return res.json();
}

// date: 'YYYY-MM-DD'
async function getSleepByDate(userId, date) {
  return fitbitGet(userId, `/1.2/user/-/sleep/date/${date}.json`);
}

async function getUserProfile(userId) {
  return fitbitGet(userId, '/1/user/-/profile.json');
}

module.exports = { getSleepByDate, getUserProfile, doRefresh };
