// MQTT home/edge/status 로 수신한 디바이스 최신 상태 (메모리 맵).
// INTEGRATION.md — retain 메시지로 구독 즉시 최신 1건 확보.

/** @type {Map<string, { status: string, timestamp: string, reason: string | null }>} */
const byDeviceId = new Map();

function updateFromPayload(msg) {
  if (!msg || typeof msg.deviceId !== 'string') return;
  byDeviceId.set(msg.deviceId, {
    status: msg.status,
    timestamp: msg.timestamp,
    reason: msg.reason ?? null,
  });
}

function snapshotList() {
  return [...byDeviceId.entries()].map(([deviceId, v]) => ({
    deviceId,
    status: v.status,
    timestamp: v.timestamp,
    reason: v.reason,
  }));
}

module.exports = { updateFromPayload, snapshotList };
