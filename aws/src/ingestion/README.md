# Ingestion Layer — 라즈베리파이 → AWS IoT Core (담당: 정일혁)

프로젝트 6 중 **수집 레이어**. 엣지(라즈베리파이)가 조도를 IoT Core 로 mTLS 발행하고,
IoT Rule 이 DynamoDB 에 직접 적재한다. 조명 명령은 Device Shadow 로 받아 엣지에서 GPIO 실행한다.

> 명세: [`aws/docs/spec-ingestion-iot.md`](../../docs/spec-ingestion-iot.md) · 전체 조율: [`aws/HANDOVER-cloud.md`](../../HANDOVER-cloud.md)

## 구성
```
aws/layers/ingestion.yaml          IoT Rule 2개 + IAM + CloudWatch (Storage Export Import)
aws/samconfig-ingestion.toml       SAM 배포 설정
aws/src/ingestion/
├── edge/                          라즈베리파이 엣지 노드 (Node.js)
│   ├── index.js                   진입점: 센서→발행 + Shadow 연결 + graceful shutdown
│   ├── iotClient.js               mqtts mTLS, QoS1 발행, LWT online/offline, 지수 백오프
│   ├── shadow.js                  Device Shadow delta 구독 → 조명 명령 수신 → reported
│   ├── light.js                   GPIO PWM actuation (SLEEP/WAKE 단계 램프)
│   ├── sensor.js                  YL-40(PCF8591) I2C 조도 + 노이즈필터 (프로젝트 3 재사용)
│   ├── config.js · logger.js · .env.example · package.json
└── provisioning/                  디바이스 자격증명 (CFN 아님 — 디바이스별)
    ├── iot-policy.json            최소권한 IoT Policy (정책 변수)
    ├── provision.sh               Thing/Policy/인증서 발급·attach·Root CA (멱등)
    └── teardown.sh                정리
```

## 데이터 흐름
```
[YL-40] --I2C--> sensor.js(메디안+이동평균) --> iotClient.js(mqtts 8883 mTLS, QoS1)
   --> home/sensor/illuminance ─┐
   --> home/edge/status (LWT)  ─┤
                                ▼  IoT Rule (ingestion.yaml)
   Rule A: home/sensor/illuminance, WHERE source='sensor'
           → DynamoDB illuminance-readings(이력) + illuminance-latest(최신)  [이준혁 테이블 Import]
   Rule B: home/edge/status → DeviceStatus Lambda(임형택, 선택) + CloudWatch 모니터링

[Lambda(임형택)] --Shadow desired(조명명령)--> shadow.js --> light.js GPIO 실행 --> reported
```

## 1. 로컬 dry-run (인증서·AWS 불필요)
```bash
cd aws/src/ingestion/edge
npm install
MOCK_IOT=true MOCK_SENSOR=true npm start
```
→ 부팅 → `status online` 발행 → 조도 주기 발행(QoS 1) → `Ctrl+C` 시 `status offline` 발행 후 종료.

## 2. 실제 AWS 연결
```bash
# (0) 선행: Storage 스택 배포 (illuminance 테이블 Export)
cd aws && sam deploy   # smartsleep-storage (이준혁)

# (1) 디바이스 프로비저닝: Thing/정책/인증서 → edge/certs/
cd src/ingestion/provisioning
./provision.sh                      # THING_NAME / AWS_REGION 오버라이드 가능
#   → 출력된 AWS_IOT_ENDPOINT 값 메모

# (2) IoT Rules + 모니터링 배포
cd ../../../                        # aws/
sam deploy --config-env ingestion
#   Rule B 를 임형택 DeviceStatus Lambda 로 연동하려면:
#   DeviceStatusFnArn=$(aws cloudformation describe-stacks --stack-name smartsleep-processing \
#     --query "Stacks[0].Outputs[?OutputKey=='DeviceStatusFnArn'].OutputValue" --output text)
#   sam deploy --config-env ingestion --parameter-overrides DeviceStatusFnArn=$DeviceStatusFnArn ...

# (3) 엣지 환경변수 + 실행
cd src/ingestion/edge
cp .env.example .env                # AWS_IOT_ENDPOINT, IOT_THING_NAME 설정, MOCK_* 비움
npm install && npm start            # 라즈베리파이 실센서: npm install i2c-bus pigpio
```

## 3. 시연 캡쳐 체크리스트
1. 로컬 dry-run 실행 로그 (online → 조도 발행 → SIGINT offline)
2. `provision.sh` 출력 (인증서 발급·attach·엔드포인트)
3. IoT 콘솔 MQTT 테스트: `home/sensor/illuminance` 실시간 메시지
4. IoT 콘솔 Security: 발급 인증서 + 최소권한 정책
5. DynamoDB `illuminance-readings` / `illuminance-latest` 적재 항목
6. CloudWatch `/smartsleep/dev/iot/device-status` 로그 (online/offline)
7. Device Shadow: desired 갱신 → 엣지 로그에 조명 루틴 실행 + reported 갱신

## 경계 (handoff contract)
- **발행 페이로드**: `home/sensor/illuminance` = `{ deviceId, value, raw, source, unit, timestamp }`
- **DynamoDB 매핑**: deviceId→device_id(PK), timestamp→recorded_at(SK), value/source/raw, ttl(+30d)
- **상태**: `home/edge/status` = `{ deviceId, status, timestamp, reason }` (LWT retain)
- **Device Shadow**: 백엔드(임형택)가 `desired` 작성 → 엣지가 GPIO 실행 후 `reported` 갱신
  - 지원 명령: `{ routine: "sleep"|"wake", steps? }` 또는 `{ brightness: 0..100 }`
