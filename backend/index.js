// ── 스마트 수면 조명 — 백엔드 데이터 파이프라인 진입점 ──
//
// 실행 흐름:
//  1. SQLite DB 초기화 (테이블 없으면 생성)
//  2. MQTT 구독자 시작 → 조도 데이터 실시간 저장
//  3. Fitbit 폴러 시작 → 매일 07:00 전날 수면 데이터 동기화 + 리포트 생성
//
// 최초 실행 전: node fitbit/auth.js 로 Fitbit OAuth 인증 필요

const config = require('./config');
const { getDb } = require('./db/db');
const mqttSub = require('./pipeline/mqttSub');
const { startPoller } = require('./fitbit/poller');

function getAuthedUser() {
  return getDb()
    .prepare(
      'SELECT u.id FROM users u JOIN fitbit_tokens t ON t.user_id = u.id LIMIT 1',
    )
    .get();
}

async function bootstrap() {
  console.log('── 스마트 수면 조명 백엔드 데이터 파이프라인 기동 ──');
  console.log(`DB   : ${config.db.path}`);
  console.log(`MQTT : ${config.mqtt.brokerUrl}`);
  console.log(`Fitbit 모드: ${config.fitbit.mock ? 'MOCK' : 'LIVE'}`);

  // DB 초기화 (schema.sql 적용)
  getDb();

  // MQTT 구독자 시작 (항상)
  mqttSub.start();

  // Fitbit 폴러 시작
  const user = getAuthedUser();
  if (!user) {
    console.warn(
      '[MAIN] Fitbit 토큰 없음 — "node fitbit/auth.js" 를 먼저 실행하세요.',
    );
    console.warn('[MAIN] MQTT 구독은 활성화됨. Fitbit 폴러는 비활성.');
    return;
  }

  if (config.fitbit.mock || config.fitbit.clientId) {
    startPoller(user.id);
  } else {
    console.warn('[MAIN] FITBIT_CLIENT_ID 미설정 — Fitbit 폴러 비활성화');
  }
}

bootstrap().catch((err) => {
  console.error('[MAIN] 기동 실패:', err.message);
  process.exit(1);
});

process.on('SIGINT',  () => { console.log('\n[MAIN] SIGINT 수신 → 종료'); process.exit(0); });
process.on('SIGTERM', () => { console.log('[MAIN] SIGTERM 수신 → 종료');  process.exit(0); });
