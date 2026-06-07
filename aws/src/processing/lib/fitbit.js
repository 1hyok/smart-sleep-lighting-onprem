'use strict';

const config = require('./config');
const { getSecretJson, putSecretJson } = require('./secrets');
const { getItem, putItem } = require('./dynamodb');
const { sleepForDate } = require('./mockData');

const BASE_URL = 'https://api.fitbit.com';
const TOKEN_URL = 'https://api.fitbit.com/oauth2/token';
const SCOPES = 'sleep heartrate profile';

async function getAppCredentials() {
  const secret = await getSecretJson(config.fitbitAppSecretArn);
  if (!secret.client_id || !secret.client_secret) {
    throw new Error('Fitbit app secret must contain client_id and client_secret');
  }
  return secret;
}

function basicAuth(clientId, clientSecret) {
  return Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

function userSecretName(userId) {
  return `${config.projectName}/${config.environment}/fitbit/${userId}`;
}

async function resolveUserSecretArn(userId) {
  const meta = await getItem(config.tokensMetaTable, { user_id: userId });
  if (!meta) throw new Error(`userId=${userId} fitbit-tokens-meta 없음`);

  if (meta.secret_arn && !meta.secret_arn.startsWith('PENDING:')) {
    return meta.secret_arn;
  }
  return userSecretName(userId);
}

async function doRefresh(userId) {
  const { client_id: clientId, client_secret: clientSecret } = await getAppCredentials();
  const secretId = await resolveUserSecretArn(userId);
  const tokenRow = await getSecretJson(secretId);
  if (!tokenRow.refresh_token) throw new Error(`userId=${userId} refresh_token 없음`);

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth(clientId, clientSecret)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokenRow.refresh_token,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`토큰 갱신 실패 ${res.status}: ${body}`);
  }

  const data = await res.json();
  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
  const updated = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: expiresAt,
    scope: data.scope || tokenRow.scope || SCOPES,
  };

  await putSecretJson(secretId, updated);
  await putItem(config.tokensMetaTable, {
    user_id: userId,
    secret_arn: secretId,
    expires_at: expiresAt,
    scope: updated.scope,
    updated_at: new Date().toISOString(),
  });

  console.log(`[FITBIT] 토큰 갱신 완료 user_id=${userId}`);
  return data.access_token;
}

async function getToken(userId) {
  const secretId = await resolveUserSecretArn(userId);
  const tokenRow = await getSecretJson(secretId);
  if (!tokenRow.access_token) throw new Error(`userId=${userId} access_token 없음`);

  const expiresAt = tokenRow.expires_at ? new Date(tokenRow.expires_at).getTime() : 0;
  if (Date.now() >= expiresAt - 5 * 60 * 1000) {
    return doRefresh(userId);
  }
  return tokenRow.access_token;
}

async function fitbitGet(userId, apiPath) {
  const token = await getToken(userId);
  const res = await fetch(`${BASE_URL}${apiPath}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

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

async function getSleepByDate(userId, date) {
  if (config.mockFitbit) {
    console.log(`[FITBIT] Mock 데이터 사용 (${date})`);
    return sleepForDate(date);
  }
  return fitbitGet(userId, `/1.2/user/-/sleep/date/${date}.json`);
}

function yesterdayUtcDate() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

module.exports = {
  getSleepByDate,
  doRefresh,
  getToken,
  userSecretName,
  yesterdayUtcDate,
  SCOPES,
};
