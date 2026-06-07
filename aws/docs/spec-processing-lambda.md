# 인수인계 명세 — Processing + Service-API Layer (담당: 임형택)

> 보고서 §2.2(Fitbit Poller), §3(Lambda 비즈니스 로직), §5.1(API Gateway+Lambda), §6(Lambda IAM·Secrets·API 인증) 구현 명세.
> 작성: 이준혁. 본 스택은 **Storage Stack Export 를 Import** 한다.
> 산출물: `aws/layers/processing.yaml`(신규 SAM 스택) — Lambda 함수 + API Gateway + EventBridge + Secrets Manager.

---

## 0. Lambda 분해 (단일 책임 — 보고서 §1)

| Lambda | 대체하는 온프레미스 코드 | 트리거 | 주요 테이블(Import) |
|---|---|---|---|
| `fitbitPoller` | `fitbit/poller.js`+`client.js`+`auth.js` | EventBridge cron(매일 07:00 KST) | sleep-sessions, sleep-stages, users(GSI), fitbit-tokens-meta, Secrets |
| `generateReport` | `reports/generator.js` | **sleep-sessions DynamoDB Stream** | sleep-sessions, sleep-stages, illuminance-readings, lighting-routines(GSI), sleep-reports |
| `ingestSensor` (선택) | `pipeline/mqttSub.js` 조도 경로 | IoT Rule(정일혁) | illuminance-readings, illuminance-latest |
| `deviceStatus` | `pipeline/deviceStatusStore.js` | IoT Rule B(정일혁) | (Shadow 또는 device-status) |
| `apiHandler` | `server/index.js`+`routes/*` | API Gateway | 전 테이블 |
| `lightingCmd` | `services/scheduler.js`+`lightingExecutor.js` | EventBridge / API | lighting-routines, routine-steps, schedules + IoT Shadow(desired) |

> **ingestSensor 는 선택**: 정일혁의 IoT Rule 이 조도를 **DynamoDB 직접 쓰기**(Lambda 우회)로 처리하면
> `ingestSensor` 불필요(보고서 §4.2 비용 근거). ttl 계산 등 복잡 변환이 필요할 때만 Lambda 경유.

---

## 1. fitbitPoller Lambda (§2.2)

### 기존 로직 (실측, 그대로 이식)
- Fitbit Sleep API: **`GET /1.2/user/-/sleep/date/{date}.json`** (`client.js`).
- OAuth: Basic auth(`base64(clientId:clientSecret)`), TOKEN_URL `https://api.fitbit.com/oauth2/token`.
  - **proactive refresh**: `Date.now() >= expires_at - 5분` 이면 refresh_token grant 로 갱신, **refresh_token 도 회전**.
  - **401 시**: 1회 강제 refresh + 1회 재시도.
- scope(하드코딩): `sleep heartrate profile`.
- 동기화 날짜: **항상 어제**(`new Date().toISOString().slice(0,10)` UTC).
- 정규화(`persistSleepData`): `data.sleep[]` 각 항목 →
  - sleep-sessions: `fitbit_log_id=String(s.logId)`, date=`s.dateOfSleep`, start_time=`s.startTime`(로컬,TZ없음),
    end_time=`s.endTime`, duration_ms=`s.duration`, minutes_asleep/awake, time_in_bed, efficiency, is_main_sleep=`s.isMainSleep?1:0`, sleep_type=`s.type`.
  - sleep-stages: `s.levels.summary` 의 wake/light/deep/rem 각 `{minutes, count, thirtyDayAvgMinutes}`.
- 동기화 직후 `generateReport(userId, date)` 호출(온프레미스는 인라인) → 클라우드는 Stream 으로 분리(권장).

### 클라우드 변경
- **트리거**: EventBridge cron. node-cron `0 7 * * *`(서버 로컬)은 EventBridge(UTC)로 **`cron(0 22 * * ? *)`**(=07:00 KST). 6필드 `?` 주의.
- **토큰 저장**: `fitbit_tokens` 테이블 → **Secrets Manager**(§6). DynamoDB `fitbit-tokens-meta` 엔 메타(expires_at, scope, secret_arn)만.
- **HTTP**: Node18+ 글로벌 `fetch` 사용.
- **부팅 즉시 동기화**(다운타임 복구용): Lambda 엔 등가 없음 → 별도 백필 규칙/수동 invoke 로 대체.
- **idempotency**: `fitbit_log_id` UNIQUE → DynamoDB `sk=date#log` PutItem 으로 자연 멱등. (단, MOCK 의 `logId=Date.now()` 는 멱등 안 됨 — 운영선 실 logId 사용.)

### SAM 스켈레톤
```yaml
FitbitPollerFn:
  Type: AWS::Serverless::Function
  Properties:
    Handler: fitbitPoller.handler
    Runtime: nodejs20.x
    Environment:
      Variables:
        SESSIONS_TABLE:  !ImportValue smartsleep-storage-SleepSessionsTableName
        STAGES_TABLE:    !ImportValue smartsleep-storage-SleepStagesTableName
        USERS_TABLE:     !ImportValue smartsleep-storage-UsersTableName
        TOKENS_META_TABLE: !ImportValue smartsleep-storage-FitbitTokensMetaTableName
        FITBIT_APP_SECRET_ARN: !Ref FitbitAppSecret
    Policies:
      - DynamoDBCrudPolicy: { TableName: !ImportValue smartsleep-storage-SleepSessionsTableName }
      - DynamoDBCrudPolicy: { TableName: !ImportValue smartsleep-storage-SleepStagesTableName }
      - DynamoDBReadPolicy: { TableName: !ImportValue smartsleep-storage-UsersTableName }
      - DynamoDBCrudPolicy: { TableName: !ImportValue smartsleep-storage-FitbitTokensMetaTableName }
      - Statement:
          Effect: Allow
          Action: [secretsmanager:GetSecretValue, secretsmanager:PutSecretValue]
          Resource: !Sub 'arn:aws:secretsmanager:${AWS::Region}:${AWS::AccountId}:secret:smartsleep/${Env}/fitbit/*'
    Events:
      Daily:
        Type: Schedule
        Properties: { Schedule: 'cron(0 22 * * ? *)', Name: fitbit-daily-poll }  # 07:00 KST
```

---

## 2. generateReport Lambda (§3)

### 알고리즘 (실측, 상수 = 비즈니스 로직, 변경 금지)
1. 대상 세션: 해당 날짜 `is_main_sleep=1` 중 **`duration_ms` 최대** 1건.
2. **avg_illuminance_bedtime** = 조도 평균, window **[start_time − 30분, start_time]**.
3. **avg_illuminance_wakeup** = 조도 평균, window **[end_time − 15분, end_time + 15분]**.
4. 평균 = `AVG(value) WHERE source='sensor' AND recorded_at BETWEEN`(inclusive). DynamoDB 에선
   `illuminance-readings` 를 `device_id` + `recorded_at` 범위 **Query** 후 앱에서 평균(또는 Athena/Timestream).
5. 루틴 연결: 해당 날짜의 sleep/wake 루틴 id(`lighting-routines` GSI `by-user-date`).
6. upsert sleep-reports(PK=user_id, SK=report_date), `sleep_session_snapshot` 비정규화 포함.

> ⚠️ **보고서 §3 vs 코드 차이**: 보고서는 "MCAR 가정 **선형 보간**"이라 했으나 `generator.js` 는
> **보간하지 않는다** — 매칭 행 0건이면 `AVG`=NULL 저장. 마이그레이션 시 (a) 코드대로 NULL 유지(권장,
> 단순/정확) 하거나 (b) 보고서대로 짧은 결측 선형 보간을 신규 구현할지 결정. **0 을 기본값으로 넣지 말 것**(평균 왜곡).

> ⚠️ **TZ 버그**(이전부터 존재): Fitbit `start/end_time` 은 TZ 없는 로컬 문자열, `recorded_at` 은 UTC.
> Lambda 는 UTC 라 `new Date(localString)` 비교가 **어긋난다**. 마이그레이션 때 사용자 TZ(KST, +09:00)를
> 명시 적용해 양쪽을 UTC 로 정규화해 고칠 것.

- **트리거(권장)**: `sleep-sessions` **DynamoDB Stream**(Import `smartsleep-storage-SleepSessionsStreamArn`).
```yaml
GenerateReportFn:
  Type: AWS::Serverless::Function
  Properties:
    Handler: generateReport.handler
    Events:
      SessionStream:
        Type: DynamoDB
        Properties:
          Stream: !ImportValue smartsleep-storage-SleepSessionsStreamArn
          StartingPosition: LATEST
          BatchSize: 5
```

---

## 3. API Gateway + apiHandler (§5.1)

### 실제 엔드포인트 11개 (코드 기준 — 보고서의 `/api/v1` 와 다름!)
| # | METHOD PATH | 요청 | 응답 | 비고 |
|---|---|---|---|---|
| 1 | `GET /api/health` | — | `{status,uptime}` | |
| 2 | `GET /api/reports?date=YYYY-MM-DD` | query date 필수 | `{date,sleep{...}|null,lighting{...}}` | 400/404 |
| 3 | `GET /api/reports/recent?days=7` | days 1~90 | `[report]` (date DESC) | |
| 4 | `GET /api/illuminance/current` | — | `{deviceId,value,source,timestamp}` | latest 테이블 GetItem |
| 5 | `GET /api/illuminance/history?hours=24` | hours 1~168 | `{hours,count,data:[{deviceId,value,timestamp}]}` | Query |
| 6 | `POST /api/schedule` | `{sleepTime,wakeTime,sleepOffsetMin?=30,wakeOffsetMin?=15,enabled?}` | `{message,schedule}` | PutItem |
| 7 | `GET /api/schedule` | — | `{id,sleepTime,wakeTime,...}` | 404 |
| 8 | `DELETE /api/schedule` | — | `{message}` | |
| 9 | `GET /api/fitbit/status` | — | `{status,expiresAt?,lastSyncAt?,message}` | tokens-meta + sessions |
| 10 | `POST /api/lighting/routine` | `{type,steps?,scheduledAt?}` | `{success,routineId,message}` | ⚠️ 아래 |
| 11 | `GET /api/device/status` | — | `{devices:[...]}` | ⚠️ 현재 **미마운트(404)** |

> ⚠️ **#10 치명적 불일치**: 온프레미스는 `executeRoutine` 의 **15~30분 램프를 인라인 await** 한다.
> API Gateway 통합 타임아웃은 **29초**. 동기 Lambda 로 이식 불가. → apiHandler 는 (a) `lighting-routines`
> 행 생성 후 (b) Device Shadow `desired` 갱신(정일혁 §5) → **즉시 202 반환**. 실제 램프는 엣지/EventBridge.
> `routine_steps` 는 엣지 reported 또는 오케스트레이터가 기록.

> ⚠️ **#11**: `routes/device.js` 는 존재하나 `server/index.js` 가 `app.use('/api/device', ...)` 를
> **누락** → 현재 404. 이식 시 정상 마운트하거나 Shadow/presence 기반으로 재구현.

> ⚠️ **경로 버저닝**: 보고서는 `/api/v1/...`, 코드는 `/api/...`. 프론트(노원우)와 합의해 통일.
> 보고서가 언급한 `users/settings`, `recommendations`, `feedback` 엔드포인트는 **현재 코드에 없음**(후속 과제).

### 인증 (§6)
- 현재 인증 없음(단일 테넌트 `getPrimaryUserId()` 캐시). 수면/생활 데이터는 개인정보 → **Cognito User Pool 또는 JWT Authorizer** 도입.
- API Gateway 에서 토큰 검증 → Lambda 엔 검증된 `userId` 만 전달 → 각 핸들러는 `userId` 조건으로 자기 데이터만 조회(전역 캐시 제거).
- 내부 흐름(EventBridge Poller, IoT Rule)은 사용자 API 와 **분리**(별도 IAM).

### CORS
- 현재 `cors()` 와일드카드(`*`). → CloudFront 도메인 화이트리스트로 제한(노원우 §5.2.4 와 합의).

### SAM 스켈레톤
```yaml
Api:
  Type: AWS::Serverless::Api
  Properties:
    StageName: !Ref Env
    Cors: { AllowOrigin: "'https://<cloudfront-domain>'", AllowHeaders: "'Content-Type,Authorization'", AllowMethods: "'GET,POST,DELETE,OPTIONS'" }
    Auth: { DefaultAuthorizer: CognitoAuth, Authorizers: { CognitoAuth: { UserPoolArn: !GetAtt UserPool.Arn } } }
ApiHandlerFn:
  Type: AWS::Serverless::Function
  Properties:
    Handler: apiHandler.handler
    Environment:
      Variables:
        REPORTS_TABLE:    !ImportValue smartsleep-storage-SleepReportsTableName
        SESSIONS_TABLE:   !ImportValue smartsleep-storage-SleepSessionsTableName
        STAGES_TABLE:     !ImportValue smartsleep-storage-SleepStagesTableName
        ILLUM_TABLE:      !ImportValue smartsleep-storage-IlluminanceReadingsTableName
        ILLUM_LATEST_TABLE: !ImportValue smartsleep-storage-IlluminanceLatestTableName
        SCHEDULES_TABLE:  !ImportValue smartsleep-storage-SchedulesTableName
        ROUTINES_TABLE:   !ImportValue smartsleep-storage-LightingRoutinesTableName
    Events:
      ApiAny: { Type: Api, Properties: { RestApiId: !Ref Api, Path: /{proxy+}, Method: ANY } }
```

---

## 4. lightingCmd / 스케줄러 (EventBridge)

- 온프레미스 `scheduler.js`: **매분 tick**, `enabled=1` 스케줄마다 fire window `[target − offsetMin, target]`,
  dedupe `last_*_triggered ∈ [target−90s, target+60s]`. **offset 은 LEAD time**(23:00 취침+offset30 → 22:30 발화).
- 두 가지 클라우드 방식:
  - **(권장) POST /api/schedule 저장 시점에 다음 발생 시각 계산 → 사용자별 one-time EventBridge 스케줄 생성** (폴링 제거).
  - 또는 1분 EventBridge 규칙 → tick Lambda 재현(window/dedupe 로직 그대로).
- 시각은 **타임존 명시 필수**(EventBridge schedule timezone = `Asia/Seoul`), Lambda 는 UTC.
- 발화 시: `lighting-routines` 행 + Device Shadow desired 갱신(정일혁). GPIO 는 클라우드에서 직접 제어 금지.

---

## 5. Secrets Manager — Fitbit 토큰 (§6)

- **앱 자격증명 secret**(전역 1): `smartsleep/<env>/fitbit/app` = `{ client_id, client_secret }`.
- **사용자 토큰 secret**(사용자별): `smartsleep/<env>/fitbit/<user_id>` = `{ access_token, refresh_token, expires_at, scope }`.
- `fitbit-tokens-meta.secret_arn` 을 위 ARN 으로 갱신(마이그레이션 직후엔 `PENDING:...`).
- **⚠️ 교차 의존성(이준혁 → 임형택)**: `aws/migration/sqlite-to-dynamodb.js` 는 토큰 **본문을 옮기지 않는다**.
  토큰 본문의 Secrets Manager 적재 + `secret_arn` 업데이트는 **임형택 담당**. (기존 토큰 재사용하려면 `sleep.db` 의 `fitbit_tokens` 에서 1회 이전, 아니면 사용자 재인증.)
- KMS 암호화 + (선택) 자동 회전. Lambda 실행역할은 `secretsmanager:GetSecretValue`/`PutSecretValue` 를 자기 prefix 로 한정.

---

## 6. 교차 의존성 (Import/Export)
| 필요 값 | 출처 | 사용처 |
|---|---|---|
| 모든 테이블명/ARN | `smartsleep-storage-*TableName/Arn` (이준혁) | 전 Lambda |
| `SleepSessionsStreamArn` | `smartsleep-storage-SleepSessionsStreamArn` (이준혁) | generateReport |
| DeviceStatus Fn ARN | 본 스택이 **Export** `smartsleep-processing-DeviceStatusFnArn` | 정일혁 Rule B |
| API 도메인 | 본 스택 Output → 노원우 `VITE_API_BASE_URL` | 프론트 빌드 |

## 7. 완료 기준
- [ ] fitbitPoller: EventBridge 07:00 KST → sleep-sessions/stages 적재, 토큰 Secrets Manager 갱신
- [ ] generateReport: Stream 트리거 → sleep-reports upsert, **TZ 정규화** 적용, 결측 NULL 처리
- [ ] API: 11 엔드포인트 Lambda 이식, `/api` vs `/api/v1` 통일, #11 마운트, JWT 인증
- [ ] #10 lighting/routine 비동기화(202 + Shadow), 29초 타임아웃 회피
- [ ] 스케줄러 EventBridge 전환(타임존 명시)
- [ ] CORS 화이트리스트, Secrets/IAM 최소권한
