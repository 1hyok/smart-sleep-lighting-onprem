# SQLite → DynamoDB 마이그레이션 (담당: 이준혁)

온프레미스 `backend/data/sleep.db`(SQLite, 9개 테이블)의 기존 데이터를
클라우드 DynamoDB(10개 테이블)로 옮기는 **일회성** 스크립트입니다.
설계 보고서 §4(데이터 저장 레이어)의 매핑을 그대로 구현합니다.

## 선행 조건

1. **Storage Stack 배포 완료** — `aws/template.yaml` 이 먼저 배포되어 10개 테이블이 존재해야 합니다.
   ```bash
   cd aws && sam build && sam deploy
   ```
2. **원본 DB 확보** — `sleep.db` 는 `.gitignore` 대상(민감 데이터)이라 저장소에 없습니다.
   - 실데이터: RPi `/home/pi/smart-sleep-lighting-onprem/backend/data/sleep.db`
   - 또는 dev 검증용: `cd backend && npm run seed` 로 시드 후 `backend/data/sleep.db` 사용
3. **AWS 자격증명** — 표준 체인(`AWS_PROFILE`, 환경변수, SSO)에서 로드됩니다.

## 실행

```bash
cd aws/migration
npm install

# 1) 먼저 dry-run 으로 건수/변환 확인 (쓰기 없음)
node sqlite-to-dynamodb.js --db ../../backend/data/sleep.db --dry-run

# 2) 실제 적재
node sqlite-to-dynamodb.js --db ../../backend/data/sleep.db \
     --project smartsleep --env dev --region ap-northeast-2
```

### 옵션

| 플래그 | 기본값 | 설명 |
|---|---|---|
| `--db <path>` | `../../backend/data/sleep.db` | 원본 SQLite 경로 |
| `--project <name>` | `smartsleep` | 테이블명 접두사 (template.yaml 의 `ProjectName` 과 일치) |
| `--env <stage>` | `dev` | 테이블명 스테이지 (`Environment` 와 일치) |
| `--region <r>` | `ap-northeast-2` | 대상 리전 |
| `--ttl-days <n>` | `30` | illuminance-readings 의 `ttl` 계산 기준일 |
| `--include-mock` | (off) | `source='mock'` 조도 포함 (기본은 제외 — 분석 왜곡 방지, 보고서 §4.4) |
| `--dry-run` | (off) | 변환만 수행하고 DynamoDB 쓰기는 생략 |

## 키 변환 규약 (재실행 안전 / idempotent)

결정적(deterministic) ID를 써서 **여러 번 실행해도 같은 항목을 덮어쓸 뿐 중복이 쌓이지 않습니다.**

| 원본(SQLite) | 대상(DynamoDB) | 변환 |
|---|---|---|
| `users.id`(정수) | `users.user_id` | `usr-<fitbit_user_id>` |
| `lighting_routines.id`(정수) | `lighting-routines.routine_id` | `rtn-<legacy id>` |
| `sleep_sessions.fitbit_log_id` | `sleep-stages.session_id` | 그대로 (Fitbit logId = 전역 유일) |
| `sleep_sessions`(date+log) | `sleep-sessions.sk` | `<date>#<fitbit_log_id>` |
| `illuminance_readings.recorded_at` | `illuminance-readings.ttl` | `epoch(recorded_at) + ttlDays*86400` |

> 운영 단계에서 새로 생성되는 루틴은 설계상 **UUID v7**(임형택)로 발급됩니다.
> 위 `rtn-<id>` 규약은 **과거 데이터 이전**에만 적용되는 호환 키입니다.

## 테이블별 매핑 요약

- `users` → **users** (+ `fitbit-user-index` GSI 채움)
- `fitbit_tokens` → **fitbit-tokens-meta** (메타데이터만; 토큰 본문 제외)
- `sleep_sessions` → **sleep-sessions** (PK=user_id, SK=`date#log`)
- `sleep_stages` → **sleep-stages** (PK=session_id, SK=stage)
- `lighting_routines` → **lighting-routines**
- `routine_steps` → **routine-steps**
- `schedules` → **schedules**
- `sleep_reports` → **sleep-reports** (`sleep_session_snapshot` 비정규화)
- `illuminance_readings` → **illuminance-readings** + **illuminance-latest**(디바이스별 최신 1건 파생)

## ⚠️ 교차 팀 의존성 (중요)

`fitbit_tokens` 의 **access_token / refresh_token 본문은 이 스크립트가 옮기지 않습니다.**
DynamoDB `fitbit-tokens-meta.secret_arn` 은 `PENDING:...` 플레이스홀더로 기록됩니다.

→ 토큰 본문의 **Secrets Manager 이전 + secret_arn 업데이트**는
   **임형택(처리 레이어, 보안)** 담당입니다. `aws/docs/spec-processing-lambda.md` §보안 참조.

## 검증

```bash
aws dynamodb scan --table-name smartsleep-dev-sleep-reports --select COUNT --region ap-northeast-2
aws dynamodb get-item --table-name smartsleep-dev-illuminance-latest \
  --key '{"device_id":{"S":"rpi-edge-bedroom-01"}}' --region ap-northeast-2
```
