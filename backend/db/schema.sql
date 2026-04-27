-- WAL 모드: 읽기/쓰기 동시성 향상, RPi SD 카드 환경에서 안전한 쓰기
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── 사용자 ─────────────────────────────────────────────────────────────────────
-- MVP는 단일 사용자(RPi 소유자)이지만, 다중 사용자 확장을 위해 user_id 키 보유
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  fitbit_user_id TEXT    UNIQUE NOT NULL,   -- Fitbit encodedId
  display_name   TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ── Fitbit OAuth 토큰 ──────────────────────────────────────────────────────────
-- user당 1행 (UNIQUE user_id). 만료 전 자동 갱신(refresh_token 사용).
CREATE TABLE IF NOT EXISTS fitbit_tokens (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  access_token  TEXT    NOT NULL,
  refresh_token TEXT    NOT NULL,
  expires_at    TEXT    NOT NULL,   -- ISO 8601 UTC
  scope         TEXT,
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ── Fitbit 수면 세션 ──────────────────────────────────────────────────────────
-- Fitbit API /1.2/user/-/sleep/date/{date} 응답의 sleep[] 배열 1건 = 1행
CREATE TABLE IF NOT EXISTS sleep_sessions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  fitbit_log_id  TEXT    UNIQUE NOT NULL,   -- Fitbit logId (중복 방지)
  date           TEXT    NOT NULL,          -- YYYY-MM-DD (dateOfSleep)
  start_time     TEXT    NOT NULL,          -- ISO 8601 (로컬 시각)
  end_time       TEXT    NOT NULL,          -- ISO 8601 (로컬 시각)
  duration_ms    INTEGER NOT NULL,          -- 총 침대 시간 (ms)
  minutes_asleep INTEGER,
  minutes_awake  INTEGER,
  time_in_bed    INTEGER,                   -- minutes
  efficiency     INTEGER,                   -- 0–100
  is_main_sleep  INTEGER NOT NULL DEFAULT 1,
  sleep_type     TEXT,                      -- 'stages' | 'classic'
  fetched_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sleep_sessions_user_date
  ON sleep_sessions(user_id, date);

-- ── 수면 단계별 요약 ───────────────────────────────────────────────────────────
-- sleep_sessions.levels.summary 의 4단계: wake / light / deep / rem
CREATE TABLE IF NOT EXISTS sleep_stages (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id             INTEGER NOT NULL REFERENCES sleep_sessions(id) ON DELETE CASCADE,
  stage                  TEXT    NOT NULL CHECK(stage IN ('wake','light','deep','rem')),
  minutes                INTEGER NOT NULL,
  count                  INTEGER,            -- 해당 단계 진입 횟수
  thirty_day_avg_minutes REAL,
  UNIQUE(session_id, stage)
);

-- ── IoT 조도 센서 데이터 ───────────────────────────────────────────────────────
-- MQTT home/sensor/illuminance 수신 데이터.
-- source='mock' 은 기본적으로 저장하지 않음 (config.pipeline.storeMockSensor).
CREATE TABLE IF NOT EXISTS illuminance_readings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   TEXT    NOT NULL,
  value       REAL    NOT NULL,   -- lux_estimate (0–1000)
  raw         INTEGER,            -- PCF8591 ADC 0–255, NULL이면 mock
  source      TEXT    NOT NULL CHECK(source IN ('sensor','mock')),
  recorded_at TEXT    NOT NULL,   -- 엣지 노드 timestamp (ISO 8601 UTC)
  stored_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_illuminance_recorded_at
  ON illuminance_readings(recorded_at);

-- ── 조명 루틴 실행 기록 ────────────────────────────────────────────────────────
-- 취침 소등(sleep) / 기상 점등(wake) 루틴 1회 실행 = 1행
-- 루틴 제어 로직은 이 테이블을 INSERT하며, 리포트/추천 로직이 이를 읽는다.
CREATE TABLE IF NOT EXISTS lighting_routines (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  routine_type TEXT    NOT NULL CHECK(routine_type IN ('sleep','wake')),
  scheduled_at TEXT    NOT NULL,   -- 예정 시작 시각 (ISO 8601)
  started_at   TEXT,               -- 실제 시작 시각
  completed_at TEXT,
  success      INTEGER NOT NULL DEFAULT 0,
  notes        TEXT
);

-- ── 루틴 단계별 밝기 기록 ─────────────────────────────────────────────────────
-- 루틴 1건당 N개 단계 (예: 100% → 80% → 50% → 20% → 0%)
CREATE TABLE IF NOT EXISTS routine_steps (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  routine_id     INTEGER NOT NULL REFERENCES lighting_routines(id) ON DELETE CASCADE,
  step_index     INTEGER NOT NULL,
  brightness_pct INTEGER NOT NULL CHECK(brightness_pct BETWEEN 0 AND 100),
  executed_at    TEXT    NOT NULL,
  success        INTEGER NOT NULL DEFAULT 1
);

-- ── 일일 수면 리포트 ───────────────────────────────────────────────────────────
-- 1일 1행. Fitbit 수면 + 조명 루틴 + 조도 집계를 연결하는 뷰 역할.
-- 조명 루틴 실행 여부가 수면 효율에 미치는 영향 분석에 활용.
CREATE TABLE IF NOT EXISTS sleep_reports (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id                  INTEGER NOT NULL REFERENCES users(id),
  report_date              TEXT    NOT NULL,   -- YYYY-MM-DD
  sleep_session_id         INTEGER REFERENCES sleep_sessions(id),
  sleep_routine_id         INTEGER REFERENCES lighting_routines(id),
  wake_routine_id          INTEGER REFERENCES lighting_routines(id),
  avg_illuminance_bedtime  REAL,   -- 취침 30분 전 평균 조도
  avg_illuminance_wakeup   REAL,   -- 기상 전후 15분 평균 조도
  generated_at             TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, report_date)
);
