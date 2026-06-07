# §4. 데이터 저장 레이어 — DynamoDB 설계 (담당: 이준혁)

> 구현체: [`aws/template.yaml`](../template.yaml) · 데이터 이전: [`aws/migration/`](../migration/)
> 설계 보고서 §4 의 저장소 정본 문서. **실제 `backend/db/schema.sql` 컬럼 기준**으로 매핑한다.

---

## 4.1 프로젝트 3 SQLite 스키마 분석 (9개 테이블)

`backend/db/schema.sql` 실측. WAL 모드, FK ON. 각 테이블의 접근 패턴:

| 테이블 | 성격 | 쓰기 패턴 | 읽기 패턴 | 핵심 키/제약 |
|---|---|---|---|---|
| `users` | 메타 | 드물게 INSERT | id 단건 | `fitbit_user_id` UNIQUE |
| `fitbit_tokens` | 메타+비밀 | OAuth 갱신 UPDATE | Lambda 시작 시 단건 | `user_id` UNIQUE(1:1) |
| `sleep_sessions` | 트랜잭션 | 일 1~3 INSERT/UPSERT | user_id+date 범위 | `fitbit_log_id` UNIQUE |
| `sleep_stages` | 트랜잭션(1:N) | 세션당 4건 | session_id 기준 | UNIQUE(session_id,stage), CHECK in(wake,light,deep,rem) |
| `illuminance_readings` | **시계열(핫)** | **3초 주기, ~28,800건/일·디바이스** | recorded_at 범위 | 인덱스(recorded_at), dedup 없음 |
| `lighting_routines` | 트랜잭션 | 취침/기상 시 | user_id+date | CHECK in(sleep,wake) |
| `routine_steps` | 트랜잭션(1:N) | 루틴당 4~5건 | routine_id 기준 | — |
| `schedules` | 메타 | UPSERT | user_id 단건 | `user_id` UNIQUE |
| `sleep_reports` | 집계 | 일 1 UPSERT | user_id+date (가장 빈번) | UNIQUE(user_id,report_date) |

**두 가지 분기**: (1) `illuminance_readings` 는 쓰기 트래픽 압도적·JOIN 없는 시계열,
(2) 나머지 8개는 쓰기 빈도 낮고 user_id/date 로 묶이는 관계형.

---

## 4.2 저장소 후보 비교 — 결론: DynamoDB 단일

| 기준 | DynamoDB | Aurora Serverless v2 | 하이브리드 |
|---|---|---|---|
| Lambda 친화성 | 우수(가벼움, IoT Rule 직접 쓰기) | RDS Proxy 필요(커넥션 고갈) | 혼합 |
| 시계열 쓰기 | On-Demand 오토스케일 | 쓰기 ACU 비용 급증 | DynamoDB 로 분리 |
| 관계 보존 | JOIN 없음 → 비정규화 | SQL JOIN 그대로 | 메타만 Aurora |
| 월 비용(학기 단일) | ≈ $0 (Free Tier) | **0.5 ACU 가동만 월 $40+** | Aurora 만큼 증가 |
| 운영 복잡도 | 낮음(매니지드) | 낮음~중 | **높음(2저장소 일관성)** |

**DynamoDB 단일 채택 근거**: ① 학기 비용 한도 내 24h 가동 가능한 유일안,
② IoT Rule → DynamoDB 직접 쓰기로 최고 트래픽(illuminance) 경로에서 Lambda 우회,
③ 기존 JOIN(리포트 조회 시 sessions+stages)은 비정규화로 대체 가능.

**단일 테이블 설계(single-table)는 채택하지 않음** — 후속 확장(추천 알고리즘, 권한 모델)이
예상되어 도메인 경계가 뚜렷한 테이블을 분리. 향후 일부 도메인만 Aurora/OpenSearch 로 부분 이전 가능.

---

## 4.3 DynamoDB 테이블 설계 (10개)

> 📌 **보고서 "6개" 정정**: 보고서 §4.3 본문은 "6개"라 적었으나 실제 설계 표는
> 메타/수면/루틴 8개 + 시계열 2개 = **총 10개 테이블**이다. 본 문서와 `template.yaml` 은 10개로 확정한다.

공통 운영 정책(§4.5): 모든 테이블 **On-Demand(PAY_PER_REQUEST)**, **AWS Owned Key** 저장 암호화(무료).
테이블명 규칙: `<ProjectName>-<Environment>-<table>` (예: `smartsleep-dev-users`).

### 4.3.1 users
| 속성 | 타입 | 역할 |
|---|---|---|
| `user_id` (PK) | S | `usr-<fitbit_user_id>`. 정수 `users.id` 대체 |
| `fitbit_user_id` | S | Fitbit encodedId. **GSI `fitbit-user-index`** PK |
| `display_name` | S | 표시명 |
| `created_at` | S | ISO 8601 UTC |

**GSI `fitbit-user-index`** (PK=`fitbit_user_id`, Projection ALL): Fitbit OAuth 콜백에서 encodedId → user_id 역조회.

### 4.3.2 fitbit-tokens-meta
토큰 **본문은 Secrets Manager(임형택)**, DynamoDB 엔 메타만. 권한 분리(메타 읽기 vs Secrets 읽기)로 누출 피해 축소.

| 속성 | 타입 | 역할 |
|---|---|---|
| `user_id` (PK) | S | FK |
| `secret_arn` | S | Secrets Manager 토큰 ARN (이전 직후 `PENDING:...`) |
| `expires_at` | S | 액세스 토큰 만료 시각 |
| `scope` | S | OAuth scope (`sleep heartrate profile`) |
| `updated_at` | S | 마지막 갱신 |

### 4.3.3 sleep-sessions / sleep-stages / sleep-reports

| 테이블 | PK | SK | 주요 속성 | 접근 패턴 |
|---|---|---|---|---|
| **sleep-sessions** | `user_id` | `sk` = `<date>#<fitbit_log_id>` | start_time,end_time,duration_ms,minutes_asleep,minutes_awake,time_in_bed,efficiency,is_main_sleep,sleep_type,fetched_at | 적재(fitbitPoller), 리포트 생성 시 조회. 최근 N일 = Query + `begins_with(sk, date)` 정렬 |
| **sleep-stages** | `session_id` (=fitbit_log_id) | `stage` | minutes,count,thirty_day_avg_minutes | 세션 1회 Query |
| **sleep-reports** | `user_id` | `report_date` | `sleep_session_snapshot`,sleep_routine_id,wake_routine_id,avg_illuminance_bedtime,avg_illuminance_wakeup,generated_at | `GET /api/reports` 주 소스 |

- **sleep-sessions** 에 `StreamSpecification: NEW_AND_OLD_IMAGES` + **PITR**.
  신규 세션 적재 → `generateReportLambda`(임형택) 비동기 트리거(§4.5).
- **sleep-stages PK = 부모 세션의 `fitbit_log_id`**. Fitbit logId 가 전역 유일하므로 안정적 링크.
- **sleep-reports** 는 `sleep_session_snapshot` 으로 세션·단계 통계(efficiency, minutes_asleep,
  stages 요약)를 **비정규화** → 리포트 조회 시 단일 GetItem(JOIN 제거). **PITR** 적용.

### 4.3.4 lighting-routines / routine-steps / schedules

| 테이블 | PK | SK | GSI | 비고 |
|---|---|---|---|---|
| **lighting-routines** | `routine_id`(UUID v7) | — | `by-user-date`(user_id, scheduled_at) | 일일 리포트 시 사용자·일자 조회 |
| **routine-steps** | `routine_id` | `step_index`(N) | — | 루틴당 4~5단계 단일 Query |
| **schedules** | `user_id` | — | — | MVP 사용자당 1 스케줄, PutItem 갱신, **PITR** |

`schedules` 속성: sleep_time, wake_time, sleep_offset_min(기본 30), wake_offset_min(기본 15),
enabled, last_sleep_triggered, last_wake_triggered, updated_at.
`routine_id` 운영 신규는 **UUID v7**(시각 순서 보존), 과거 이전분은 `rtn-<legacy id>`.

---

## 4.4 시계열 — illuminance 저장 전략 (이중 쓰기)

디바이스 1대 3초 주기 → 일 ~28,800건 / 월 ~864,000건. **핫 테이블 + 최신값 캐시** 분리:

| 테이블 | PK | SK | 보존 | 용도 |
|---|---|---|---|---|
| **illuminance-readings** | `device_id` | `recorded_at`(ISO) | 30일 TTL 자동 삭제 | 시간 범위 조회 `GET /api/illuminance/history` |
| **illuminance-latest** | `device_id` | — (단일 항목) | 영구 | 최신 1건 즉시 `GET /api/illuminance/current` |

- `ingestSensorLambda`(또는 IoT Rule)가 **두 테이블 동시 쓰기**. `illuminance-latest` 는 같은
  `device_id` 덮어쓰기라 항목 수 무관 → "현재 조도" 위젯이 시계열 Query 없이 GetItem 1회.
- **핫 파티션**: 1대 환경은 단일 파티션 집중이나 WCU 1,000/s 한도가 3초 주기 대비 충분. 100대+로
  확장되면 device_id 분포가 자연 분산 → 별도 샤딩 키 불필요.
- `illuminance-readings` 속성: value(REAL), raw(0~255 또는 null=mock), source(sensor|mock),
  stored_at, **`ttl`**(epoch s = recorded_at + 30일). PITR **미적용**(TTL 삭제 → 복원 가치 낮음, 비용 절감).
- **장기 보관(선택)**: 일 1회 EventBridge → `archiveLambda` 가 어제 데이터를 Parquet 변환 후 S3 적재
  (DynamoDB 대비 ~1/20 비용, Athena 추세 분석 기반). **학기 범위에서는 선택적 구현.**

> ⚠️ 코드 차이: `mqttSub.js` 의 illuminance 적재엔 **dedup 키가 없다**(append-only). IoT/Lambda
> at-least-once 전달에서 중복 적재 가능 → 정확도가 중요하면 `(device_id, recorded_at)` 가
> 그대로 PK+SK 라 DynamoDB 에서는 **자연 idempotent** 가 된다(같은 키 덮어쓰기). 온프레미스보다 개선됨.

---

## 4.5 운영 정책 (`template.yaml` 에 반영)

| 정책 | 적용 대상 | 구현 |
|---|---|---|
| On-Demand 용량 | 전 테이블 | `BillingMode: PAY_PER_REQUEST` |
| PITR(35일 복원) | sleep-sessions, sleep-reports, schedules | `PointInTimeRecoverySpecification` |
| TTL 자연 삭제 | illuminance-readings(30일) | `TimeToLiveSpecification(ttl)` |
| KMS 저장 암호화 | 전 테이블 | AWS Owned Key 기본(SSESpec 미지정 = 무료). CMK 미적용(키 관리비 대비 가치 낮음) |
| Streams | sleep-sessions 만 | `NEW_AND_OLD_IMAGES` → generateReportLambda |
| 삭제 보호 | 메타/수면/루틴 8개 | `DeletionPolicy: Retain`(실데이터 보호). illuminance 2개는 `Delete`(재구성 가능) |

> **Teardown 주의**: Retain 정책 때문에 `sam delete` 후에도 8개 테이블은 남는다.
> 완전 삭제 시 콘솔/CLI 로 수동 삭제하거나 템플릿에서 DeletionPolicy 를 일시 변경 후 재배포.

---

## 4.6 SQLite → DynamoDB 키 매핑 한눈에

| SQLite | DynamoDB | PK | SK | 비고 |
|---|---|---|---|---|
| users | users | user_id=`usr-<fitbit_user_id>` | — | +GSI |
| fitbit_tokens | fitbit-tokens-meta | user_id | — | 본문 제외 |
| sleep_sessions | sleep-sessions | user_id | `date#log` | Stream+PITR |
| sleep_stages | sleep-stages | session_id=`fitbit_log_id` | stage | — |
| sleep_reports | sleep-reports | user_id | report_date | snapshot 비정규화, PITR |
| lighting_routines | lighting-routines | routine_id | — | +GSI by-user-date |
| routine_steps | routine-steps | routine_id | step_index | — |
| schedules | schedules | user_id | — | PITR |
| illuminance_readings | illuminance-readings (+latest) | device_id | recorded_at | TTL 30d |

이전 절차/옵션: [`aws/migration/README.md`](../migration/README.md).
