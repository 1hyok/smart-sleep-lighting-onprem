#!/usr/bin/env node
// Fitbit OAuth 2.0 초기 인증 스크립트.
// 실행: node backend/fitbit/auth.js
//
// 1. 콘솔에 인증 URL 출력
// 2. localhost:3000 에서 콜백 대기
// 3. 인가 코드 → 액세스 토큰 교환
// 4. DB에 사용자 + 토큰 저장 후 종료

const http = require('http');
const config = require('../config');
const { getDb } = require('../db/db');

const AUTH_URL = 'https://www.fitbit.com/oauth2/authorize';
const TOKEN_URL = 'https://api.fitbit.com/oauth2/token';
const CALLBACK_PORT = 3000;

function basicAuth() {
  return Buffer.from(
    `${config.fitbit.clientId}:${config.fitbit.clientSecret}`,
  ).toString('base64');
}

async function exchangeCode(code) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth()}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      redirect_uri: config.fitbit.redirectUri,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`토큰 교환 실패 ${res.status}: ${body}`);
  }
  return res.json();
}

async function fetchProfileWithToken(accessToken) {
  const res = await fetch('https://api.fitbit.com/1/user/-/profile.json', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`프로필 조회 실패 ${res.status}`);
  return res.json();
}

function saveUserAndTokens(tokenData, profile) {
  const db = getDb();
  const fitbitUserId = profile.user.encodedId;
  const displayName = profile.user.displayName;

  db.prepare(`
    INSERT INTO users (fitbit_user_id, display_name)
    VALUES (?, ?)
    ON CONFLICT(fitbit_user_id) DO UPDATE SET display_name = excluded.display_name
  `).run(fitbitUserId, displayName);

  const user = db
    .prepare('SELECT id FROM users WHERE fitbit_user_id = ?')
    .get(fitbitUserId);

  const expiresAt = new Date(
    Date.now() + tokenData.expires_in * 1000,
  ).toISOString();

  db.prepare(`
    INSERT INTO fitbit_tokens (user_id, access_token, refresh_token, expires_at, scope)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      access_token  = excluded.access_token,
      refresh_token = excluded.refresh_token,
      expires_at    = excluded.expires_at,
      scope         = excluded.scope,
      updated_at    = datetime('now')
  `).run(
    user.id,
    tokenData.access_token,
    tokenData.refresh_token,
    expiresAt,
    tokenData.scope,
  );

  console.log(`[AUTH] 저장 완료 — 사용자: ${displayName} (${fitbitUserId})`);

  try {
    require('../services/activeUser').invalidatePrimaryUserIdCache();
  } catch {
    /* auth 단독 실행 시 순환 참조 등 무시 */
  }
}

function run() {
  if (!config.fitbit.clientId || !config.fitbit.clientSecret) {
    console.error(
      '[AUTH] FITBIT_CLIENT_ID / FITBIT_CLIENT_SECRET 환경변수가 필요합니다.\n' +
      '       backend/.env 파일을 설정하고 다시 실행하세요.',
    );
    process.exit(1);
  }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.fitbit.clientId,
    redirect_uri: config.fitbit.redirectUri,
    scope: config.fitbit.scopes,
    expires_in: '604800', // 7일
  });

  console.log('\n[AUTH] 아래 URL을 브라우저에서 열어 Fitbit 인증을 완료하세요:\n');
  console.log(`  ${AUTH_URL}?${params}\n`);
  console.log(`[AUTH] 인증 완료 후 ${config.fitbit.redirectUri} 로 리다이렉트됩니다.`);

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
    } catch {
      res.end('Bad request');
      return;
    }

    if (url.pathname !== '/callback') {
      res.end('Not found');
      return;
    }

    const error = url.searchParams.get('error');
    if (error) {
      const desc = url.searchParams.get('error_description') ?? '';
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h2>인증 실패: ${error}</h2><p>${desc}</p>`);
      server.close();
      return;
    }

    const code = url.searchParams.get('code');
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2>code 파라미터가 없습니다</h2>');
      server.close();
      return;
    }

    try {
      const tokenData = await exchangeCode(code);
      const profile = await fetchProfileWithToken(tokenData.access_token);
      saveUserAndTokens(tokenData, profile);

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2>Fitbit 인증 완료!</h2><p>이 창을 닫아도 됩니다.</p>');
    } catch (err) {
      console.error('[AUTH] 오류:', err.message);
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h2>오류 발생</h2><p>${err.message}</p>`);
    } finally {
      server.close(() => {
        console.log('[AUTH] 콜백 서버 종료');
      });
    }
  });

  server.listen(CALLBACK_PORT, () => {
    console.log(`[AUTH] 콜백 서버 대기 중 (port ${CALLBACK_PORT})...`);
  });
}

run();
