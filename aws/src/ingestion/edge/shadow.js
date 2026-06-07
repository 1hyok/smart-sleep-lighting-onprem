// ──────────────────────────────────────────────
// shadow.js  — AWS IoT Device Shadow 동기화 (Classic Shadow)
//  - 프로젝트 5 §2.1 / spec §5: 백엔드(임형택) Lambda 가 조명 명령을 desired 로
//    내리면, 라즈베리파이가 자신의 Shadow delta 를 구독해 수신 → 엣지 로컬에서
//    GPIO 램프를 실행(light.js) → reported 로 적용 상태를 반영한다.
//  - 디바이스가 잠시 오프라인이어도 재접속 시 마지막 desired 를 받아 동기화한다.
//  - 담당: 정일혁
//
//  설계 노트:
//   · init(client)   = 메시지 핸들러를 "한 번만" 바인딩(중복 등록 방지).
//   · onConnect()    = (재)접속할 때마다 delta 재구독 + shadow/get 으로 누락 복구.
//     → index.js 가 client.on('connect') 마다 onConnect() 를 호출하므로,
//        런타임 재접속 시에도 오프라인 동안의 마지막 desired 가 복구된다.
// ──────────────────────────────────────────────

const config = require('./config');
const light = require('./light');
const buildLogger = require('./logger');
const log = buildLogger('shadow');

const thing = config.iot.thingName;
const BASE = `$aws/things/${thing}/shadow`;
const T = {
  update: `${BASE}/update`,
  updateDelta: `${BASE}/update/delta`,
  get: `${BASE}/get`,
  getAccepted: `${BASE}/get/accepted`,
};

let client = null;
let messageHandlerBound = false;

// reported state 발행 → 백엔드가 디바이스 동기화/적용 결과를 확인.
function reportState(reported) {
  if (!client || !client.connected) return;
  const payload = JSON.stringify({ state: { reported } });
  client.publish(T.update, payload, { qos: 1, retain: false }, (err) => {
    if (err) log.warn(`reported 갱신 실패: ${err.message}`);
    else log.info(`Shadow reported 갱신 → ${JSON.stringify(reported)}`);
  });
}

// desired(백엔드 조명 명령) 적용 — 엣지 로컬 GPIO 실행 (spec §5).
//  지원 형식: { routine: 'sleep'|'wake', steps? } | { brightness: 0..100 }
function applyDesired(desired) {
  log.info(`Shadow desired 수신 (조명 명령): ${JSON.stringify(desired)}`);

  if (desired.routine === 'sleep' || desired.routine === 'wake') {
    // 즉시 수락(running) 보고 후 비동기 루틴 실행 → 완료/취소 시 재보고.
    reportState({ routine: desired.routine, state: 'running', appliedAt: new Date().toISOString() });
    light
      .runRoutine(desired.routine, desired.steps)
      .then((res) =>
        reportState({
          routine: res.type,
          state: res.state, // 'completed' | 'cancelled'
          brightness: res.brightness,
          appliedAt: new Date().toISOString(),
        }),
      )
      .catch((err) => {
        log.error('조명 루틴 실패:', err.message);
        reportState({ routine: desired.routine, state: 'failed', appliedAt: new Date().toISOString() });
      });
    return;
  }

  if (typeof desired.brightness === 'number') {
    light.setBrightness(desired.brightness);
    reportState({ brightness: light.getCurrentBrightness(), appliedAt: new Date().toISOString() });
    return;
  }

  log.warn('알 수 없는 desired 형식 — 무시');
  reportState({ ...desired, state: 'ignored', appliedAt: new Date().toISOString() });
}

function handleMessage(topic, message) {
  if (topic !== T.updateDelta && topic !== T.getAccepted) return; // 무관 토픽 무시
  let doc;
  try {
    doc = JSON.parse(message.toString());
  } catch {
    log.warn('Shadow 메시지 JSON 파싱 실패');
    return;
  }
  // update/delta 는 state 자체가 delta, get/accepted 는 state.desired.
  const desired = topic === T.updateDelta ? doc.state : doc.state && doc.state.desired;
  if (desired && Object.keys(desired).length) applyDesired(desired);
}

/**
 * 1회 초기화: 메시지 핸들러를 한 번만 바인딩한다.
 *  iotClient.connect() 가 반환한 client 를 주입받는다.
 */
function init(mqttClient) {
  client = mqttClient;
  if (config.iot.dryRun) {
    log.warn('DRY-RUN: Shadow 구독/동기화는 실제 IoT Core 에서만 동작 (로컬 생략).');
    return;
  }
  if (!messageHandlerBound) {
    client.on('message', handleMessage);
    messageHandlerBound = true;
  }
}

/**
 * (재)접속 시마다 호출 — delta 재구독 + shadow/get 으로 오프라인 동안의 누락 복구.
 *  index.js 의 client.on('connect') 에서 매 연결마다 호출한다(런타임 재접속 포함).
 */
function onConnect() {
  if (!client || config.iot.dryRun) return;
  client.subscribe([T.updateDelta, T.getAccepted], { qos: 1 }, (err) => {
    if (err) {
      log.error(`Shadow 구독 실패: ${err.message}`);
      return;
    }
    log.info(`Shadow 구독 완료: ${T.updateDelta}`);
    // 재접속 시 마지막 desired 동기화를 위해 현재 Shadow 문서를 요청.
    client.publish(T.get, '', { qos: 1 });
  });
}

module.exports = { init, onConnect };
