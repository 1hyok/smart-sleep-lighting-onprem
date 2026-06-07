# 클라우드 마이그레이션 통합 인수인계서 (취합: 이준혁)

> 프로젝트 3(온프레미스) → 프로젝트 5(AWS) 마이그레이션. 본 문서는 **전체 조율**용이며,
> 레이어별 상세는 각 `docs/spec-*.md` 참조. 산출물 형식: **AWS SAM**(레이어별 독립 스택).

---

## 1. 소유권 매트릭스

| 레이어 | 담당 | 보고서 절 | 산출물 | 상태 |
|---|---|---|---|---|
| Storage + Foundation | **이준혁** | §1, §4, §6 | `template.yaml`, `migration/`, `docs/01·04·06` | ✅ 완료 |
| Ingestion (IoT Core) | **정일혁** | §2.1, §6 | `layers/ingestion.yaml`, `src/ingestion/` (엣지 + 프로비저닝) | ✅ 구현 완료 |
| Processing + Service-API | 임형택 | §2.2, §3, §5.1, §6 | `layers/processing.yaml`, `src/processing/`, `samconfig-processing.toml` | ✅ 구현 완료 |
| Service-Frontend | 노원우 | §5.2, §6 | `layers/frontend.yaml`, `samconfig-frontend.toml`, `frontend/.env.production`, `.github/workflows/frontend-deploy.yml` | ✅ 구현 완료 |

## 2. 공통 규약 (모든 스택이 지킬 것)

| 규약 | 값 |
|---|---|
| 리전 | `ap-northeast-2` (Seoul) |
| ProjectName / Environment | `smartsleep` / `dev`(또는 `prod`) |
| 테이블명 | `<ProjectName>-<Environment>-<table>` (예: `smartsleep-dev-sleep-sessions`) |
| Storage 스택명 | `smartsleep-storage` → Export 접두사 `smartsleep-storage-*` |
| Processing 스택명 | `smartsleep-processing` → Export 접두사 `smartsleep-processing-*` |
| Import 방법 | `Fn::ImportValue: smartsleep-storage-<Key>` |

## 3. 배포 순서 (의존성 그래프)

```
        ┌──────────────────────────────┐
        │ [1] Storage (이준혁)          │  ← 먼저. 모두가 Import 하는 데이터 평면
        │  sam deploy (smartsleep-storage)
        └───────────────┬──────────────┘
        Export: *TableName/*TableArn, SleepSessionsStreamArn,
                IlluminanceReadings/LatestTable*
          ┌─────────────┼───────────────────────────┐
          ▼             ▼                             ▼
 ┌────────────────┐ ┌──────────────────────┐  (Frontend 는 Storage 직접 의존 없음)
 │[2a] Ingestion  │ │[2b] Processing        │
 │  (정일혁)      │ │  (임형택)             │
 │ IoT Rule→DDB   │ │ Lambda/API/Stream      │
 └───────┬────────┘ └──────────┬────────────┘
   needs: DeviceStatusFnArn ◀──┘ (Processing Export)
                     │ Export: API 도메인
                     ▼
              ┌──────────────────┐
              │[3] Frontend(노원우)│ ← API 도메인으로 빌드/배포
              └──────────────────┘
```

순환 의존 주의: 정일혁 Rule B 가 임형택 `DeviceStatusFnArn` 을 Import 한다.
→ 임형택이 DeviceStatus Lambda 를 **먼저 배포·Export** 하거나, 정일혁이 Shadow/presence 방식(추가 함수 불요)을 택한다(권장, `spec-ingestion-iot.md` §4).

## 4. 교차 팀 의존성 — Import/Export 표

| 소비자 | 필요 값 | 생산자(Export) |
|---|---|---|
| 정일혁 IoT Rule A | illuminance-readings/latest Name·Arn | 이준혁 `smartsleep-storage-IlluminanceReadings/Latest*` |
| 정일혁 IoT Rule B | DeviceStatus Fn ARN | 임형택 `smartsleep-processing-DeviceStatusFnArn` (또는 미사용) |
| 임형택 전 Lambda | 전 테이블 Name·Arn | 이준혁 `smartsleep-storage-*Table*` |
| 임형택 generateReport | Sessions Stream ARN | 이준혁 `smartsleep-storage-SleepSessionsStreamArn` |
| 임형택 fitbitPoller | (토큰 본문) Secrets | **임형택 자체 생성** — migration 은 메타만 |
| 노원우 빌드 | API 도메인 | 임형택 processing Output |
| 임형택 CORS | CloudFront 도메인 | 노원우 frontend Output |

### ⚠️ 가장 중요한 단일 의존성: Fitbit 토큰
`migration/sqlite-to-dynamodb.js` 는 `fitbit-tokens-meta` 에 **메타만** 넣고 `secret_arn=PENDING:...` 로 둔다.
**토큰 본문 → Secrets Manager 이전 + secret_arn 갱신은 임형택**(`spec-processing-lambda.md` §5). 미완 시 폴러가 인증 불가.

## 5. 보고서 ↔ 코드 차이 (마이그레이션 전 합의 필요)

| # | 보고서 | 코드 | 담당/조치 |
|---|---|---|---|
| 1 | DynamoDB 6개 | 실제 **10개** | 이준혁 — 10개로 확정(완료) |
| 2 | `/api/v1/...` | `/api/...` | 임형택·노원우 — 버저닝 통일 |
| 3 | endpoints 에 users/settings·recommendations·feedback | 코드에 없음 | 임형택 — 후속 과제로 분류 |
| 4 | 프론트 axios+withCredentials+HttpOnly쿠키 | `fetch`, 자격증명 없음 | 노원우 — 인증 도입 시 client.js+CORS |
| 5 | 결측치 MCAR 선형보간 | 보간 없음(NULL) | 임형택 — 코드 유지 권장 or 신규 구현 |
| 6 | 토픽 `iot/<thing>/illuminance` | `home/sensor/illuminance` | 정일혁 — ✅ `home/sensor/illuminance` 유지로 확정(엣지/IoT Rule/백엔드 계약 일치). 다중 디바이스 격리는 후속 |
| 7 | `GET /api/device/status` 정상 | 미마운트(404) | 임형택 — 마운트 or Shadow 재구현 |
| + | `lighting/routine` 동기 | 15~30분 인라인 await(API GW 29s 초과) | 임형택 — 202+Shadow 비동기화 |
| + | report TZ | Fitbit 로컬 vs UTC 비교 버그 | 임형택 — UTC 정규화 |

## 6. 온프레미스 → AWS 컴포넌트 대응 (전체)

| 온프레미스 | AWS | 담당 |
|---|---|---|
| Mosquitto(1883, user/pass) | IoT Core(8883, X.509 mTLS) | 정일혁 |
| `index.js`/`sensor.js`/`mqttClient.js`(엣지) | RPi 유지 + IoT SDK | 정일혁 |
| `gpio/light.js`(PWM 램프) | 엣지로 이동 + Device Shadow | 정일혁 |
| `pipeline/mqttSub.js`(조도 적재) | IoT Rule→DynamoDB 직접(또는 ingestSensor Lambda) | 정일혁/임형택 |
| `pipeline/deviceStatusStore.js`(인메모리) | Device Shadow / presence | 정일혁/임형택 |
| `fitbit/{auth,client,poller}.js` | fitbitPoller Lambda + EventBridge + Secrets | 임형택 |
| `reports/generator.js` | generateReport Lambda + DynamoDB Stream | 임형택 |
| `services/scheduler.js`(node-cron) | EventBridge Scheduler | 임형택 |
| `server/index.js`+`routes/*` | API Gateway + apiHandler Lambda | 임형택 |
| SQLite(`sql.js`/`better-sqlite3`)+`persist()` | DynamoDB 10 tables | **이준혁** |
| `backend/db/schema.sql` | `template.yaml` + `migration/` | **이준혁** |
| React/Vite SPA | S3 + CloudFront(OAC) | 노원우 |

## 7. 이준혁 파트 — 완료 산출물 (배포/사용법)
```bash
# (1) Storage 스택 배포
cd aws && sam validate --lint && sam build && sam deploy   # samconfig.toml 기본값 사용

# (2) 데이터 이전 (sleep.db 보유 머신에서)
cd aws/migration && npm install
node sqlite-to-dynamodb.js --db ../../backend/data/sleep.db --dry-run   # 확인
node sqlite-to-dynamodb.js --db ../../backend/data/sleep.db             # 적재
```
- 문서: `docs/01-architecture.md`(§1), `docs/04-dynamodb-design.md`(§4), `docs/06-cost-estimate.md`(§6).
- 10개 테이블, GSI 2개, Stream 1개, PITR 3개, TTL 1개. 전 Export 제공.

## 8. 미달성/한계 (보고서 §7 연계)
- 실제 AWS 배포·종단 부하 테스트 미수행(설계+부분 구현 중심).
- 추천 알고리즘은 단순 상관 규칙 한정(개인화 학습 후속 과제).
- 디바이스 보안은 인증서 파일 저장 수준(TPM/HSM 후속).
- 비용은 가정 기반 추정 → 실측 보정 필요(On-Demand→Provisioned 재평가).

## 9. 용어
- **Export/ImportValue**: CloudFormation 스택 간 값 공유(스택 A Output → 스택 B 참조).
- **PITR**: Point-In-Time Recovery, 35일 내 임의 시점 복원.
- **OAC**: Origin Access Control, CloudFront 만 S3 접근하도록 제한.
- **Device Shadow**: 디바이스 상태의 클라우드 측 desired/reported JSON 문서.
