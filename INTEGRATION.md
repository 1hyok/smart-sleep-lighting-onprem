# Smart Sleep Lighting — 엣지 노드 MQTT 인계 명세

본 엣지 노드는 라즈베리파이의 I2C 조도 센서(YL-40 / PCF8591 + LDR) 값을 노이즈 필터링한 뒤 Mosquitto MQTT 브로커로 발행하는 **단일 책임 애플리케이션**입니다. 본 문서는 백엔드 팀이 데이터를 구독(Subscribe)하고 디바이스 상태를 모니터링하기 위해 알아야 할 MQTT 인터페이스만을 정의합니다.

- **대상**: 백엔드 / 데이터 분석 서버 담당자
- **엣지 노드 IP**: `192.168.0.230` (RPi, hostname `cis6`)
- **MQTT 브로커**: Mosquitto, RPi `127.0.0.1:1883` (인증: `iot_user` / `iot_pass_2026`)

> ⚠️ **외부 접속 주의**: 현재 Mosquitto listener 가 `127.0.0.1` + `[::1]` 만 바인딩되어
> 있어, 백엔드가 다른 머신에서 직접 MQTT 로 붙으려면 RPi `mosquitto.conf` 에
> `listener 1883 0.0.0.0` 한 줄 추가 + 서비스 재시작이 필요합니다.

---

## 1. 한눈에 보는 구성

```
┌─────────────────────┐         MQTT 1883          ┌──────────────────────┐
│ 백엔드 / 분석 서버  │  ⇄  Mosquitto (RPi 내부) ⇄  │  엣지 노드 Node.js   │
│ (구독자)            │                            │  - I2C YL-40 (PCF8591)│
└─────────────────────┘                            └──────────────────────┘
                                                              │
                                                  발행  home/sensor/illuminance
                                                  발행  home/edge/status (LWT)
```

엣지 노드는 **MQTT publish 만으로** 외부 시스템과 통신합니다. 어떤 토픽도 구독하지 않으며, 수신 명령에 의한 부수 효과(조명 제어, 루틴 실행 등)는 일체 수행하지 않습니다.

---

## 2. MQTT 토픽 카탈로그

### 2.1 발행 (Edge → Subscribers)

| 토픽 | QoS | retain | 주기 | 페이로드 |
|---|---|---|---|---|
| `home/sensor/illuminance` | 1 | false | ~3s (env: `SENSOR_PUBLISH_INTERVAL_MS`) | [LuxReading](#31-luxreading) |
| `home/edge/status` | 1 | **true** | 접속/종료 시 + LWT | [DeviceStatus](#32-devicestatus) |

### 2.2 구독 (Subscribers → Edge)

**없음.** 엣지 노드는 어떤 토픽도 구독하지 않습니다.

---

## 3. 페이로드 스키마 (JSON)

### 3.1 LuxReading

`home/sensor/illuminance` 발행 페이로드.

```json
{
  "deviceId": "rpi-edge-bedroom-01",
  "value": 225.88,
  "raw": 198,
  "source": "sensor",
  "unit": "lux_estimate",
  "timestamp": "2026-04-26T11:00:08.999Z"
}
```

| 필드 | 타입 | 설명 |
|---|---|---|
| `deviceId` | string | MQTT clientId. 멀티 디바이스 식별. |
| `value` | number | 추정 조도값. **캘리브레이션 X — 진짜 lux 아님**. `unit` 참조. |
| `raw` | int \| null | PCF8591 8-bit ADC (0..255). `source=mock` 이면 null. |
| `source` | `"sensor"` \| `"mock"` | 실측/폴백 구분. 분석 서버는 mock 샘플 필터링/가중치 다르게. |
| `unit` | `"lux_estimate"` | 진짜 lux 가 아님 명시. |
| `timestamp` | ISO 8601 | UTC. Fitbit 등 외부 데이터와 시간축 정렬용. |

엣지 노드 내부에서 노이즈 필터링이 적용된 값입니다:
- **버스트 메디안**: 한 주기 내 5회 연속 read → 정렬 후 중앙값 채택 (스파이크 제거)
- **이동 평균**: 최근 5개 주기 평균 (잔여 노이즈 평활화)

### 3.2 DeviceStatus

`home/edge/status` 발행. **retain=true** — 새 구독자는 어느 시점에 붙어도 즉시 최신 상태 1건 수신.

```json
// 정상 접속 시
{ "deviceId": "rpi-edge-bedroom-01", "status": "online", "timestamp": "..." }

// 정상 종료 시 (graceful)
{ "deviceId": "rpi-edge-bedroom-01", "status": "offline", "timestamp": "...", "reason": "graceful_shutdown" }

// LWT 자동 발행 (브로커 keepalive 만료)
{ "deviceId": "rpi-edge-bedroom-01", "status": "offline", "timestamp": "...", "reason": "unexpected_disconnect" }
```

LWT 활용 가이드는 [§4](#4-lwt-활용--디바이스-가용성-즉시-판정) 참조.

---

## 4. LWT 활용 — 디바이스 가용성 즉시 판정

엣지 노드는 MQTT 연결 시 **LWT(Last Will & Testament)** 를 등록해 두기 때문에, 별도의 polling 없이 `home/edge/status` 한 토픽만 구독하면 디바이스 상태를 정확히 알 수 있습니다.

### 4.1 동작 원리

| 시점 | 발행자 | 페이로드 | retain |
|---|---|---|---|
| 정상 접속 | 엣지 | `{status:"online", ...}` | true |
| `client.end()` (graceful) | 엣지 | `{status:"offline", reason:"graceful_shutdown"}` | true |
| keepalive 만료 (전원/네트워크 단절) | **브로커가 자동** | `{status:"offline", reason:"unexpected_disconnect"}` | true |

retain=true 이므로:
- 백엔드가 **언제 붙어도 최신 상태 1건을 즉시** 받음 (별도 query 불필요).
- 새 메시지가 발행될 때마다 retained 메시지가 갱신됨.

### 4.2 백엔드 구현 예 (Node.js / mqtt.js)

```js
import mqtt from 'mqtt';

const client = mqtt.connect('mqtt://192.168.0.230:1883', {
  username: 'iot_user',
  password: 'iot_pass_2026',
});

const deviceState = new Map(); // deviceId → { status, since, reason }

client.on('connect', () => {
  client.subscribe('home/edge/status', { qos: 1 });
  client.subscribe('home/sensor/illuminance', { qos: 1 });
});

client.on('message', (topic, payload) => {
  const msg = JSON.parse(payload.toString());

  if (topic === 'home/edge/status') {
    deviceState.set(msg.deviceId, {
      status: msg.status,        // "online" | "offline"
      since: msg.timestamp,
      reason: msg.reason ?? null,
    });
    console.log(`[${msg.deviceId}] ${msg.status}` +
                (msg.reason ? ` (${msg.reason})` : ''));
  }

  if (topic === 'home/sensor/illuminance') {
    // msg.source === 'mock' 인 표본은 분석에서 제외하거나 가중치 낮춤 권장
    if (msg.source === 'sensor') {
      // ... DB 저장 / 분석 파이프라인
    }
  }
});

function isOnline(deviceId) {
  return deviceState.get(deviceId)?.status === 'online';
}
```

### 4.3 운영 팁

- **keepalive**: 기본 30초 적용 (인지 ~45초). `MQTT_KEEPALIVE_SEC` 로 override 가능.
  브로커는 1.5×keepalive 동안 패킷이 없으면 LWT 발동 (∴ 30 × 1.5 = ~45초).
- **graceful shutdown vs unexpected**: `reason` 필드로 구분 가능. 운영 모니터링에서
  `unexpected_disconnect` 가 잦으면 네트워크/전원 문제 시그널.
- **다중 디바이스**: 본 가이드는 `rpi-edge-bedroom-01` 단일 기준. 향후 여러 침실에 배포 시
  `deviceId` 별로 별도 키로 상태 관리.

---

## 5. 인증

- **현재**: Mosquitto `allow_anonymous=false`, `iot_user` / `iot_pass_2026` 단일 계정.
- **개선 권장**: 백엔드/프론트엔드 분리 시 토픽 별 ACL + 개별 계정.
  `mosquitto.conf` 에 `acl_file` 추가 + `mosquitto_passwd` 로 계정 분리.

---

## 6. 백엔드 합류 시 체크리스트

엣지 모듈은 검증 완료 상태이며, 백엔드가 들어올 때 다음만 확인하면 됩니다:

- [ ] **MQTT 외부 listener** — RPi `/etc/mosquitto/conf.d/auth.conf` 에 `listener 1883 0.0.0.0` 추가 후 `sudo systemctl restart mosquitto`
- [ ] **방화벽** — 현재 RPi 에는 ufw/iptables 미설치. 필요 시 1883 포트 명시 허용
- [ ] **시간 동기화** — 모든 컴포넌트가 NTP 동기화되어 있어야 timestamp 정렬 정확. RPi 는 RTC 가 없어 NTP 의존.
- [ ] **`deviceId` 합의** — 멀티 디바이스 확장 시 `MQTT_CLIENT_ID` 명명 규칙 (`rpi-edge-{room}-{seq}`) 통일

---

## 7. 디바이스 상태 빠른 진단

```bash
# MQTT 상태 (LWT retained 메시지 1건만 즉시 받음)
mosquitto_sub -h 192.168.0.230 -u iot_user -P iot_pass_2026 \
  -t home/edge/status -C 1 -v

# 실시간 조도 스트림 (Ctrl+C 로 종료)
mosquitto_sub -h 192.168.0.230 -u iot_user -P iot_pass_2026 \
  -t home/sensor/illuminance -v

# RPi 서비스 상태
ssh pi@192.168.0.230 'systemctl is-active mosquitto smart-sleep-edge'

# 엣지 노드 로컬 이벤트 로그 (최근 20건)
ssh pi@192.168.0.230 'tail -20 /home/pi/smart-sleep-lighting-onprem/service_log.jsonl | jq .'
```

---

## 변경 이력

| 날짜 | 변경 |
|---|---|
| 2026-04-26 | 초안 — 엣지 모듈 단독 검증 완료 시점 기준 |
| 2026-04-26 | 역할 경계 정리 — Express REST API / SSE / 대시보드 레이어 제거. MQTT 전용 가이드로 정리. |
| 2026-04-26 | R&R 정합화 — 비즈니스 로직(조명 제어/루틴/추천/스케줄링) 전부 백엔드 인계. 엣지 노드는 센서 발행 + 디바이스 상태(LWT) 두 토픽만 보유. |
| 2026-04-26 | 토픽명 변경 — `home/sensor/light` → `home/sensor/illuminance` (서비스 확장성: 추후 온/습도/모션 등 다른 센서 추가 시 의미 충돌 방지). 환경변수도 `TOPIC_SENSOR_LIGHT` → `TOPIC_SENSOR_ILLUMINANCE`. |
