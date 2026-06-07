'use strict';

const config = require('./config');
const { scan } = require('./dynamodb');

let cachedUserId = null;

async function getPrimaryUserId() {
  if (cachedUserId) return cachedUserId;

  const tokens = await scan(config.tokensMetaTable);
  if (tokens.length > 0) {
    tokens.sort((a, b) => (a.user_id < b.user_id ? -1 : 1));
    cachedUserId = tokens[0].user_id;
    return cachedUserId;
  }

  const users = await scan(config.usersTable);
  if (users.length > 0) {
    users.sort((a, b) => (a.user_id < b.user_id ? -1 : 1));
    cachedUserId = users[0].user_id;
    return cachedUserId;
  }

  cachedUserId = 'usr-default';
  return cachedUserId;
}

function invalidatePrimaryUserIdCache() {
  cachedUserId = null;
}

module.exports = { getPrimaryUserId, invalidatePrimaryUserIdCache };
