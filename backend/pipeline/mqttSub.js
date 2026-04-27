// MQTT 구독자: home/sensor/illuminance 수신 → SQLite 저장.
// source='mock' 인 샘플은 config.pipeline.storeMockSensor=false(기본)이면 무시.

const mqtt = require('mqtt');
const config = require('../config');
const { getDb } = require('../db/db');

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
    client.subscribe(config.topics.illuminance, { qos: 1 }, (err) => {
      if (err) console.error('[MQTT] 구독 실패:', err.message);
      else console.log(`[MQTT] 구독 시작: ${config.topics.illuminance}`);
    });
  });

  client.on('message', (_topic, payload) => {
    let msg;
    try {
      msg = JSON.parse(payload.toString());
    } catch {
      console.warn('[MQTT] 페이로드 파싱 실패');
      return;
    }

    if (!config.pipeline.storeMockSensor && msg.source === 'mock') return;

    try {
      getDb()
        .prepare(SQL_INSERT)
        .run(msg.deviceId, msg.value, msg.raw ?? null, msg.source, msg.timestamp);
    } catch (err) {
      console.error('[MQTT] DB 저장 실패:', err.message);
    }
  });

  client.on('error', (err) => console.error('[MQTT] 오류:', err.message));
  client.on('reconnect', () => console.warn('[MQTT] 재연결 시도 중...'));
  client.on('offline', () => console.warn('[MQTT] 오프라인 상태'));

  return client;
}

module.exports = { start };
