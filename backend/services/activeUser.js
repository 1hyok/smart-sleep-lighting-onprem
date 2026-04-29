// MVP 단일 테넌트용 활성 user_id 결정 (Fitbit 토큰 보유 사용자 우선, 없으면 최소 id 사용자).

const { getDbAsync } = require('../db/db');

let cachedUserId = null;

async function getPrimaryUserId() {
  if (cachedUserId != null) return cachedUserId;

  const db = await getDbAsync();
  const withFitbit = db.prepare(`
    SELECT u.id FROM users u
    INNER JOIN fitbit_tokens t ON t.user_id = u.id
    ORDER BY u.id ASC LIMIT 1
  `).get();

  if (withFitbit) {
    cachedUserId = withFitbit.id;
    return cachedUserId;
  }

  const anyUser = db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get();
  cachedUserId = anyUser?.id ?? 1;
  return cachedUserId;
}

function invalidatePrimaryUserIdCache() {
  cachedUserId = null;
}

module.exports = { getPrimaryUserId, invalidatePrimaryUserIdCache };
