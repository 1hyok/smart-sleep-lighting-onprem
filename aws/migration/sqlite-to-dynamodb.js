#!/usr/bin/env node
/**
 * SQLite (sleep.db, 9 tables) → DynamoDB (10 tables) 일회성 마이그레이션
 * 담당: 이준혁 (아키텍처 / DBMS) — 설계 보고서 §4 구현체
 *
 * 전제:
 *   - aws/template.yaml(Storage Stack)이 먼저 배포되어 10개 테이블이 존재해야 한다.
 *   - 실제 데이터가 들어있는 sleep.db 가 있는 머신(RPi 또는 시드 후 dev 머신)에서 실행한다.
 *     (sleep.db 는 .gitignore 대상이라 저장소에 없음 → 경로를 --db 로 지정)
 *   - AWS 자격증명은 표준 체인(환경변수/프로파일/SSO)에서 로드된다.
 *
 * 키 변환 규약 (재실행 가능 / idempotent 보장 위해 결정적(deterministic) ID 사용):
 *   - user_id      := "usr-<fitbit_user_id>"      (정수 users.id 대체)
 *   - routine_id   := "rtn-<legacy lighting_routines.id>"  (운영 신규 루틴은 임형택이 UUID v7 발급)
 *   - session_id   := fitbit_log_id               (sleep-stages 의 PK. Fitbit logId 는 전역 유일)
 *   - sleep-sessions SK := "<date>#<fitbit_log_id>"
 *   - illuminance ttl   := epoch_seconds(recorded_at) + TTL_DAYS*86400
 *
 * 사용:
 *   node sqlite-to-dynamodb.js --db ../../backend/data/sleep.db \
 *        --project smartsleep --env dev --region ap-northeast-2 [--include-mock] [--dry-run]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  PutCommand,
  BatchWriteCommand,
} = require('@aws-sdk/lib-dynamodb');

// ── 인자 파싱 ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {
    db: path.join(__dirname, '..', '..', 'backend', 'data', 'sleep.db'),
    project: 'smartsleep',
    env: 'dev',
    region: process.env.AWS_REGION || 'ap-northeast-2',
    ttlDays: 30,
    includeMock: false,
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--db') args.db = argv[++i];
    else if (a === '--project') args.project = argv[++i];
    else if (a === '--env') args.env = argv[++i];
    else if (a === '--region') args.region = argv[++i];
    else if (a === '--ttl-days') args.ttlDays = Number(argv[++i]);
    else if (a === '--include-mock') args.includeMock = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') {
      console.log('사용: node sqlite-to-dynamodb.js --db <sleep.db> [--project smartsleep] [--env dev] [--region ap-northeast-2] [--ttl-days 30] [--include-mock] [--dry-run]');
      process.exit(0);
    }
  }
  return args;
}

const ARGS = parseArgs(process.argv);
const T = (name) => `${ARGS.project}-${ARGS.env}-${name}`; // 테이블명 규칙: template.yaml 과 동일

// ── SQLite(sql.js) 로더 — 네이티브 빌드 불필요(WASM) ─────────────────────────
async function openSqlite(dbPath) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`SQLite 파일을 찾을 수 없습니다: ${dbPath} (--db 로 경로 지정)`);
  }
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  return new SQL.Database(fs.readFileSync(dbPath));
}

// SELECT 결과를 행 객체 배열로 변환
function query(db, sql) {
  const res = db.exec(sql);
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map((row) => {
    const obj = {};
    columns.forEach((c, i) => { obj[c] = row[i]; });
    return obj;
  });
}

// ── DynamoDB 쓰기 헬퍼 ───────────────────────────────────────────────────────
let ddb = null;
const counters = {};
function bump(table, n = 1) { counters[table] = (counters[table] || 0) + n; }

async function putItem(table, item) {
  bump(table);
  if (ARGS.dryRun) return;
  await ddb.send(new PutCommand({ TableName: table, Item: item }));
}

// BatchWrite: 25개 단위 청크 (DynamoDB 한계). UnprocessedItems 재시도 포함.
async function batchPut(table, items) {
  for (let i = 0; i < items.length; i += 25) {
    const chunk = items.slice(i, i + 25);
    bump(table, chunk.length);
    if (ARGS.dryRun) continue;
    let requestItems = { [table]: chunk.map((Item) => ({ PutRequest: { Item } })) };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const out = await ddb.send(new BatchWriteCommand({ RequestItems: requestItems }));
      const unp = out.UnprocessedItems && out.UnprocessedItems[table];
      if (!unp || unp.length === 0) break;
      requestItems = out.UnprocessedItems;
      await new Promise((r) => setTimeout(r, 100 * (attempt + 1))); // 지수 백오프
    }
  }
}

// 값 정리: null/undefined/'' 속성은 항목에서 제거(DynamoDB 빈 문자열 회피 + 희소성)
function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === '') continue;
    out[k] = v;
  }
  return out;
}

function toEpochSeconds(iso) {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

// ── 메인 ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('─'.repeat(70));
  console.log(`SQLite → DynamoDB 마이그레이션 ${ARGS.dryRun ? '(DRY-RUN: 쓰기 없음)' : ''}`);
  console.log(`  db=${ARGS.db}`);
  console.log(`  대상 테이블 접두사=${ARGS.project}-${ARGS.env}-*  region=${ARGS.region}`);
  console.log(`  mock 조도 포함=${ARGS.includeMock}  TTL=${ARGS.ttlDays}일`);
  console.log('─'.repeat(70));

  const db = await openSqlite(ARGS.db);
  if (!ARGS.dryRun) {
    ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: ARGS.region }), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  // 1) users ─────────────────────────────────────────────────────────────────
  const userIdMap = {}; // 정수 id → "usr-<fitbit_user_id>"
  const users = query(db, 'SELECT * FROM users');
  for (const u of users) {
    const userId = `usr-${u.fitbit_user_id}`;
    userIdMap[u.id] = userId;
    await putItem(T('users'), clean({
      user_id: userId,
      fitbit_user_id: u.fitbit_user_id,
      display_name: u.display_name,
      created_at: u.created_at,
    }));
  }
  const mapUser = (oldId) => userIdMap[oldId] || `usr-legacy-${oldId}`;

  // 2) fitbit_tokens → fitbit-tokens-meta (메타데이터만; 토큰 본문은 임형택 Secrets Manager) ─
  const tokens = query(db, 'SELECT * FROM fitbit_tokens');
  for (const t of tokens) {
    await putItem(T('fitbit-tokens-meta'), clean({
      user_id: mapUser(t.user_id),
      // 토큰 본문(access/refresh)은 여기 저장하지 않는다 — 임형택이 Secrets Manager 에 생성.
      secret_arn: `PENDING:${ARGS.project}/${ARGS.env}/fitbit/${mapUser(t.user_id)}`,
      expires_at: t.expires_at,
      scope: t.scope,
      updated_at: t.updated_at,
    }));
  }

  // 3) sleep_sessions ──────────────────────────────────────────────────────────
  // sessionMap[정수 id] = { fitbitLogId, snapshot... } (리포트 비정규화용)
  const sessionMap = {};
  const sessions = query(db, 'SELECT * FROM sleep_sessions');
  const sessionItems = [];
  for (const s of sessions) {
    const sessionId = String(s.fitbit_log_id); // sleep-stages PK
    sessionMap[s.id] = {
      sessionId,
      date: s.date,
      snapshot: {
        fitbit_log_id: sessionId,
        date: s.date,
        start_time: s.start_time,
        end_time: s.end_time,
        duration_ms: s.duration_ms,
        minutes_asleep: s.minutes_asleep,
        minutes_awake: s.minutes_awake,
        time_in_bed: s.time_in_bed,
        efficiency: s.efficiency,
        is_main_sleep: s.is_main_sleep,
        sleep_type: s.sleep_type,
        stages: {}, // §4에서 단계 합산
      },
    };
    sessionItems.push(clean({
      user_id: mapUser(s.user_id),
      sk: `${s.date}#${sessionId}`,
      fitbit_log_id: sessionId,
      date: s.date,
      start_time: s.start_time,
      end_time: s.end_time,
      duration_ms: s.duration_ms,
      minutes_asleep: s.minutes_asleep,
      minutes_awake: s.minutes_awake,
      time_in_bed: s.time_in_bed,
      efficiency: s.efficiency,
      is_main_sleep: s.is_main_sleep,
      sleep_type: s.sleep_type,
      fetched_at: s.fetched_at,
    }));
  }
  await batchPut(T('sleep-sessions'), sessionItems);

  // 4) sleep_stages → sleep-stages (PK=session_id=fitbit_log_id, SK=stage) ──────
  const stages = query(db, 'SELECT * FROM sleep_stages');
  const stageItems = [];
  for (const st of stages) {
    const sess = sessionMap[st.session_id];
    if (!sess) continue; // 고아 행 스킵
    if (sess.snapshot.stages) sess.snapshot.stages[st.stage] = st.minutes;
    stageItems.push(clean({
      session_id: sess.sessionId,
      stage: st.stage,
      minutes: st.minutes,
      count: st.count,
      thirty_day_avg_minutes: st.thirty_day_avg_minutes,
    }));
  }
  await batchPut(T('sleep-stages'), stageItems);

  // 5) lighting_routines → lighting-routines (PK=routine_id, GSI by-user-date) ──
  const routineIdMap = {}; // 정수 id → "rtn-<id>"
  const routines = query(db, 'SELECT * FROM lighting_routines');
  const routineItems = [];
  for (const r of routines) {
    const routineId = `rtn-${r.id}`;
    routineIdMap[r.id] = routineId;
    routineItems.push(clean({
      routine_id: routineId,
      user_id: mapUser(r.user_id),
      routine_type: r.routine_type,
      scheduled_at: r.scheduled_at,
      started_at: r.started_at,
      completed_at: r.completed_at,
      success: r.success,
      notes: r.notes,
    }));
  }
  await batchPut(T('lighting-routines'), routineItems);
  const mapRoutine = (oldId) => (oldId == null ? null : routineIdMap[oldId] || `rtn-${oldId}`);

  // 6) routine_steps → routine-steps (PK=routine_id, SK=step_index) ─────────────
  const steps = query(db, 'SELECT * FROM routine_steps');
  const stepItems = [];
  for (const s of steps) {
    stepItems.push(clean({
      routine_id: mapRoutine(s.routine_id),
      step_index: s.step_index,
      brightness_pct: s.brightness_pct,
      executed_at: s.executed_at,
      success: s.success,
    }));
  }
  await batchPut(T('routine-steps'), stepItems);

  // 7) schedules → schedules (PK=user_id) ──────────────────────────────────────
  const schedules = query(db, 'SELECT * FROM schedules');
  for (const sc of schedules) {
    await putItem(T('schedules'), clean({
      user_id: mapUser(sc.user_id),
      sleep_time: sc.sleep_time,
      wake_time: sc.wake_time,
      sleep_offset_min: sc.sleep_offset_min,
      wake_offset_min: sc.wake_offset_min,
      enabled: sc.enabled,
      last_sleep_triggered: sc.last_sleep_triggered,
      last_wake_triggered: sc.last_wake_triggered,
      updated_at: sc.updated_at,
    }));
  }

  // 8) sleep_reports → sleep-reports (PK=user_id, SK=report_date, snapshot 비정규화) ─
  const reports = query(db, 'SELECT * FROM sleep_reports');
  const reportItems = [];
  for (const rep of reports) {
    const sess = sessionMap[rep.sleep_session_id];
    reportItems.push(clean({
      user_id: mapUser(rep.user_id),
      report_date: rep.report_date,
      sleep_session_snapshot: sess ? sess.snapshot : null, // JOIN 제거(§4.3.3)
      sleep_session_sk: sess ? `${sess.date}#${sess.sessionId}` : null,
      sleep_routine_id: mapRoutine(rep.sleep_routine_id),
      wake_routine_id: mapRoutine(rep.wake_routine_id),
      avg_illuminance_bedtime: rep.avg_illuminance_bedtime,
      avg_illuminance_wakeup: rep.avg_illuminance_wakeup,
      generated_at: rep.generated_at,
    }));
  }
  await batchPut(T('sleep-reports'), reportItems);

  // 9) illuminance_readings → illuminance-readings (+ illuminance-latest 파생) ───
  const mockClause = ARGS.includeMock ? '' : "WHERE source = 'sensor'";
  const readings = query(db, `SELECT * FROM illuminance_readings ${mockClause} ORDER BY recorded_at ASC`);
  const readingItems = [];
  const latestByDevice = {};
  for (const rd of readings) {
    const epoch = toEpochSeconds(rd.recorded_at);
    readingItems.push(clean({
      device_id: rd.device_id,
      recorded_at: rd.recorded_at,
      value: rd.value,
      raw: rd.raw,
      source: rd.source,
      stored_at: rd.stored_at,
      ttl: epoch != null ? epoch + ARGS.ttlDays * 86400 : null,
    }));
    // 최신값 캐시(디바이스별 마지막 1건) — recorded_at ASC 정렬이라 마지막이 최신
    latestByDevice[rd.device_id] = clean({
      device_id: rd.device_id,
      value: rd.value,
      raw: rd.raw,
      source: rd.source,
      recorded_at: rd.recorded_at,
      updated_at: rd.stored_at,
    });
  }
  await batchPut(T('illuminance-readings'), readingItems);
  for (const item of Object.values(latestByDevice)) {
    await putItem(T('illuminance-latest'), item);
  }

  // ── 요약 ───────────────────────────────────────────────────────────────────
  console.log('─'.repeat(70));
  console.log(ARGS.dryRun ? '쓰기 예정 항목 수 (DRY-RUN):' : '쓰기 완료 항목 수:');
  for (const [table, n] of Object.entries(counters)) {
    console.log(`  ${table.padEnd(40)} ${n}`);
  }
  console.log('─'.repeat(70));
  if (tokens.length > 0) {
    console.log('⚠️  fitbit-tokens-meta.secret_arn 은 PENDING 상태입니다.');
    console.log('    토큰 본문(access/refresh) → Secrets Manager 마이그레이션은 임형택(처리 레이어) 담당입니다.');
    console.log('    Secrets Manager 생성 후 secret_arn 을 실제 ARN 으로 업데이트하세요.');
  }
  console.log('완료.');
}

main().catch((err) => {
  console.error('마이그레이션 실패:', err);
  process.exit(1);
});
