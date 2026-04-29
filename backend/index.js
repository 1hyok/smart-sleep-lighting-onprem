// smart-sleep-lighting backend entry point
// - SQLite init (async for sql.js / sync for bun/better-sqlite3)
// - MQTT subscriber
// - Express REST API (port 3001)
// - Sleep routine scheduler
// - Fitbit poller

const config = require('./config');
const { getDbAsync } = require('./db/db');
const mqttSub = require('./pipeline/mqttSub');
const { startPoller } = require('./fitbit/poller');
const { startServer } = require('./server');
const { start: startScheduler } = require('./services/scheduler');
const { getPrimaryUserId } = require('./services/activeUser');

const API_PORT = Number(process.env.API_PORT) || 3001;

async function bootstrap() {
  console.log('-- smart-sleep-lighting backend starting --');
  console.log(`DB   : ${config.db.path}`);
  console.log(`MQTT : ${config.mqtt.brokerUrl}`);
  console.log(`API  : http://localhost:${API_PORT}`);
  console.log(`Fitbit: ${config.fitbit.mock ? 'MOCK' : 'LIVE'}`);

  // 1. DB init (async for sql.js / sync for bun + better-sqlite3)
  await getDbAsync();

  // 2. MQTT subscriber
  mqttSub.start();

  // 3. REST API server
  startServer(API_PORT);

  // 4. Sleep routine scheduler
  startScheduler();

  // 5. Fitbit poller (토큰이 있는 활성 사용자만)
  const primaryUserId = await getPrimaryUserId();
  const db = await getDbAsync();
  const token = db.prepare('SELECT 1 AS ok FROM fitbit_tokens WHERE user_id = ?').get(primaryUserId);

  if (!token) {
    console.warn('[MAIN] Fitbit 토큰 없음 — node fitbit/auth.js 로 연결 후 재시작.');
    console.warn('[MAIN] MQTT + REST API + Scheduler는 동작 중.');
    return;
  }

  if (config.fitbit.mock || config.fitbit.clientId) {
    startPoller(primaryUserId);
  } else {
    console.warn('[MAIN] FITBIT_CLIENT_ID 미설정 — Fitbit 폴러 비활성');
  }
}

bootstrap().catch((err) => {
  console.error('[MAIN] Startup failed:', err.message);
  process.exit(1);
});

process.on('SIGINT',  () => { console.log('\n[MAIN] SIGINT -> exit'); process.exit(0); });
process.on('SIGTERM', () => { console.log('\n[MAIN] SIGTERM -> exit'); process.exit(0); });
