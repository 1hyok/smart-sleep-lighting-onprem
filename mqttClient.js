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

// 재연결 지수 백오프
//  - 브로커 영구 단절 시 고정 2초 재시도가 로그/네트워크/CPU 자원을 고갈시킴.
//  - INITIAL 부터 시작해 실패 누적마다 2배 증가, MAX 에서 상한.
//  - 한 번이라도 connect 성공하면 attempts 와 reconnectPeriod 를 리셋.
const RECONNECT_INITIAL_MS = Number(process.env.MQTT_RECONNECT_INITIAL_MS) || 2000;
const RECONNECT_MAX_MS = Number(process.env.MQTT_RECONNECT_MAX_MS) || 60_000;
let reconnectAttempts = 0;

// 미연결 시 보존해야 할 "중요 토픽" 발행 큐.
//  - 센서 주기 발행처럼 휘발성이 큰 데이터는 굳이 큐잉하지 않고 드랍.
//  - 루틴 명령/디바이스 상태/추천/조명 제어는 손실되면 의미가 큼 → 보존.
const pendingQueue = [];
const QUEUEABLE_TOPICS = new Set([
  config.topics.routineSuggestion,
  config.topics.deviceStatus,
  config.topics.routineSleep,
  config.topics.routineWakeup,
  config.topics.lightControl,
]);

// 브로커 장기 단절 시 큐가 무한 성장하면 RPi 메모리가 잠식돼 OOM 위험.
// 한도 초과 시 가장 오래된 메시지부터 드랍 (FIFO).
const PENDING_QUEUE_MAX = Number(process.env.MQTT_PENDING_QUEUE_MAX) || 200;

/**
 * 연결 복구 시 보류된 메시지를 차례로 발행.
 *  - 호출 도중 client 가 다시 끊기면 남은 큐는 다음 connect 때 재시도.
 */
function flushQueue() {
  let flushed = 0;
  while (pendingQueue.length && client && client.connected) {
    const { topic, payload, options } = pendingQueue.shift();
    client.publish(topic, payload, options, (err) => {
      if (err) log.error(`큐 플러시 실패 [${topic}]: ${err.message}`);
    });
    flushed += 1;
  }
  if (flushed > 0) {
    log.info(`발행 큐 플러시 완료: ${flushed}건 (잔여=${pendingQueue.length})`);
  }
}

/**
 * LWT 페이로드 빌더 — connect 시점/disconnect 시점에 모두 사용.
 *  - retain=true 로 발행되므로 구독자가 어느 시점에 붙어도 즉시 최신 상태 1건을 받음.
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
 *  - LWT(Last Will & Testament) 등록: keepalive 가 끊겨 브로커가 비정상 종료를
 *    감지하면 자동으로 status:'offline' 메시지를 발행해줌.
 */
function connect() {
  // 멱등성 가드 — bootstrap 외 경로(테스트/hot-reload 등)에서 중복 호출 시
  // 새 client 객체가 이중 생성되어 이전 소켓이 누수되는 것을 방지.
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
    // Mosquitto 인증(allow_anonymous=false) 활성화 시 필요.
    username: config.mqtt.username,
    password: config.mqtt.password,
    clean: true, // 세션을 매번 새로 시작
    reconnectPeriod: RECONNECT_INITIAL_MS, // 초기 2초, 실패 누적 시 지수 증가
    connectTimeout: 10_000, // 10초 타임아웃
    will: {
      topic: config.topics.deviceStatus,
      payload: buildStatusPayload('offline', { reason: 'unexpected_disconnect' }),
      qos: 1,
      retain: true,
    },
  });

  // 연결 성공
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

    // 이미 등록된 토픽이 있으면 재구독 (재연결 시나리오 대비)
    for (const topic of handlers.keys()) {
      client.subscribe(topic, { qos: 1 }, (err) => {
        if (err) log.error(`재구독 실패 [${topic}]:`, err.message);
        else log.info(`재구독 완료 [${topic}]`);
      });
    }

    // 미연결 동안 쌓인 중요 발행 메시지를 비움.
    flushQueue();
  });

  // 재연결 시도 중 — 지수 백오프 적용
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
  const payload =
    typeof message === 'string' || Buffer.isBuffer(message)
      ? message
      : JSON.stringify(message);

  if (!client || !client.connected) {
    if (QUEUEABLE_TOPICS.has(topic)) {
      if (pendingQueue.length >= PENDING_QUEUE_MAX) {
        const dropped = pendingQueue.shift();
        log.warn(
          `발행 큐 한도(${PENDING_QUEUE_MAX}) 초과 — 가장 오래된 ${dropped.topic} 드랍`,
        );
      }
      pendingQueue.push({ topic, payload, options });
      log.warn(`발행 큐잉 [${topic}] (큐 크기=${pendingQueue.length})`);
    } else {
      log.warn(`발행 드랍 (미연결, 비큐잉) [${topic}]`);
    }
    return;
  }

  client.publish(topic, payload, options, (err) => {
    if (err) log.error(`발행 실패 [${topic}]:`, err.message);
    else log.debug(`발행 완료 [${topic}] → ${payload}`);
  });
}

/**
 * 브로커 연결을 정상 종료합니다. (프로세스 shutdown 시)
 *  - LWT 와 별개로 "graceful" offline 상태를 명시적으로 발행:
 *    LWT 는 keepalive 깨짐을 기다려야 하지만 이건 즉시 retain 갱신.
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
  subscribe,
  publish,
  disconnect,
};
