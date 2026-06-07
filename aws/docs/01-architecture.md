# §1. 시스템 아키텍처 개요 (담당: 이준혁)

> 설계 보고서 §1 의 저장소 정본(canonical) 문서. **실제 코드 기준**으로 4-Layer ↔ AWS
> 매핑, 마이그레이션 동기, 서비스 선택 근거, 그리고 보고서와 코드의 차이를 정리한다.

---

## 1.1 전체 4-Layer 구조와 AWS 서비스 매핑

책임 흐름에 따라 **수집(Ingestion) → 처리(Processing) → 저장(Storage) → 서비스(Service)**
4계층으로 분리한다. 온프레미스(프로젝트 3)에서 단일 Raspberry Pi + 단일 Node 프로세스
(`backend/index.js` 가 MQTT 구독 · Express REST · node-cron 스케줄러 · Fitbit 폴러를 한꺼번에 기동)
에 집중돼 있던 책임을 계층별 매니지드 서비스로 분리한다.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ [1] INGESTION  (담당: 정일혁 / 임형택)                                         │
│                                                                                │
│   RPi 엣지노드(index.js,sensor.js)  ──MQTT/TLS,QoS1,X.509──▶  AWS IoT Core    │
│     home/sensor/illuminance (3s)                              · Rules Engine   │
│     home/edge/status (retain, LWT)                            · Device Shadow  │
│                                                                                │
│   Fitbit Web API  ──OAuth2──▶  fitbitPoller Lambda  ◀──cron(매일 07:00 KST)── │
│                                                        EventBridge Scheduler   │
├──────────────────────────────────────────────────────────────────────────────┤
│ [2] PROCESSING  (담당: 임형택)                                                 │
│   ingestSensor Lambda · generateReport Lambda · fitbitPoller · apiHandler     │
│   (IoT Rule / DynamoDB Stream / EventBridge / API GW 가 각각 트리거)          │
├──────────────────────────────────────────────────────────────────────────────┤
│ [3] STORAGE  ★담당: 이준혁 (본 스택 = aws/template.yaml)                       │
│   Amazon DynamoDB (10 tables)        AWS Secrets Manager (Fitbit 토큰 본문)    │
│   · 메타: users, fitbit-tokens-meta   Amazon S3 (선택: 30일 후 Parquet 아카이브)│
│   · 수면: sleep-sessions/stages/reports                                        │
│   · 루틴: lighting-routines/routine-steps/schedules                            │
│   · 시계열: illuminance-readings(TTL 30d) + illuminance-latest                 │
├──────────────────────────────────────────────────────────────────────────────┤
│ [4] SERVICE  (담당: 임형택 5.1 / 노원우 5.2)                                   │
│   API Gateway + apiHandler Lambda ─REST/JWT─┐   S3 + CloudFront (React SPA)    │
│                                              └──▶ 웹 대시보드 (frontend/dist)   │
└──────────────────────────────────────────────────────────────────────────────┘
   Storage 가 모든 상위/하위 레이어가 공유하는 단일 데이터 평면(data plane).
```

### 계층 책임 경계
- **Ingestion**: 원본 데이터를 클라우드 경계 안으로 들여오기만 한다. 의미 해석/비즈니스 규칙 없음.
- **Processing**: 원본을 도메인 단위(수면 세션, 조도 집계, 일일 리포트)로 가공. 전부 Lambda.
- **Storage**: 가공 결과 + 접근 패턴이 다른 원본(시계열)을 분리 보관. **본 문서/스택의 범위.**
- **Service**: 외부 클라이언트의 단일 진입점(API Gateway). 클라이언트는 IoT Core/DynamoDB 직접 접근 불가.

---

## 1.2 온프레미스 → 클라우드 마이그레이션 동기 (실제 구성 기준)

프로젝트 3 실측 구성:
- 엣지: `index.js`(루트) + `sensor.js`(PCF8591 I2C, burst median 5 + moving avg 5) + `mqttClient.js`
  → Mosquitto(`192.168.0.230:1883`, `iot_user`/`iot_pass_2026`, **평문 1883**)
- 백엔드: `backend/index.js` 단일 프로세스 = `mqttSub`(구독·저장) + Express(`:3001`, **`cors()` 와일드카드**)
  + `node-cron`(매분 tick 스케줄러 + 매일 07:00 Fitbit 폴러) + SQLite(`sql.js`/`better-sqlite3`, `persist()`)
- 프론트: React 19 + Vite SPA(`fetch`, `VITE_API_BASE_URL`, dev `:5173`)

| 항목 | 프로젝트 3 (온프레미스) | 프로젝트 5 (클라우드) |
|---|---|---|
| 가용성 | 단일 RPi — SD 손상/정전/단절 시 전체 중단 | IoT Core·Lambda·DynamoDB 다중 AZ 매니지드 |
| 보안 | Mosquitto user/pass, SQLite 평문, **CORS `*`** | X.509 mTLS, KMS 저장 암호화, IAM 최소권한, Secrets Manager, CORS 화이트리스트 |
| 확장성 | RPi CPU/SD IOPS 병목, 수직 한계 | Lambda 동시성 오토스케일, DynamoDB On-Demand |
| 운영성 | RPi 로컬 로그만, 원격 모니터링 부재 | CloudWatch Logs/Metrics/Alarm, IaC(SAM) 배포·롤백 |
| 비용 | HW 초기비 + 전력비 고정 | 사용량 과금, 단일 사용자는 Free Tier 내 ≈ $0 (§6) |

핵심 변화: 단일 프로세스의 동기 호출 흐름이 **비동기·이벤트 기반**(IoT Rule → Lambda,
DynamoDB Stream → Lambda, EventBridge → Lambda)으로 분해된다.

---

## 1.3 사용 AWS 서비스 목록 및 선택 근거

| 서비스 | 역할 | 선택 근거 | 담당 |
|---|---|---|---|
| **AWS IoT Core** | 디바이스 인증 + MQTT 브로커 | 과제 필수. X.509 인증·Shadow·Rules 를 매니지드 제공, 메시지 단위 과금 | 정일혁 |
| **AWS Lambda** | 센서 적재·Fitbit 폴링·리포트·API | 과제 필수. 단일 책임 함수 분리, 사용량 과금 | 임형택 |
| **Amazon DynamoDB** | 시계열·메타·리포트 저장 | 과제 필수(DBMS). 서버리스 친화, On-Demand 비용효율, IoT Rule 직접 쓰기 | **이준혁** |
| **Amazon API Gateway** | REST 단일 진입점 | 과제 필수(REST). Lambda 통합·JWT Authorizer·CORS | 임형택 |
| **Amazon EventBridge** | 폴러/스케줄 트리거 | node-cron 매분 폴링 제거, 정시 1회 발화 | 임형택 |
| **AWS Secrets Manager** | Fitbit OAuth 토큰 본문 | DynamoDB 평문 저장 부적절, KMS 암호화·회전 | 임형택 |
| **Amazon S3 + CloudFront** | 프론트 정적 호스팅 + CDN | SPA 정적 자산, EC2+Nginx 대비 비용·운영·지연 우위 | 노원우 |
| **AWS KMS** | 저장 암호화 | DynamoDB(AWS Owned Key, 무료) + Secrets Manager | 전원 |
| **Amazon CloudWatch** | 로그·메트릭·알람 | 통합 가시성 | 전원 |

---

## 1.4 레이어 소유권 · 스택 매트릭스

각 레이어는 **독립 CloudFormation/SAM 스택**으로 배포하고, Storage 스택의 Outputs(Export)를
`Fn::ImportValue` 로 참조한다. (단일 테이블 설계 대신 도메인 분리 → 부분 이전 가능, 보고서 §4.2)

| 스택(파일) | 레이어 | 담당 | 상태 |
|---|---|---|---|
| `aws/template.yaml` | Storage + Foundation | **이준혁** | ✅ 구현 완료 |
| `aws/migration/sqlite-to-dynamodb.js` | Storage 데이터 이전 | **이준혁** | ✅ 구현 완료 |
| `aws/layers/ingestion.yaml` (예정) | Ingestion (IoT Core) | 정일혁 | 📋 명세: `spec-ingestion-iot.md` |
| `aws/layers/processing.yaml` (예정) | Processing + Service-API | 임형택 | 📋 명세: `spec-processing-lambda.md` |
| `aws/layers/frontend.yaml` (예정) | Service-Frontend | 노원우 | 📋 명세: `spec-frontend-hosting.md` |

배포 순서: **Storage(이준혁) → Ingestion/Processing(병렬) → Frontend**.
(다른 스택이 Storage Export 를 Import 하므로 Storage 가 항상 선행.)

---

## 1.5 ⚠️ 설계 보고서 ↔ 실제 코드 차이 (통합 책임자 노트)

보고서는 설계 단계 문서라 현재 코드와 다음이 어긋난다. 마이그레이션 시 **코드 기준**으로 맞추거나
보고서대로 갱신할지 각 담당이 결정해야 한다. (상세 영향은 각 spec 문서에 재기재)

| # | 보고서 | 실제 코드 | 영향 담당 |
|---|---|---|---|
| 1 | DynamoDB "6개 테이블" | 설계 표는 실제 **10개** (메타 8 + 시계열 2) | 이준혁 (본 문서에서 10개로 확정) |
| 2 | API 경로 `/api/v1/...` | 실제 `/api/...` (v1 없음) | 임형택 |
| 3 | 엔드포인트 11개에 `users/settings`·`recommendations`·`feedback` 포함 | 실제 11개는 health·reports·reports/recent·illuminance/current·illuminance/history·schedule(GET/POST/DELETE)·fitbit/status·lighting/routine·device/status | 임형택 |
| 4 | 프론트 `axios` + `withCredentials:true` + HttpOnly 쿠키 | 실제 `fetch` 래퍼, **credentials 없음**, axios 미사용 | 노원우 |
| 5 | 결측치 MCAR **선형 보간** | `generator.js` 는 보간 없음 — 결측 시 `AVG`=NULL 저장 | 임형택 |
| 6 | MQTT 토픽 `iot/<thing>/illuminance` | 실제 `home/sensor/illuminance` (와일드카드 미적용) | 정일혁 |
| 7 | `GET /api/device/status` 정상 | 라우트 정의됐으나 `server/index.js` 에 **미마운트**(404) | 임형택 |

> 권장: 토픽 네임스페이스(#6), API 버저닝(#2)은 클라우드 전환 기회에 보고서 설계대로
> 정비하고, #4·#5 처럼 **코드가 더 단순/정확한 경우**는 보고서를 코드에 맞춰 정정한다.
