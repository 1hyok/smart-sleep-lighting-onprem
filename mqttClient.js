// ──────────────────────────────────────────────
// mqttClient.js
//  - mqtt.js 기반 브로커 통신 래퍼 (publish + subscribe).
//  - 책임:
//     · 브로커 연결 + 재연결(지수 백오프)
//     · LWT(Last Will & Testament) 등록 → 비정상 종료도 retain offline 발행
//     · 정상 접속/종료 시 retain online/offline 상태 발행
//     · publish() — 미연결 시에는 드랍 (센서값은 휘발성 데이터)
//     · subscribe(topic, handler) — 토픽-핸들러 라우팅. 단일 message 디스패처
//       하나만 등록해 핸들러 중복/누수 차단. clean=true 라 재연결마다 자동 재구독.
// ──────────────────────────────────────────────

const mqtt = require('mqtt');
const config = require('./config');
const buildLogger = require('./logger');
const log = buildLogger('mqtt');

let client = null;

// 토픽 → 핸들러 라우팅 맵.
//  - client.on('message') 를 토픽마다 등록하면 매 재연결/재구독마다 리스너가
//    누적되는 메모리 누수 + 중복 호출이 발생. 디스패처는 connect() 시점에
//    단 한 번만 등록하고, 이 맵으로 토픽을 라우팅.
const subscriptions = new Map();

// 재연결 지수 백오프
//  - 브로커 영구 단절 시 고정 2초 재시도가 로그/네트워크/CPU 자원을 고갈시킴.
//  - INITIAL 부터 시작해 실패 누적마다 2배 증가, MAX 에서 상한.
//  - 한 번이라도 connect 성공하면 attempts 와 reconnectPeriod 를 리셋.
const RECONNECT_INITIAL_MS = Number(process.env.MQTT_RECONNECT_INITIAL_MS) || 2000;
const RECONNECT_MAX_MS = Number(process.env.MQTT_RECONNECT_MAX_MS) || 60_000;
let reconnectAttempts = 0;

// MQTT keepalive (초)
//  - 브로커는 1.5×keepalive 동안 패킷이 없으면 LWT 발동.
//  - mqtt.js 기본값 60초 → 비정상 단절 후 최대 ~90초 인지 지연.
//  - 30초로 낮춰 LWT 인지 시간을 ~45초로 단축. 로컬 브로커 + 단일 디바이스
//    환경에서 추가 트래픽 비용은 무시 수준.
const KEEPALIVE_SEC = Number(process.env.MQTT_KEEPALIVE_SEC) || 30;

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
    keepalive: KEEPALIVE_SEC,
    will: {
      topic: config.topics.deviceStatus,
      payload: buildStatusPayload('offline', { reason: 'unexpected_disconnect' }),
      qos: 1,
      retain: true,
    },
  });

  // 단일 message 디스패처 — connect() 호출 1회당 1번만 등록되므로 누수 X.
  // 토픽별 라우팅은 subscriptions Map 으로 위임.
  client.on('message', dispatchMessage);

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

    // clean=true 정책상 재연결 시 브로커 측 구독 상태가 휘발 →
    // subscriptions 맵의 모든 토픽을 일괄 재등록.
    resubscribeAll();
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
 * 토픽 구독 + 핸들러 매핑.
 *  - connect() 이전/이후 어느 시점에 호출해도 OK.
 *    · 미연결 상태면 subscriptions 맵에 저장만 → connect 시 일괄 등록
 *    · 연결 상태면 즉시 브로커에 SUBSCRIBE 패킷 전송
 *  - 동일 토픽 재호출 시 핸들러를 교체 (브로커 재구독은 불필요 — 같은 토픽).
 *  - clean=true 정책상 재연결 시 자동 재구독 (resubscribeAll).
 *
 * @param {string} topic
 * @param {(payload:any, topic:string) => void} handler  파싱된 JSON 페이로드 수신
 */
function subscribe(topic, handler) {
  if (typeof handler !== 'function') {
    throw new TypeError(`subscribe(${topic}): handler 가 함수가 아닙니다`);
  }
  const replacing = subscriptions.has(topic);
  subscriptions.set(topic, handler);

  if (replacing) {
    log.warn(`이미 구독 중인 토픽 — 핸들러 교체: ${topic}`);
    return; // 브로커 측 구독은 그대로, 라우팅 맵만 갱신
  }

  if (client && client.connected) {
    client.subscribe(topic, { qos: 1 }, (err, granted) => {
      if (err) log.error(`구독 실패 [${topic}]: ${err.message}`);
      else log.info(`구독 등록 [${topic}] (qos=${granted?.[0]?.qos ?? '?'})`);
    });
  } else {
    log.info(`구독 예약 [${topic}] — connect 시점에 일괄 등록`);
  }
}

/**
 * 단일 message 디스패처. 토픽 → 등록된 핸들러로 위임.
 *  - JSON 파싱은 여기서 일괄 처리해 각 핸들러는 객체로 받음.
 *  - 핸들러가 throw 해도 mqtt.js 내부 루프가 죽지 않도록 격리.
 */
function dispatchMessage(topic, payloadBuf) {
  const handler = subscriptions.get(topic);
  if (!handler) {
    log.warn(`핸들러 미등록 토픽 메시지 무시: ${topic}`);
    return;
  }

  let payload;
  try {
    payload = JSON.parse(payloadBuf.toString());
  } catch (err) {
    log.error(`payload JSON 파싱 실패 [${topic}]: ${err.message}`);
    return;
  }

  // sync/async 핸들러 모두 안전하게 격리.
  Promise.resolve()
    .then(() => handler(payload, topic))
    .catch((err) =>
      log.error(`핸들러 처리 중 예외 [${topic}]: ${err.message}`),
    );
}

/**
 * subscriptions 맵의 모든 토픽을 브로커에 재등록.
 *  - clean=true 라 재연결마다 호출되어야 함. connect 핸들러에서 트리거.
 */
function resubscribeAll() {
  if (!client || subscriptions.size === 0) return;
  for (const topic of subscriptions.keys()) {
    client.subscribe(topic, { qos: 1 }, (err, granted) => {
      if (err) log.error(`재구독 실패 [${topic}]: ${err.message}`);
      else log.info(`재구독 [${topic}] (qos=${granted?.[0]?.qos ?? '?'})`);
    });
  }
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
  subscribe,
  disconnect,
};
