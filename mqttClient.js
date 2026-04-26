// ──────────────────────────────────────────────
// mqttClient.js
//  - mqtt.js 기반 브로커 발행 전용 래퍼.
//  - 엣지 노드의 단일 책임(센서 → MQTT 발행)에 맞춰 구독/큐잉 로직은 제거.
//  - 책임:
//     · 브로커 연결 + 재연결(지수 백오프)
//     · LWT(Last Will & Testament) 등록 → 비정상 종료도 retain offline 발행
//     · 정상 접속/종료 시 retain online/offline 상태 발행
//     · publish() — 미연결 시에는 드랍 (센서값은 휘발성 데이터)
// ──────────────────────────────────────────────

const mqtt = require('mqtt');
const config = require('./config');
const buildLogger = require('./logger');
const log = buildLogger('mqtt');

let client = null;

// 재연결 지수 백오프
//  - 브로커 영구 단절 시 고정 2초 재시도가 로그/네트워크/CPU 자원을 고갈시킴.
//  - INITIAL 부터 시작해 실패 누적마다 2배 증가, MAX 에서 상한.
//  - 한 번이라도 connect 성공하면 attempts 와 reconnectPeriod 를 리셋.
const RECONNECT_INITIAL_MS = Number(process.env.MQTT_RECONNECT_INITIAL_MS) || 2000;
const RECONNECT_MAX_MS = Number(process.env.MQTT_RECONNECT_MAX_MS) || 60_000;
let reconnectAttempts = 0;

/**
 * LWT 페이로드 빌더 — connect 시점/disconnect 시점에 모두 사용.
 *  - retain=true 로 발행되므로 구독자(백엔드)가 어느 시점에 붙어도
 *    즉시 최신 상태 1건을 받음.
 */
function buildStatusPayload(status, extra = {}) {
  return JSON.stringify({
    deviceId: config.mqtt.clientId,
    status, // 'online' | 'offline'
    timestamp: new Date().toISOString(),
    ...extra,
  });
}

/**
 * 브로커에 연결합니다.
 *  - mqtt.js 는 기본적으로 자동 재연결을 지원합니다(reconnectPeriod).
 *  - LWT 등록: keepalive 가 끊겨 브로커가 비정상 종료를 감지하면
 *    자동으로 status:'offline' 메시지를 발행해줌.
 */
function connect() {
  // 멱등성 가드 — 중복 호출 시 새 client 가 이중 생성되어 이전 소켓이
  // 누수되는 것을 방지.
  if (client) {
    log.warn('이미 연결된 client 존재 — 기존 client 반환 (중복 connect 호출)');
    return client;
  }

  const authInfo = config.mqtt.username ? ` as "${config.mqtt.username}"` : ' (anonymous)';
  log.info(
    `브로커 연결 시도: ${config.mqtt.brokerUrl}${authInfo} (clientId=${config.mqtt.clientId})`,
  );

  client = mqtt.connect(config.mqtt.brokerUrl, {
    clientId: config.mqtt.clientId,
    username: config.mqtt.username,
    password: config.mqtt.password,
    clean: true,
    reconnectPeriod: RECONNECT_INITIAL_MS,
    connectTimeout: 10_000,
    will: {
      topic: config.topics.deviceStatus,
      payload: buildStatusPayload('offline', { reason: 'unexpected_disconnect' }),
      qos: 1,
      retain: true,
    },
  });

  client.on('connect', () => {
    if (reconnectAttempts > 0) {
      log.info(`브로커 연결 성공 (재연결 ${reconnectAttempts}회 시도 후)`);
      reconnectAttempts = 0;
      client.options.reconnectPeriod = RECONNECT_INITIAL_MS;
    } else {
      log.info('브로커 연결 성공');
    }

    // LWT 짝꿍: 정상 접속 시 retained "online" 발행 → 구독자가
    // 항상 디바이스 가용 여부를 한 번의 read 로 알 수 있음.
    client.publish(
      config.topics.deviceStatus,
      buildStatusPayload('online'),
      { qos: 1, retain: true },
      (err) => {
        if (err) log.warn(`device status (online) 발행 실패: ${err.message}`);
        else log.info(`device status → online [${config.topics.deviceStatus}]`);
      },
    );
  });

  // 재연결 시도 중 — 지수 백오프 적용.
  //  - mqtt.js 는 매 재연결 트리거 직전 client.options.reconnectPeriod 를
  //    참조해 setTimeout 을 걸기 때문에, 여기서 갱신하면 다음 회차부터 반영됨.
  client.on('reconnect', () => {
    reconnectAttempts += 1;
    const nextPeriod = Math.min(
      RECONNECT_INITIAL_MS * Math.pow(2, reconnectAttempts - 1),
      RECONNECT_MAX_MS,
    );
    client.options.reconnectPeriod = nextPeriod;
    log.warn(
      `브로커 재연결 시도 중... (#${reconnectAttempts}, 다음 간격 ${nextPeriod}ms)`,
    );
  });

  client.on('close', () => log.warn('브로커 연결 종료'));
  client.on('offline', () => log.warn('브로커와 오프라인 상태'));
  client.on('error', (err) => log.error('MQTT 에러:', err.message));

  return client;
}

/**
 * 토픽으로 메시지를 발행합니다.
 *  - 객체가 전달되면 JSON 문자열로 직렬화.
 *  - 미연결 상태면 드랍 (센서값은 휘발성이라 큐잉하지 않음).
 *    백엔드가 연결 복구 후 신뢰할 수 있는 데이터는 다음 주기 발행분부터.
 */
function publish(topic, message, options = { qos: 0, retain: false }) {
  const payload =
    typeof message === 'string' || Buffer.isBuffer(message)
      ? message
      : JSON.stringify(message);

  if (!client || !client.connected) {
    log.warn(`발행 드랍 (미연결) [${topic}]`);
    return;
  }

  client.publish(topic, payload, options, (err) => {
    if (err) log.error(`발행 실패 [${topic}]:`, err.message);
    else log.debug(`발행 완료 [${topic}] → ${payload}`);
  });
}

/**
 * 브로커 연결을 정상 종료합니다.
 *  - LWT 와 별개로 "graceful" offline 상태를 명시적으로 retain 갱신.
 *    LWT 는 keepalive 깨짐을 기다려야 하지만 이건 즉시.
 *  - 미연결 상태였다면 publish 단계는 건너뛰고 바로 end().
 */
function disconnect() {
  return new Promise((resolve) => {
    if (!client) return resolve();

    const finish = () => {
      client.end(false, {}, () => {
        log.info('브로커 연결 정상 종료');
        resolve();
      });
    };

    if (!client.connected) return finish();

    client.publish(
      config.topics.deviceStatus,
      buildStatusPayload('offline', { reason: 'graceful_shutdown' }),
      { qos: 1, retain: true },
      (err) => {
        if (err) log.warn(`device status (offline) 발행 실패: ${err.message}`);
        else log.info(`device status → offline [${config.topics.deviceStatus}]`);
        finish();
      },
    );
  });
}

module.exports = {
  connect,
  publish,
  disconnect,
};
