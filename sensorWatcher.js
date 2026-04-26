// ──────────────────────────────────────────────
// sensorWatcher.js
//  - 조도 센서 발행 파이프라인에 훅을 걸어,
//    연속 샘플이 어두워지면(또는 밝아지면) 루틴 추천 메시지를 MQTT 로 발행.
//  - 히스테리시스:
//     · 연속 N 샘플이 darkLux 미만이면 "sleep_mode" 추천 발행 (bright→dark 전이)
//     · 연속 N 샘플이 brightLux 초과면 "wakeup_mode" 추천 발행 (dark→bright 전이)
//     · 중간 영역에 머무르면 상태 유지 → 동일 추천이 난사되는 것을 방지.
//  - 실제 루틴 자동 실행 여부는 소비자(앱/자동화 규칙)가 결정.
//    이 모듈은 "알림"만 발행.
// ──────────────────────────────────────────────

const config = require('./config');
const mqttClient = require('./mqttClient');
const eventLogger = require('./eventLogger');
const buildLogger = require('./logger');

const log = buildLogger('watcher');

// 최근 N개 샘플 보관 (FIFO)
const history = [];
// 'unknown' → 최초 상태. dark/bright 전이가 일어나야 발행.
let state = 'unknown';

// 상태 전이 락 (핑퐁 방지)
//  - 일시적 가림/그림자/사람 동선으로 임계 양쪽을 빠르게 오갈 때
//    sleep_mode / wakeup_mode 추천이 난사되는 것을 방지.
//  - 한 번 전이가 발생하면 STATE_LOCK_MS 동안 다음 전이를 차단.
//  - 0 = 아직 전이 없음 → 첫 전이는 즉시 허용.
const STATE_LOCK_MS = Number(process.env.SENSOR_STATE_LOCK_MS) || 300_000;
let lastTransitionAt = 0;

/**
 * 조도 샘플 1건을 관찰.
 *  - index.js 의 publishSensorReading() 에서 호출.
 */
function observe(lux) {
  const n = config.sensor.window;
  history.push(lux);
  if (history.length > n) history.shift();
  if (history.length < n) return;

  // 직전 전이 후 STATE_LOCK_MS 동안 핑퐁 방지
  if (lastTransitionAt && Date.now() - lastTransitionAt < STATE_LOCK_MS) return;

  const allDark = history.every((v) => v < config.sensor.darkLux);
  const allBright = history.every((v) => v > config.sensor.brightLux);

  if (allDark && state !== 'dark') {
    transition('dark', lux);
  } else if (allBright && state !== 'bright') {
    transition('bright', lux);
  }
}

/**
 * 상태 전이 발생 시 MQTT 발행 + 이벤트 로그 기록.
 */
function transition(newState, triggerLux) {
  const prev = state;
  state = newState;
  lastTransitionAt = Date.now();

  const suggestion =
    newState === 'dark' ? 'sleep_mode' : 'wakeup_mode';

  const payload = {
    suggest: suggestion,
    reason: newState === 'dark'
      ? `최근 ${config.sensor.window}개 샘플이 모두 ${config.sensor.darkLux} lux 미만`
      : `최근 ${config.sensor.window}개 샘플이 모두 ${config.sensor.brightLux} lux 초과`,
    currentLux: triggerLux,
    window: [...history],
    previousState: prev,
    newState,
    deviceId: config.mqtt.clientId,
    timestamp: new Date().toISOString(),
  };

  log.info(
    `💡 상태 전이 ${prev} → ${newState} | 추천: "${suggestion}" | 현재 ${triggerLux} lux`,
  );

  mqttClient.publish(config.topics.routineSuggestion, payload, {
    qos: 1,
    retain: false,
  });

  eventLogger.append({
    type: 'routine_suggestion',
    ...payload,
  });

  // Fitbit 분석 서버가 routine/sleep|wakeup 을 publish 하는 경로가 정상 흐름.
  // 외부 서버 단절 시에 한해 센서 기반 폴백 자동 실행을 켤 수 있도록 디폴트는
  // 비활성. cooldown 으로 시간 스케줄과의 동시/중복 트리거를 차단.
  if (String(process.env.AUTO_ROUTINE_ON_SENSOR).toLowerCase() === 'true') {
    const cooldownMs = Number(process.env.AUTO_ROUTINE_COOLDOWN_MS) || 1_800_000;
    const now = Date.now();
    if (!transition._lastFiredAt || now - transition._lastFiredAt > cooldownMs) {
      transition._lastFiredAt = now;
      const routineController = require('./routineController');
      if (newState === 'dark') routineController.startSleep();
      else routineController.startWakeup();
      eventLogger.append({ type: 'auto_routine_triggered', from: 'sensor', newState });
    }
  }
}

/**
 * 현재 감시 상태 조회 (디버깅용).
 */
function getState() {
  return { state, history: [...history] };
}

module.exports = { observe, getState };
