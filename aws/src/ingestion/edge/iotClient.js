// ──────────────────────────────────────────────
// iotClient.js
//  - 온프렘 mqttClient.js 를 AWS IoT Core 용으로 진화시킨 발행 클라이언트.
//  - 핵심 변경(프로젝트 5 §2.1 설계 → 구현):
//     · 로컬 Mosquitto(mqtt://...:1883) → IoT Core(mqtts://endpoint:8883)
//     · username/password 인증 → X.509 클라이언트 인증서 기반 상호 TLS(mTLS)
//     · 토픽/페이로드는 온프렘 계약 유지(home/sensor/illuminance, home/edge/status)
//     · LWT, QoS 1, 지수 백오프 재연결은 그대로 계승
//  - dry-run: 인증서/엔드포인트가 없으면 실제 접속 대신 "발행될 내용"만 로깅.
//  - 담당: 정일혁
// ──────────────────────────────────────────────

const fs = require('fs');
const { EventEmitter } = require('events');
const mqtt = require('mqtt');
const config = require('./config');
const buildLogger = require('./logger');
const log = buildLogger('iot');

let client = null;

// 재연결 지수 백오프 (온프렘과 동일 전략 — 영구 단절 시 자원 고갈 방지)
const RECONNECT_INITIAL_MS = Number(process.env.IOT_RECONNECT_INITIAL_MS) || 2000;
const RECONNECT_MAX_MS = Number(process.env.IOT_RECONNECT_MAX_MS) || 60_000;
let reconnectAttempts = 0;

// MQTT keepalive(초). 1.5×keepalive 동안 패킷 없으면 브로커가 LWT 발동.
const KEEPALIVE_SEC = Number(process.env.IOT_KEEPALIVE_SEC) || 30;

/**
 * LWT/상태 페이로드 빌더 (spec §1 계약: { deviceId, status, timestamp, reason }).
 * retain=true 로 발행되어 구독자가 어느 시점에 붙어도 가용 여부를 1건 read 로 파악.
 */
function buildStatusPayload(status, extra = {}) {
  return JSON.stringify({
    deviceId: config.iot.deviceId,
    status, // 'online' | 'offline'
    timestamp: new Date().toISOString(),
    ...extra, // reason: 'graceful_shutdown' | 'unexpected_disconnect'
  });
}

/**
 * 실제 IoT Core 연결 (mqtts + X.509 mTLS).
 *  - key/cert: 디바이스 개인키 + 디바이스 인증서 (클라이언트 인증)
 *  - ca: Amazon Root CA (서버 인증서 검증 → 위장 엔드포인트 차단)
 *  - rejectUnauthorized:true 로 서버 인증서 검증을 강제하여 mTLS 를 완성.
 */
function makeRealClient() {
  const { endpoint, port, clientId, certs } = config.iot;
  log.info(
    `IoT Core 연결 시도: mqtts://${endpoint}:${port} ` +
      `(clientId=${clientId}, thing=${config.iot.thingName})`,
  );

  return mqtt.connect({
    host: endpoint,
    port,
    protocol: 'mqtts',
    clientId,
    key: fs.readFileSync(certs.key),
    cert: fs.readFileSync(certs.cert),
    ca: fs.readFileSync(certs.ca),
    clean: true,
    reconnectPeriod: RECONNECT_INITIAL_MS,
    connectTimeout: 10_000,
    keepalive: KEEPALIVE_SEC,
    rejectUnauthorized: true,
    // 비정상 단절 시 IoT Core 가 자동으로 offline 상태를 retain 발행.
    will: {
      topic: config.topics.status,
      payload: buildStatusPayload('offline', { reason: 'unexpected_disconnect' }),
      qos: 1,
      retain: true,
    },
  });
}

/**
 * dry-run 가짜 클라이언트 — 인증서/엔드포인트 없는 PC 개발 환경용.
 *  - publish/subscribe/end 를 로깅 no-op 으로 흉내내고, 다음 tick 에 connect 발화.
 *  - 덕분에 index.js 의 흐름(connect → 구독 → 주기 발행)을 인증서 없이 검증 가능.
 */
function makeDryRunClient() {
  const reason = !config.iot.endpoint
    ? 'AWS_IOT_ENDPOINT 미설정'
    : 'MOCK_IOT=true 또는 인증서 파일 없음';
  log.warn(`── DRY-RUN 모드 ── 실제 IoT Core 미접속, 발행 내용만 로깅합니다. (이유: ${reason})`);

  const fake = new EventEmitter();
  fake.connected = false;
  fake.publish = (topic, payload, opts = {}, cb) => {
    const body = typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload);
    log.info(
      `[DRY-RUN] PUBLISH ${topic} ` +
        `(qos=${opts.qos ?? 0}${opts.retain ? ', retain' : ''}) → ${body}`,
    );
    if (typeof cb === 'function') cb();
  };
  fake.subscribe = (topic, optsOrCb, cb) => {
    const list = Array.isArray(topic) ? topic.join(', ') : topic;
    log.info(`[DRY-RUN] SUBSCRIBE ${list}`);
    const done = typeof optsOrCb === 'function' ? optsOrCb : cb;
    if (typeof done === 'function') done(null, []);
  };
  fake.end = (_force, _opts, cb) => {
    fake.connected = false;
    if (typeof cb === 'function') cb();
  };
  // connect 이벤트를 비동기로 발화 → 호출부가 핸들러를 붙일 시간을 준다.
  setImmediate(() => {
    fake.connected = true;
    fake.emit('connect');
  });
  return fake;
}

function onConnect() {
  if (reconnectAttempts > 0) {
    log.info(`연결 성공 (재연결 ${reconnectAttempts}회 시도 후)`);
    reconnectAttempts = 0;
    if (client.options) client.options.reconnectPeriod = RECONNECT_INITIAL_MS;
  } else {
    log.info('IoT Core 연결 성공');
  }

  // LWT 짝꿍: 정상 접속/재접속 시 retained "online" 발행.
  client.publish(config.topics.status, buildStatusPayload('online'), { qos: 1, retain: true }, (err) => {
    if (err) log.warn(`status(online) 발행 실패: ${err.message}`);
    else log.info(`status → online [${config.topics.status}]`);
  });
}

function onReconnect() {
  reconnectAttempts += 1;
  const next = Math.min(RECONNECT_INITIAL_MS * 2 ** (reconnectAttempts - 1), RECONNECT_MAX_MS);
  if (client.options) client.options.reconnectPeriod = next;
  log.warn(`IoT Core 재연결 시도... (#${reconnectAttempts}, 다음 간격 ${next}ms)`);
}

/**
 * 연결 시작. real/dry-run 분기 후 공통 이벤트 배선.
 *  - 멱등성 가드: 중복 호출 시 기존 client 반환(소켓 이중 생성 방지).
 */
function connect() {
  if (client) {
    log.warn('이미 연결된 client 존재 — 기존 client 반환');
    return client;
  }
  client = config.iot.dryRun ? makeDryRunClient() : makeRealClient();

  client.on('connect', onConnect);
  client.on('reconnect', onReconnect);
  client.on('close', () => log.warn('IoT Core 연결 종료'));
  client.on('offline', () => log.warn('IoT Core 와 오프라인 상태'));
  client.on('error', (err) => log.error('MQTT 에러:', err.message));

  return client;
}

/**
 * 토픽 발행. 객체는 JSON 직렬화. 미연결 시 드랍(센서값은 휘발성).
 */
function publish(topic, message, options = { qos: 0, retain: false }) {
  const payload =
    typeof message === 'string' || Buffer.isBuffer(message) ? message : JSON.stringify(message);

  if (!client || !client.connected) {
    log.warn(`발행 드랍 (미연결) [${topic}]`);
    return;
  }
  client.publish(topic, payload, options, (err) => {
    if (err) log.error(`발행 실패 [${topic}]:`, err.message);
    else log.debug(`발행 완료 [${topic}]`);
  });
}

/**
 * 정상 종료 — LWT 와 별개로 graceful offline 을 즉시 retain 갱신 후 end.
 */
function disconnect() {
  return new Promise((resolve) => {
    if (!client) return resolve();
    const finish = () => client.end(false, {}, () => {
      log.info('IoT Core 연결 정상 종료');
      resolve();
    });
    if (!client.connected) return finish();
    client.publish(
      config.topics.status,
      buildStatusPayload('offline', { reason: 'graceful_shutdown' }),
      { qos: 1, retain: true },
      (err) => {
        if (err) log.warn(`status(offline) 발행 실패: ${err.message}`);
        else log.info(`status → offline [${config.topics.status}]`);
        finish();
      },
    );
  });
}

// shadow.js 등에서 구독/이벤트 배선을 위해 내부 client 노출.
function getClient() {
  return client;
}

module.exports = { connect, publish, disconnect, getClient };
