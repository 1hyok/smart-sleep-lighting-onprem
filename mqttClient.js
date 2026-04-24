// ──────────────────────────────────────────────
// mqttClient.js
//  - mqtt.js 기반의 브로커 연결/구독/발행 래퍼.
//  - 재연결, 에러 로깅, 토픽별 콜백 매핑을 한 곳에 모아
//    상위 로직(index.js)이 단순해지도록 합니다.
// ──────────────────────────────────────────────

const mqtt = require('mqtt');
const config = require('./config');
const buildLogger = require('./logger');
const log = buildLogger('mqtt');

// 토픽 → 콜백 매핑 (여러 토픽을 쉽게 구독하기 위함)
const handlers = new Map();
let client = null;

/**
 * 브로커에 연결합니다.
 *  - mqtt.js 는 기본적으로 자동 재연결을 지원합니다(reconnectPeriod).
 */
function connect() {
  const authInfo = config.mqtt.username ? ` as "${config.mqtt.username}"` : ' (anonymous)';
  log.info(
    `브로커 연결 시도: ${config.mqtt.brokerUrl}${authInfo} (clientId=${config.mqtt.clientId})`,
  );

  client = mqtt.connect(config.mqtt.brokerUrl, {
    clientId: config.mqtt.clientId,
    // Mosquitto 인증(allow_anonymous=false) 활성화 시 필요.
    username: config.mqtt.username,
    password: config.mqtt.password,
    clean: true, // 세션을 매번 새로 시작
    reconnectPeriod: 2000, // 2초 간격 재연결
    connectTimeout: 10_000, // 10초 타임아웃
  });

  // 연결 성공
  client.on('connect', () => {
    log.info('브로커 연결 성공');
    // 이미 등록된 토픽이 있으면 재구독 (재연결 시나리오 대비)
    for (const topic of handlers.keys()) {
      client.subscribe(topic, { qos: 1 }, (err) => {
        if (err) log.error(`재구독 실패 [${topic}]:`, err.message);
        else log.info(`재구독 완료 [${topic}]`);
      });
    }
  });

  // 재연결 시도 중
  client.on('reconnect', () => log.warn('브로커 재연결 시도 중...'));

  // 연결 종료
  client.on('close', () => log.warn('브로커 연결 종료'));

  // 오프라인 상태 진입
  client.on('offline', () => log.warn('브로커와 오프라인 상태'));

  // 에러 (인증 실패, 네트워크 오류 등)
  client.on('error', (err) => log.error('MQTT 에러:', err.message));

  // 메시지 수신 → 등록된 핸들러로 디스패치
  client.on('message', (topic, payload) => {
    const handler = handlers.get(topic);
    if (!handler) {
      log.debug(`핸들러 없는 토픽 메시지 수신 [${topic}]`);
      return;
    }
    try {
      handler(payload, topic);
    } catch (err) {
      log.error(`메시지 처리 중 예외 [${topic}]:`, err.message);
    }
  });

  return client;
}

/**
 * 토픽을 구독하고 메시지 수신 시 호출할 콜백을 등록합니다.
 * @param {string} topic
 * @param {(payload: Buffer, topic: string) => void} handler
 */
function subscribe(topic, handler) {
  if (!client) throw new Error('connect() 호출 후 subscribe() 를 사용하세요.');
  handlers.set(topic, handler);

  client.subscribe(topic, { qos: 1 }, (err) => {
    if (err) log.error(`구독 실패 [${topic}]:`, err.message);
    else log.info(`구독 완료 [${topic}]`);
  });
}

/**
 * 토픽으로 메시지를 발행합니다.
 *  - 객체가 전달되면 JSON 문자열로 직렬화합니다.
 */
function publish(topic, message, options = { qos: 0, retain: false }) {
  if (!client || !client.connected) {
    log.warn(`발행 보류 (미연결 상태) [${topic}]`);
    return;
  }

  const payload =
    typeof message === 'string' || Buffer.isBuffer(message)
      ? message
      : JSON.stringify(message);

  client.publish(topic, payload, options, (err) => {
    if (err) log.error(`발행 실패 [${topic}]:`, err.message);
    else log.debug(`발행 완료 [${topic}] → ${payload}`);
  });
}

/**
 * 브로커 연결을 정상 종료합니다. (프로세스 shutdown 시)
 */
function disconnect() {
  return new Promise((resolve) => {
    if (!client) return resolve();
    client.end(false, {}, () => {
      log.info('브로커 연결 정상 종료');
      resolve();
    });
  });
}

module.exports = {
  connect,
  subscribe,
  publish,
  disconnect,
};
