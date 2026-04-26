// ──────────────────────────────────────────────
// eventLogger.js
//  - 엣지 노드의 실행 이벤트(루틴 시작/종료, 단계별 페이딩,
//    제어 명령 수신 등)를 라즈베리파이 로컬 파일에 영속화.
//  - 포맷: JSON Lines (jsonl) — 한 줄에 하나의 JSON 객체.
//    · append-only 라 race-condition 없이 안전합니다.
//    · `cat service_log.jsonl | jq .` 로 쉽게 조회 가능.
//  - 모든 레코드는 ISO 타임스탬프를 포함합니다.
// ──────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const config = require('./config');
const buildLogger = require('./logger');

const log = buildLogger('event-log');
const logPath = config.eventLog.filePath;

// 로그 로테이션 설정
//  - SD 카드 수명 보호 + 파일 비대화 방지.
//  - 크기 임계 도달 시 logPath → logPath.1 → logPath.2 ... 로 회전.
//  - KEEP 개를 넘는 가장 오래된 파일은 자연 삭제(rename 으로 덮어씀).
const MAX_BYTES = Number(process.env.EVENT_LOG_MAX_BYTES) || 5_242_880; // 5MB
const KEEP = Number(process.env.EVENT_LOG_KEEP) || 3;

// 로그 디렉터리 선행 생성 (최초 1회)
try {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
} catch (err) {
  // 디렉터리가 이미 존재하거나 권한 부족 → 실제 write 시점에 다시 검증
  log.warn(`로그 디렉터리 준비 실패: ${err.message}`);
}

/**
 * 현재 로그 파일 크기가 MAX_BYTES 를 넘으면 회전.
 *  - logPath.(N-1) → logPath.N (KEEP 개까지만 유지)
 *  - logPath → logPath.1
 *  - 그 후 새 logPath 는 다음 append 시 자동 생성.
 */
function rotateIfNeeded() {
  try {
    const stat = fs.statSync(logPath);
    if (stat.size < MAX_BYTES) return;
    for (let i = KEEP - 1; i >= 1; i--) {
      const src = `${logPath}.${i}`;
      const dst = `${logPath}.${i + 1}`;
      if (fs.existsSync(src)) fs.renameSync(src, dst);
    }
    fs.renameSync(logPath, `${logPath}.1`);
    log.info(`이벤트 로그 로테이션: ${logPath} → ${logPath}.1`);
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`로테이션 실패: ${err.message}`);
  }
}

/**
 * 이벤트 한 건을 JSONL 파일에 append.
 * @param {object} event 예: { type: 'routine_start', name: 'sleep', ... }
 */
function append(event) {
  const record = {
    timestamp: new Date().toISOString(),
    ...event,
  };

  const line = JSON.stringify(record) + '\n';
  try {
    rotateIfNeeded();
    fs.appendFileSync(logPath, line, { encoding: 'utf8' });
    log.debug('logged:', record.type);
  } catch (err) {
    // 파일 쓰기 실패해도 메인 루프는 멈추지 않도록 error 로만 출력.
    log.error(`이벤트 로그 기록 실패 (${logPath}): ${err.message}`);
  }
  return record;
}

/**
 * 현재 로그 파일 경로 반환 (디버깅/테스트용).
 */
function getPath() {
  return logPath;
}

module.exports = { append, getPath };
