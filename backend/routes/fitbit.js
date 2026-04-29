// GET /api/fitbit/status

const express = require('express');
const { getDbAsync } = require('../db/db');
const { getPrimaryUserId } = require('../services/activeUser');

const router = express.Router();

router.get('/status', async (req, res) => {
  const userId = await getPrimaryUserId();
  const db = await getDbAsync();

  const token = db.prepare(`
    SELECT expires_at, updated_at FROM fitbit_tokens WHERE user_id = ?
  `).get(userId);

  if (!token) {
    return res.json({
      status: 'not_connected',
      message: 'Fitbit 연결 안됨. node fitbit/auth.js 실행 필요.',
    });
  }

  const expired = new Date(token.expires_at) <= new Date();

  const lastSync = db.prepare(`
    SELECT MAX(fetched_at) AS last_sync FROM sleep_sessions WHERE user_id = ?
  `).get(userId);

  res.json({
    status: expired ? 'expired' : 'connected',
    expiresAt: token.expires_at,
    lastSyncAt: lastSync?.last_sync ?? null,
    message: expired
      ? '토큰이 만료되었습니다. node fitbit/auth.js 재실행 필요.'
      : 'Fitbit 연결 정상.',
  });
});

module.exports = router;
