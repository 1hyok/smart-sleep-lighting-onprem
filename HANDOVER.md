# 스마트 수면 조명 — 팀 인수인계서

> **작성일**: 2026-04-27  
> **작성자**: 데이터 엔지니어링 파트 (이준혁)  
> **대상**: 백엔드 파트, 프론트엔드/시각화 파트

---

## 1. 완성된 레이어 현황

```
┌─────────────────────────────────────────────────────────────────┐
│                     전체 시스템 아키텍처                          │
│                                                                 │
│  [Fitbit 밴드]──────────────────────────────────────────────┐  │
│                                                             ▼  │
│  [RPi YL-40 조도 센서]                            [backend/]   │
│       │ I2C                                        데이터 파이  │
│       ▼                                            프라인       │
│  [엣지 노드 index.js]  ── MQTT publish ──▶  [mqttSub.js]      │
│   home/sensor/illuminance                   illuminance_readings│
│   home/edge/status                                  │          │
│                                            [fitbit/poller.js]  │
│                                             sleep_sessions      │
│                                             sleep_stages        │
│                                                  │             │
│                                         [reports/generator.js] │
│                                             sleep_reports       │
│                                                  │             │
│                          ┌───────────────────────┘             │
│                          ▼                                      │
│              ✅ SQLite DB (sleep.db) ── [백엔드가 읽음]          │
│                          │                                      │
│              [백엔드 REST API] ──────── [프론트엔드 대시보드]     │
│                          ▲                                      │
│          ← 이 선 아래가 백엔드/프론트엔드 구현 대상 →             │
└─────────────────────────────────────────────────────────────────┘
```

### 완료된 것 (건드리지 말 것)

| 레이어 | 위치 | 상태 |
|---|---|---|
| 엣지 노드 (조도 센서 → MQTT) | 루트 `index.js`, `sensor.js` | ✅ 완료 |
| MQTT 구독 → SQLite 저장 | `backend/pipeline/mqttSub.js` | ✅ 완료 |
| Fitbit OAuth 2.0 인증 | `backend/fitbit/auth.js` | ✅ 완료 |
| Fitbit 수면 데이터 폴링 | `backend/fitbit/poller.js` | ✅ 완료 |
| SQLite DB 스키마 (7개 테이블) | `backend/db/schema.sql` | ✅ 완료 |
| 일일 수면 리포트 생성 | `backend/reports/generator.js` | ✅ 완료 |

---

## 2. 저장소 구조

```
smart-sleep-lighting-onprem/
│
├── index.js                  # 엣지 노드 진입점 (RPi 실행)
├── sensor.js                 # YL-40 조도 센서 드라이버
├── mqttClient.js             # MQTT publish 클라이언트
├── config.js                 # 엣지 노드 설정
├── .env.example              # 엣지 노드 환경변수 예시
├── INTEGRATION.md            # MQTT 인터페이스 명세
│
└── backend/                  # 데이터 파이프라인 (이 파트 완성)
    ├── index.js              # 백엔드 데이터 레이어 진입점
    ├── config.js             # 백엔드 설정 (.env 참조)
    ├── .env.example          # 백엔드 환경변수 예시
    │
    ├── db/
    │   ├── schema.sql        # ★ DB 스키마 전체 정의
    │   └── db.js             # SQLite 연결 (Bun/Node.js 자동 감지)
    │
    ├── fitbit/
    │   ├── auth.js           # OAuth 초기 인증 스크립트 (1회 실행)
    │   ├── client.js         # Fitbit API HTTP 클라이언트
    │   ├── poller.js         # 수면 데이터 일별 동기화 (cron)
    │   └── mockData.js       # 개발용 mock 수면 데이터
    │
    ├── pipeline/
    │   └── mqttSub.js        # MQTT 조도 데이터 → DB
    │
    └── reports/
        └── generator.js      # 일일 수면 리포트 생성
```

---

## 3. DB 스키마 (백엔드/프론트엔드 필독)

SQLite 파일 위치: `backend/data/sleep.db` (RPi: `/home/pi/smart-sleep-lighting-onprem/backend/data/sleep.db`)

### 3.1 핵심 테이블 관계

```
users ──┬── fitbit_tokens       (1:1, 토큰 관리)
        ├── sleep_sessions ──── sleep_stages   (1:N, 수면 단계)
        ├── lighting_routines ── routine_steps  (1:N, 조명 단계)
        └── sleep_reports                       (일별 통합 뷰)

illuminance_readings  (MQTT 조도 데이터, users와 직접 연관 없음)
```

### 3.2 테이블별 주요 컬럼

**`sleep_sessions`** — Fitbit 수면 기록 (매일 poller가 채움)
```sql
fitbit_log_id   TEXT  -- Fitbit 고유 ID
date            TEXT  -- 'YYYY-MM-DD'
start_time      TEXT  -- '2026-04-26T23:00:00.000' (로컬 시각)
end_time        TEXT  -- '2026-04-27T07:15:00.000'
duration_ms     INT   -- 총 침대 시간 (ms)
minutes_asleep  INT
efficiency      INT   -- 0~100
is_main_sleep   INT   -- 1=메인 수면, 0=낮잠
```

**`sleep_stages`** — 수면 단계별 분포
```sql
session_id      INT   -- sleep_sessions.id FK
stage           TEXT  -- 'wake' | 'light' | 'deep' | 'rem'
minutes         INT
thirty_day_avg_minutes  REAL
```

**`illuminance_readings`** — 조도 센서 데이터 (실시간 누적)
```sql
device_id       TEXT  -- 'rpi-edge-bedroom-01'
value           REAL  -- lux_estimate (0~1000)
source          TEXT  -- 'sensor' | 'mock'
recorded_at     TEXT  -- ISO 8601 UTC (센서 타임스탬프)
```

**`lighting_routines`** — 조명 루틴 실행 기록 (백엔드가 INSERT)
```sql
user_id         INT
routine_type    TEXT  -- 'sleep' | 'wake'
scheduled_at    TEXT  -- 예정 시작 시각
started_at      TEXT  -- 실제 시작 시각
completed_at    TEXT
success         INT   -- 1=성공, 0=실패
```

**`routine_steps`** — 루틴 단계별 밝기 (백엔드가 INSERT)
```sql
routine_id      INT
step_index      INT   -- 0부터 시작
brightness_pct  INT   -- 0~100
executed_at     TEXT
```

**`sleep_reports`** — 일일 리포트 (자동 생성됨, 프론트엔드가 READ)
```sql
report_date              TEXT  -- 'YYYY-MM-DD'
sleep_session_id         INT   -- 해당 날짜 메인 수면 FK
sleep_routine_id         INT   -- 취침 조명 루틴 FK (백엔드가 채움)
wake_routine_id          INT   -- 기상 조명 루틴 FK (백엔드가 채움)
avg_illuminance_bedtime  REAL  -- 취침 전 30분 평균 조도
avg_illuminance_wakeup   REAL  -- 기상 전후 15분 평균 조도
```

---

## 4. 백엔드 팀 구현 대상

### 4.1 필수 구현 (MVP)

#### A. 조명 제어 API
RPi GPIO를 통한 조명 밝기 제어 로직 구현.

```
POST /api/lighting/routine
Body: { type: "sleep"|"wake", scheduledAt: "ISO8601", steps: [{brightness, delayMs}] }
→ lighting_routines + routine_steps 테이블에 INSERT
→ GPIO PWM으로 밝기 단계적 조절
```

#### B. 수면 루틴 스케줄러
사용자가 설정한 취침/기상 시각에 맞춰 자동으로 조명 루틴 실행.

```
POST /api/schedule
Body: { sleepTime: "23:00", wakeTime: "07:00" }
→ node-cron 또는 setInterval로 당일 스케줄 등록
→ 취침 30분 전부터 소등 시작, 기상 15분 전부터 점등 시작
```

#### C. 수면 리포트 조회 API
`sleep_reports` 테이블을 JOIN하여 리포트 반환.

```
GET /api/reports?date=YYYY-MM-DD
→ sleep_reports JOIN sleep_sessions JOIN sleep_stages 조회
→ 조도 데이터, 루틴 실행 여부 포함
```

#### D. Fitbit 연동 상태 API
```
GET /api/fitbit/status
→ fitbit_tokens 테이블 조회 → 토큰 있으면 connected, 없으면 not_connected
→ 마지막 동기화 시각 (sleep_sessions.fetched_at MAX) 반환
```

### 4.2 DB 접근 방법

`backend/db/db.js`의 `getDb()`를 import하면 바로 사용 가능:

```js
const { getDb } = require('./db/db');

// 최근 7일 수면 리포트 조회 예시
const reports = getDb().prepare(`
  SELECT r.report_date, s.minutes_asleep, s.efficiency,
         r.avg_illuminance_bedtime, r.avg_illuminance_wakeup,
         r.sleep_routine_id IS NOT NULL AS had_sleep_routine
  FROM sleep_reports r
  LEFT JOIN sleep_sessions s ON s.id = r.sleep_session_id
  WHERE r.user_id = 1
  ORDER BY r.report_date DESC
  LIMIT 7
`).all();
```

### 4.3 조명 루틴 기록 INSERT 예시

```js
const { getDb } = require('./db/db');

function logRoutineStart(userId, routineType, scheduledAt) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO lighting_routines (user_id, routine_type, scheduled_at, started_at, success)
    VALUES (?, ?, ?, datetime('now'), 0)
  `).run(userId, routineType, scheduledAt);
  return result.lastInsertRowid; // routine_id
}

function logRoutineStep(routineId, stepIndex, brightnessPct) {
  getDb().prepare(`
    INSERT INTO routine_steps (routine_id, step_index, brightness_pct, executed_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(routineId, stepIndex, brightnessPct);
}

function markRoutineComplete(routineId, success) {
  getDb().prepare(`
    UPDATE lighting_routines
    SET completed_at = datetime('now'), success = ?
    WHERE id = ?
  `).run(success ? 1 : 0, routineId);
}
```

### 4.4 환경 설정

```bash
cp backend/.env.example backend/.env
# .env 편집 후:
node backend/fitbit/auth.js   # 최초 1회 Fitbit OAuth 인증
node backend/index.js          # 데이터 파이프라인 기동
```

---

## 5. 프론트엔드 팀 구현 대상

### 5.1 필수 구현 (MVP)

#### A. 대시보드 메인 화면
- 오늘 수면 리포트 카드 (수면 시간, 효율, 수면 단계 비율)
- 조명 루틴 실행 여부 표시 (소등 루틴 / 점등 루틴)
- 취침/기상 시각 설정 입력

#### B. 조도 실시간 모니터링
- 현재 실내 조도 값 표시 (최근 `illuminance_readings` 1건)
- 시간대별 조도 변화 그래프 (지난 24시간)

#### C. 수면 히스토리 뷰
- 최근 7일/30일 수면 효율 트렌드
- 조명 루틴 사용일 vs 미사용일 수면 효율 비교

### 5.2 백엔드에 요청할 API 목록

프론트엔드는 아래 API가 백엔드로부터 제공되기를 기대합니다:

| 메서드 | 엔드포인트 | 설명 |
|---|---|---|
| `GET` | `/api/reports?date=YYYY-MM-DD` | 날짜별 수면 리포트 |
| `GET` | `/api/reports/recent?days=7` | 최근 N일 리포트 목록 |
| `GET` | `/api/illuminance/current` | 현재 조도 (최신 1건) |
| `GET` | `/api/illuminance/history?hours=24` | 시간대별 조도 이력 |
| `POST` | `/api/schedule` | 취침/기상 시각 설정 |
| `GET` | `/api/schedule` | 현재 스케줄 조회 |
| `GET` | `/api/fitbit/status` | Fitbit 연동 상태 |

### 5.3 리포트 데이터 예시 (백엔드 응답 형식 제안)

```json
{
  "date": "2026-04-26",
  "sleep": {
    "startTime": "2026-04-26T23:05:00.000",
    "endTime": "2026-04-27T07:12:00.000",
    "minutesAsleep": 365,
    "efficiency": 91,
    "stages": {
      "deep": 74,
      "rem": 85,
      "light": 188,
      "wake": 18
    }
  },
  "lighting": {
    "sleepRoutineExecuted": true,
    "wakeRoutineExecuted": true,
    "avgIlluminanceBedtime": 42.5,
    "avgIlluminanceWakeup": 310.8
  }
}
```

---

## 6. 로컬 개발 환경 실행 방법

### 엣지 노드 mock 실행 (조도 센서 없이)
```bash
# 루트 디렉터리에서
MOCK_SENSOR=true node index.js
# 또는
npm run dev
```

### 데이터 파이프라인 mock 실행 (Fitbit 없이)
```bash
cd backend
cp .env.example .env
# .env에서 MOCK_FITBIT=true, STORE_MOCK_SENSOR=true 설정
bun run dev          # Bun 환경
# 또는
node index.js        # Node.js 환경 (better-sqlite3 빌드 필요)
```

### 두 레이어 동시 실행 (로컬 full stack mock)
```bash
# 터미널 1 — 엣지 노드
MOCK_SENSOR=true node index.js

# 터미널 2 — 데이터 파이프라인
cd backend && MOCK_FITBIT=true STORE_MOCK_SENSOR=true bun run dev
```

---

## 7. 주요 설정값 및 연결 정보

| 항목 | 값 | 비고 |
|---|---|---|
| RPi IP | `192.168.0.230` | hostname: `cis6` |
| MQTT 브로커 | `192.168.0.230:1883` | RPi 내부 Mosquitto |
| MQTT 인증 | `iot_user` / `iot_pass_2026` | |
| 조도 MQTT 토픽 | `home/sensor/illuminance` | QoS 1 |
| 상태 MQTT 토픽 | `home/edge/status` | retain=true |
| SQLite 경로 (RPi) | `/home/pi/smart-sleep-lighting-onprem/backend/data/sleep.db` | |
| Fitbit 폴링 주기 | 매일 07:00 | `FITBIT_POLL_CRON` 환경변수로 변경 가능 |

---

## 8. 주의사항 및 제약

1. **mock 데이터 필터링**: `illuminance_readings.source = 'mock'` 인 데이터는 분석에서 제외하거나 가중치를 낮춰야 합니다. 기본적으로 파이프라인에서 저장하지 않도록 설정되어 있습니다(`STORE_MOCK_SENSOR=false`).

2. **Fitbit 시각 형식**: `sleep_sessions.start_time` / `end_time`은 Fitbit 로컬 시각 문자열(`2026-04-26T23:00:00.000`)입니다. UTC가 아닙니다. `illuminance_readings.recorded_at`은 UTC ISO 8601입니다. 시간대 비교 시 주의하세요.

3. **Fitbit 최초 인증**: 서버 기동 전 반드시 `node backend/fitbit/auth.js`를 실행하여 OAuth 토큰을 DB에 저장해야 합니다. 토큰 이후 만료 시 자동 갱신됩니다.

4. **lighting_routines 채움 주체**: 이 테이블은 **백엔드가 INSERT**해야 합니다. 수면 리포트 생성기(`reports/generator.js`)가 이 테이블을 참조하므로, 백엔드가 루틴 실행 후 반드시 기록을 남겨야 조도-루틴-수면 간 연관 분석이 가능합니다.

5. **단일 사용자 MVP**: `users` 테이블에는 Fitbit 인증된 사람 1명의 데이터만 있습니다. 백엔드 쿼리 시 `user_id = 1`로 고정해도 MVP에서는 무방합니다.

---

## 9. 참고 문서

| 문서 | 위치 | 내용 |
|---|---|---|
| MQTT 인터페이스 명세 | `INTEGRATION.md` | 토픽, 페이로드 스키마, 인증, LWT |
| DB 스키마 전체 | `backend/db/schema.sql` | 테이블 DDL, 인덱스, 제약 조건 |
| 백엔드 환경변수 | `backend/.env.example` | 전체 설정 항목 설명 포함 |
| Fitbit Web API 공식 문서 | https://dev.fitbit.com/build/reference/web-api/ | 수면: `/1.2/user/-/sleep/` |
