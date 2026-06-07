'use strict';

const config = require('../lib/config');
const { putItem } = require('../lib/dynamodb');

exports.handler = async (event) => {
  const thingName = event.thingName || event.thing_name || event.deviceId;
  const status = event.status || 'offline';
  const timestamp = event.timestamp || event.ts || new Date().toISOString();
  const reason = event.reason ?? null;

  if (!thingName) {
    console.warn('[DEVICE] thingName 없음, 스킵');
    return { ok: false };
  }

  await putItem(config.deviceStatusTable, {
    device_id: thingName,
    status,
    timestamp,
    reason,
    updated_at: new Date().toISOString(),
  });

  console.log(`[DEVICE] status=${status} thing=${thingName}`);
  return { ok: true, deviceId: thingName, status };
};
