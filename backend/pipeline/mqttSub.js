// MQTT 구독: 조도 → SQLite, 디바이스 상태 → 메모리 맵 (INTEGRATION §4).

const mqtt = require('mqtt');
const config = require('../config');
const { getDbAsync, persist } = require('../db/db');
const { updateFromPayload } = require('./deviceStatusStore');

const SQL_INSERT = `
  INSERT INTO illuminance_readings (device_id, value, raw, source, recorded_at)
  VALUES (?, ?, ?, ?, ?)
`;

function start() {
  const client = mqtt.connect(config.mqtt.brokerUrl, {
    clientId: config.mqtt.clientId,
    username: config.mqtt.username,
    password: config.mqtt.password,
    keepalive: config.mqtt.keepalive,
    clean: true,
    reconnectPeriod: 5000,
  });

  client.on('connect', () => {
    console.log(`[MQTT] 브로커 연결: ${config.mqtt.brokerUrl}`);
    const subs = [config.topics.illuminance, config.topics.deviceStatus];
    for (const topic of subs) {
      client.subscribe(topic, { qos: 1 }, (err) => {
        if (err) console.error(`[MQTT] 구독 실패 ${topic}:`, err.message);
        else console.log(`[MQTT] 구독 시작: ${topic}`);
      });
    }
  });

  client.on('message', (topic, payload) => {
    let msg;
    try {
      msg = JSON.parse(payload.toString());
    } catch {
      console.warn('[MQTT] 페이로드 파싱 실패');
      return;
    }

    if (topic === config.topics.deviceStatus) {
      updateFromPayload(msg);
      return;
    }

    if (topic !== config.topics.illuminance) return;

    if (!config.pipeline.storeMockSensor && msg.source === 'mock') return;

    getDbAsync()
      .then((db) => {
        db.prepare(SQL_INSERT).run(
          msg.deviceId,
          msg.value,
          msg.raw ?? null,
          msg.source,
          msg.timestamp,
        );
        persist();
      })
      .catch((err) => console.error('[MQTT] DB 저장 실패:', err.message));
  });

  client.on('error', (err) => console.error('[MQTT] 오류:', err.message));
  client.on('reconnect', () => console.warn('[MQTT] 재연결 시도 중...'));
  client.on('offline', () => console.warn('[MQTT] 오프라인 상태'));

  return client;
}

module.exports = { start };
