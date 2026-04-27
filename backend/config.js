const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const config = {
  db: {
    path: process.env.DB_PATH || path.join(__dirname, 'data', 'sleep.db'),
  },

  mqtt: {
    brokerUrl: process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883',
    clientId:
      process.env.MQTT_BACKEND_CLIENT_ID ||
      `backend-${Math.random().toString(16).slice(2, 8)}`,
    username: process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PASSWORD || undefined,
    keepalive: Number(process.env.MQTT_KEEPALIVE_SEC) || 30,
  },

  topics: {
    illuminance:
      process.env.TOPIC_SENSOR_ILLUMINANCE || 'home/sensor/illuminance',
    deviceStatus:
      process.env.TOPIC_DEVICE_STATUS || 'home/edge/status',
  },

  fitbit: {
    clientId: process.env.FITBIT_CLIENT_ID || '',
    clientSecret: process.env.FITBIT_CLIENT_SECRET || '',
    redirectUri:
      process.env.FITBIT_REDIRECT_URI || 'http://localhost:3000/callback',
    scopes: 'sleep heartrate profile',
    pollCron: process.env.FITBIT_POLL_CRON || '0 7 * * *',
    mock: String(process.env.MOCK_FITBIT).toLowerCase() === 'true',
  },

  pipeline: {
    // false = mock 센서 데이터는 DB에 저장하지 않음 (분석 왜곡 방지)
    storeMockSensor:
      String(process.env.STORE_MOCK_SENSOR).toLowerCase() === 'true',
  },
};

module.exports = config;
