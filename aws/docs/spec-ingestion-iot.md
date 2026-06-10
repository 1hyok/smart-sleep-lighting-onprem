# 인수인계 명세 — Ingestion Layer (담당: 정일혁)

> 보고서 §2.1(RPi → AWS IoT Core), §6(디바이스 IAM · 통신보안 · 모니터링) 구현 명세.
> 작성: 이준혁(아키텍처/DB). 본 스택은 **Storage Stack(`aws/template.yaml`)의 Export 를 Import** 한다.
> 산출물: `aws/layers/ingestion.yaml`(신규 SAM 스택) + 엣지 노드 코드 수정.

---

## 0. 한눈에 — 무엇을 만드나

1. RPi 엣지 노드를 **X.509 mTLS 로 AWS IoT Core 에 연결**(평문 1883 → 8883).
2. **IoT Thing + IoT Policy**(최소권한, 토픽을 자기 thing 으로 한정).
3. **IoT Rule 2개**: 조도 → DynamoDB 직접 쓰기(Lambda 우회, 비용↓), 상태 → 가용성 처리.
4. **Device Shadow** 기반 조명 명령 수신(엣지가 desired 구독 → 로컬 GPIO 램프 실행).
5. **CloudWatch** 디바이스 로깅/메트릭/알람 + LWT 기반 오프라인 감지.

---

## 1. 현재 엣지 코드 (실측) → 변경점

| 파일 | 현재 동작 | 클라우드 변경 |
|---|---|---|
| `mqttClient.js` | `mqtt://broker:1883`, `username`/`password`, `clean:true`, keepalive 30s, LWT, exp-backoff | `mqtts://<ats-endpoint>:8883` + `{key,cert,ca}` TLS, **user/pass 제거**, LWT/keepalive 유지 |
| `index.js` | 3초 주기 `publish(home/sensor/illuminance, {...}, {qos:1})` | 토픽/페이로드 유지(IoT Rule 친화). **clientId = Thing 이름** |
| `sensor.js` | PCF8591 burst median 5 + moving avg 5 → lux | **변경 없음**(1차 노이즈 필터는 엣지 유지, 보고서 §3) |
| `gpio/light.js`(현재 backend) | pigpio BCM18 PWM, SLEEP/WAKE 단계 램프 | **엣지로 이동** — Shadow desired 수신 후 로컬 실행(연결 끊겨도 동작) |

### 현재 발행 페이로드 (변경 금지 — IoT Rule SQL 이 이 필드를 참조)
```jsonc
// topic: home/sensor/illuminance  (QoS 1, retain false, 3초)
{ "deviceId":"rpi-edge-bedroom-01", "value":225.88, "raw":198,
  "source":"sensor"|"mock", "unit":"lux_estimate", "timestamp":"2026-04-26T11:00:08.999Z" }

// topic: home/edge/status  (QoS 1, retain TRUE, LWT)
{ "deviceId":"rpi-edge-bedroom-01", "status":"online"|"offline",
  "timestamp":"...", "reason":"graceful_shutdown"|"unexpected_disconnect" }
```
- `deviceId` = `config.mqtt.clientId`(= `MQTT_CLIENT_ID`, 규칙 `rpi-edge-{room}-{seq}`) = **IoT Thing 이름**으로 사용.
- LWT: `will.topic=home/edge/status`, payload `{status:offline,reason:unexpected_disconnect}`, qos1, retain true.

---

## 2. 디바이스 연결 — X.509 mTLS

1. IoT 콘솔/CLI 에서 Thing 등록(이름 = `rpi-edge-bedroom-01`), 디바이스 인증서+개인키 발급, Amazon Root CA 다운로드.
2. RPi `/etc/aws-iot/certs/` 에 `chmod 600` 저장. 일반 사용자 읽기 차단(보고서 §6).
3. `mqttClient.js` 연결 옵션 교체:
```js
const mqtt = require('mqtt');
const fs = require('fs');
const client = mqtt.connect(`mqtts://${process.env.AWS_IOT_ENDPOINT}:8883`, {
  clientId: config.mqtt.clientId,            // = Thing 이름 (유일)
  key:  fs.readFileSync(process.env.IOT_PRIVATE_KEY),
  cert: fs.readFileSync(process.env.IOT_CERT),
  ca:   fs.readFileSync(process.env.IOT_ROOT_CA),
  protocol: 'mqtts',
  clean: true, keepalive: 30, connectTimeout: 10000,
  will: { topic: config.topics.deviceStatus, qos: 1, retain: true,
          payload: buildStatusPayload('offline', { reason: 'unexpected_disconnect' }) },
});
```
- **신규 env**: `AWS_IOT_ENDPOINT`(`xxxx-ats.iot.ap-northeast-2.amazonaws.com`), `IOT_PRIVATE_KEY`, `IOT_CERT`, `IOT_ROOT_CA`.
- **제거 env**: `MQTT_USERNAME`, `MQTT_PASSWORD`, `MQTT_BROKER_URL`.
- ⚠️ `publish()` 는 미연결 시 메시지를 **드랍**한다(큐잉 없음). 무손실이 필요하면 로컬 store-and-forward 또는 Greengrass stream manager 검토(보고서 범위 밖, 선택).

---

## 3. IoT Policy (최소권한 — 보고서 §6)

`${iot:Connection.Thing.ThingName}` 변수로 **자기 토픽/Shadow 로만** 한정:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect":"Allow", "Action":"iot:Connect",
      "Resource":"arn:aws:iot:ap-northeast-2:<acct>:client/${iot:Connection.Thing.ThingName}" },
    { "Effect":"Allow", "Action":"iot:Publish",
      "Resource":[
        "arn:aws:iot:ap-northeast-2:<acct>:topic/home/sensor/illuminance",
        "arn:aws:iot:ap-northeast-2:<acct>:topic/home/edge/status",
        "arn:aws:iot:ap-northeast-2:<acct>:topic/$aws/things/${iot:Connection.Thing.ThingName}/shadow/*"
      ] },
    { "Effect":"Allow", "Action":["iot:Subscribe","iot:Receive"],
      "Resource":"arn:aws:iot:ap-northeast-2:<acct>:topicfilter/$aws/things/${iot:Connection.Thing.ThingName}/shadow/*" }
  ]
}
```
> 다중 디바이스 확장 시 토픽 네임스페이스를 `home/sensor/illuminance` → `iot/${thingName}/illuminance`
> 로 바꾸면(보고서 §2.1) 인증서 1개 유출이 타 디바이스에 영향 없음. **현재 코드는 단일 토픽**이므로
> 토픽 변경 시 엣지 발행 토픽 + IoT Rule SQL + 백엔드(임형택) 구독 모두 동기 변경 필요.

---

## 4. IoT Rules (Storage Stack Export 를 Import)

### Rule A — 조도 → DynamoDB 직접 쓰기 (Lambda 우회, 보고서 §4.2 비용 근거)
2개 DynamoDBv2 액션으로 `illuminance-readings` + `illuminance-latest` 동시 적재(이중 쓰기, §4.4):
```yaml
# aws/layers/ingestion.yaml (발췌)
IlluminanceRule:
  Type: AWS::IoT::TopicRule
  Properties:
    RuleName: smartsleep_illuminance_to_ddb
    TopicRulePayload:
      Sql: >-
        SELECT deviceId AS device_id, timestamp AS recorded_at, value, source, raw,
               (floor(timestamp() / 1000) + 2592000) AS ttl
        FROM 'home/sensor/illuminance' WHERE source = 'sensor'
      AwsIotSqlVersion: '2016-03-23'
      Actions:
        - DynamoDBv2:
            RoleArn: !GetAtt IotToDynamoRole.Arn
            PutItem: { TableName: !ImportValue smartsleep-storage-IlluminanceReadingsTableName }
        - DynamoDBv2:
            RoleArn: !GetAtt IotToDynamoRole.Arn
            PutItem: { TableName: !ImportValue smartsleep-storage-IlluminanceLatestTableName }
      ErrorAction:
        CloudwatchLogs: { LogGroupName: !Ref IngestErrorLog, RoleArn: !GetAtt IotErrorRole.Arn }
```
- `IotToDynamoRole`: `dynamodb:PutItem` 만, Resource = 두 테이블 ARN(`!ImportValue smartsleep-storage-IlluminanceReadingsTableArn` / `...-IlluminanceLatestTableArn`).
- `device_id`(PK), `recorded_at`(SK), `ttl`(epoch+30d), `value/source/raw` 컬럼 자동 매핑. `illuminance-latest` 는 `device_id` 만 PK 라 덮어쓰기.
- `WHERE source='sensor'` 로 mock 제외(보고서 §4.4, 코드 `STORE_MOCK_SENSOR=false` 동등).

### Rule B — 디바이스 상태 → 가용성 처리
```yaml
StatusRule:
  Properties:
    TopicRulePayload:
      Sql: "SELECT * FROM 'home/edge/status'"
      Actions:
        - Lambda: { FunctionArn: !ImportValue smartsleep-processing-DeviceStatusFnArn }  # 임형택 제공
```
> ⚠️ **결정 필요**: 온프레미스는 상태를 **인메모리 Map**(`deviceStatusStore.js`)에 보관 →
> `GET /api/device/status` 로 노출했다. Lambda 는 무상태라 Map 이 유지되지 않는다. 두 안 중 택1:
> - **(A 권장) Device Shadow `reported.status`** + IoT presence 라이프사이클 이벤트(`$aws/events/presence/*`) → 추가 테이블 불필요.
> - **(B) device-status 테이블** 신설(PK=device_id) → 이 경우 **이준혁에게 Storage Stack 에 테이블 추가 요청**.
> 본 명세는 (A)를 기본으로 권장. (B) 선택 시 Storage 스택 변경 PR 필요.

---

## 5. Device Shadow — 조명 명령 경로

온프레미스: `POST /api/lighting/routine` 또는 스케줄러 → `executeRoutine` 가 GPIO 를 **인라인 30분** 제어.
클라우드: **명령은 Shadow desired, 실행은 엣지 로컬**(연결 끊겨도 재접속 시 마지막 desired 동기화).

- **임형택(처리)**: 스케줄/요청 시 디바이스 Shadow `desired` 갱신 (예: `{ "routine":"sleep", "startAt":"...", "steps":[...] }` 또는 단순 `{ "brightness": 0 }`).
- **정일혁(엣지)**: `$aws/things/<thing>/shadow/update/delta` 구독 → `gpio/light.js`(엣지로 이전)로 SLEEP(80→60→40→20→0, ~30분) / WAKE(20→50→80→100, ~15분) 램프 로컬 실행 → `reported` 업데이트.
- 고빈도 조도는 Shadow 가 아닌 일반 토픽 유지(Shadow 비용/페이로드 한계 회피, 보고서 §2.1).

> 경계: **Lambda 가 desired 를 쓰는 부분 = 임형택**, **엣지가 delta 구독 + GPIO 실행 = 정일혁**.
> 단계 테이블(`SLEEP_STEPS`/`WAKE_STEPS`)과 `brightnessToPwm=round(pct/100*255)` 는 엣지에 유지.

---

## 6. 통신보안 · 모니터링 (보고서 §6)

- **통신보안**: 8883 TLS 전용, 평문 1883/익명 차단. RPi 는 Root CA 로 서버 검증 + 자기 인증서 제시 = mTLS. 인증서/키 `chmod 600`, 향후 TPM/HSM 고려.
- **인증서 수명주기**: Thing 당 다중 인증서 활성/비활성 가능하게 운영, 폐기 인증서 즉시 `INACTIVE`.
- **모니터링**: IoT Core 로깅 활성(연결 시도/인증 실패/Rule 실행 → CloudWatch Logs). 운영은 ERROR 이상만 수집, 디버깅 시 INFO 상향. CloudWatch Metrics(연결 수/메시지 수/Rule 실패율) + Alarm. LWT `status=offline` 을 Rule B → 일정시간 무수신 디바이스 식별.

---

## 7. 교차 의존성 (Import/Export)
| 필요 값 | 출처(Export) | 사용처 |
|---|---|---|
| illuminance-readings 테이블명/ARN | `smartsleep-storage-IlluminanceReadingsTableName/Arn` (이준혁) | Rule A |
| illuminance-latest 테이블명/ARN | `smartsleep-storage-IlluminanceLatestTableName/Arn` (이준혁) | Rule A |
| DeviceStatus Lambda ARN | `smartsleep-processing-DeviceStatusFnArn` (임형택) | Rule B |

## 8. 완료 기준 (체크리스트)
- [x] Thing/인증서/Policy 생성, RPi 가 8883 mTLS 로 연결(평문 1883 제거) — `provisioning/` + `edge/iotClient.js`
- [x] `home/sensor/illuminance` 발행 → `illuminance-readings` + `illuminance-latest` 에 적재 — `edge/index.js` + IoT Rule A
- [x] LWT/상태 토픽 → 오프라인 감지 — `edge/iotClient.js`(LWT) + IoT Rule B → CloudWatch
- [x] Shadow desired 갱신 시 엣지가 GPIO 램프 실행 + reported 갱신 — `edge/shadow.js` + `edge/light.js`
- [x] IoT Policy 가 자기 토픽/Shadow 로만 제한됨(최소권한) — `provisioning/iot-policy.json`
- [x] CloudWatch 로깅 구성 — `layers/ingestion.yaml`(로그 그룹 2종 + Rule 오류). 알람은 후속.
- [ ] (선택) 토픽 네임스페이스 `iot/<thing>/illuminance` 전환 — `home/sensor/illuminance` 유지로 확정(후속)

## 9. 구현 현황 (정일혁)

> ✅ **코드·IaC 구현 완료 + 로컬 dry-run 검증.** 실제 AWS 계정 배포·종단 시연은 시연 단계에서 수행.

**산출물**
- `aws/layers/ingestion.yaml` — IoT Rule A(조도→DynamoDB 이중 적재, `WHERE source='sensor'`),
  Rule B(상태→DeviceStatus Lambda[선택]+CloudWatch), 최소권한 IAM 2종, 로그 그룹 2종, Storage Export Import.
- `aws/samconfig-ingestion.toml` — `sam deploy --config-file samconfig-ingestion.toml --config-env ingestion`.
- `aws/src/ingestion/edge/` — 엣지 노드(mTLS 발행·LWT·지수백오프·Shadow·GPIO actuation·dry-run 폴백).
- `aws/src/ingestion/provisioning/` — 최소권한 IoT Policy + 멱등 프로비저닝/정리 스크립트.

**계약 정합 (본 명세 §1 준수)**
- 토픽 `home/sensor/illuminance`·`home/edge/status`, 페이로드 `{deviceId,value,raw,source,unit,timestamp}` /
  `{deviceId,status,timestamp,reason}` 그대로 구현 → IoT Rule SQL·DeviceStatus Lambda·DynamoDB 매핑과 일치.
- Rule B 는 `smartsleep-processing-DeviceStatusFnArn`(임형택) 을 `DeviceStatusFnArn` 파라미터로 연동 가능.

**해소한 결함** (프리뷰 구현 대비)
- Shadow `get` 재요청을 `once('connect')`→매 (재)연결 시 `onConnect()` 로 변경 → 런타임 재접속 시 누락 desired 복구 동작.
- `provision.sh` 인증서 발급 멱등화(기존 활성 인증서 재사용) → 재실행 시 고아 인증서 누적 제거(`FORCE_NEW_CERT` 로 로테이션).
- 조명 actuation 을 실제 GPIO 실행(`light.js`, SLEEP/WAKE 단계 램프)으로 구현 + reported 에 running/completed/cancelled 반영.
