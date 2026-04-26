# Smart Sleep Lighting — 엣지 노드 MQTT 연동 가이드

본 모듈은 라즈베리파이 기반 엣지 노드로, **하드웨어(I2C YL-40 / GPIO RGB PWM) 와 Mosquitto MQTT 브로커 사이의 통신만** 담당합니다. 백엔드/분석 서버가 본 노드와 연동할 때 필요한 MQTT 인터페이스를 정리합니다.

- **대상**: 백엔드, 데이터 분석 서버 담당자
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
│ (Fitbit 분석 등)    │                            │  - I2C YL-40         │
└─────────────────────┘                            │  - GPIO RGB PWM      │
                                                   └──────────────────────┘
                                                              │
                                                  발행  home/sensor/light
                                                  발행  home/edge/status (LWT)
                                                  발행  home/bedroom/routine_suggestion
                                                  구독  home/bedroom/light/control
                                                  구독  routine/sleep, routine/wakeup
```

엣지 노드는 **MQTT 만으로** 외부 시스템과 통신합니다. REST API / 대시보드 / 사용자 인증 등 사용자 대면 표면은 백엔드/프론트 팀의 책임 범위입니다.

---

## 2. MQTT 토픽 카탈로그

### 2.1 발행 (Edge → Subscribers)

| 토픽 | QoS | retain | 주기 | 페이로드 |
|---|---|---|---|---|
| `home/sensor/light` | 1 | false | ~3s (env: `SENSOR_PUBLISH_INTERVAL_MS`) | [LuxReading](#31-luxreading) |
| `home/edge/status` | 1 | **true** | 상태 변경 시 + LWT | [DeviceStatus](#32-devicestatus) |
| `home/bedroom/routine_suggestion` | 1 | false | 조도 임계 전이 시 | [RoutineSuggestion](#33-routinesuggestion) |

### 2.2 구독 (Subscribers → Edge)

| 토픽 | 페이로드 | 동작 |
|---|---|---|
| `home/bedroom/light/control` | [LightControl](#34-lightcontrol) | RGB/preset/밝기/ON-OFF 제어 |
| `routine/sleep` | [RoutineCommand](#35-routinecommand) | 취침 루틴 시작 또는 `"cancel"` |
| `routine/wakeup` | [RoutineCommand](#35-routinecommand) | 기상 루틴 시작 또는 `"cancel"` |

> 모든 외부 발행은 **QoS 1 권장**. 엣지 측 구독자도 QoS 1 로 등록되어 있어
> 잠시 끊겨도 브로커에서 한 번 재전달됩니다.

---

## 3. 페이로드 스키마 (JSON)

### 3.1 LuxReading

`home/sensor/light` 발행 페이로드.

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

### 3.3 RoutineSuggestion

`home/bedroom/routine_suggestion` 발행. 조도 히스테리시스 전이 시(연속 N개 샘플이 임계 만족).
**자동 실행 권한 없음** — 단순 알림. 실행 여부는 백엔드/자동화 규칙이 결정.

```json
{
  "suggest": "sleep_mode",
  "reason": "최근 5개 샘플이 모두 100 lux 미만",
  "currentLux": 80.5,
  "window": [85, 80, 75, 90, 80],
  "previousState": "bright",
  "newState": "dark",
  "deviceId": "rpi-edge-bedroom-01",
  "timestamp": "2026-04-26T11:30:00.000Z"
}
```

| 필드 | 값 |
|---|---|
| `suggest` | `"sleep_mode"` \| `"wakeup_mode"` |
| `previousState` | `"unknown"` \| `"dark"` \| `"bright"` |
| `newState` | `"dark"` \| `"bright"` |

### 3.4 LightControl

`home/bedroom/light/control` 구독. **다양한 포맷 모두 허용** ([lightController.js](lightController.js) `handleControlMessage` 참조).

**문자열 포맷** (가장 단순):
- `"ON"` / `"OFF"`
- `"50"` — 밝기 % (0~100, 현재 색 비율 유지)
- 프리셋: `"warm"`, `"cool"`, `"white"`, `"red"`, `"green"`, `"blue"`, `"amber"`, `"off"`

**JSON 포맷** (필드 조합 가능):
```json
{ "power": "ON" }
{ "brightness": 70 }
{ "preset": "warm" }
{ "r": 255, "g": 100, "b": 30 }
{ "hex": "#ff8800" }
```

여러 필드를 한 메시지에 함께 보내면 코드 순서(hex → preset → r/g/b → power → brightness)대로 적용됩니다. 일반적으로 한 번에 하나만 보내는 것을 권장.

### 3.5 RoutineCommand

`routine/sleep` / `routine/wakeup` 구독. 3가지 페이로드 형태:

```text
(빈 문자열)        → .env 기본값으로 루틴 시작
"cancel"           → 진행 중 루틴 즉시 취소 (해당 토픽 무관, 어떤 루틴이든 취소)
{JSON}             → 옵션 적용 루틴 시작
```

**JSON 옵션 스키마** (모두 옵션):
```json
{
  "duration": 600000,
  "steps": 240,
  "from": [255, 90, 20],
  "to": [0, 0, 0]
}
```

| 필드 | 기본값 | 비고 |
|---|---|---|
| `duration` | `SLEEP/WAKEUP_DURATION_MS` (10분) | 단위 ms |
| `steps` | `ROUTINE_STEPS` (240) | 단계당 최소 50ms 보장 |
| `from` | `SLEEP_COLOR_FROM` / `WAKEUP_COLOR_FROM` | 시작 RGB |
| `to` | `SLEEP_COLOR_TO` / `WAKEUP_COLOR_TO` | 종료 RGB |

기본 팔레트:
- Sleep: amber `(255,90,20)` → off `(0,0,0)`
- Wakeup: dim cool `(5,8,20)` → cool white `(180,200,255)`

---

## 4. LWT 활용 — 디바이스 가용성 즉시 판정

엣지 노드는 MQTT 연결 시 **LWT(Last Will & Testament)** 를 등록해 두기 때문에,
별도의 polling 없이 `home/edge/status` 한 토픽만 구독하면 디바이스 상태를 정확히 알 수 있습니다.

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
});

client.on('message', (topic, payload) => {
  if (topic !== 'home/edge/status') return;
  const msg = JSON.parse(payload.toString());
  deviceState.set(msg.deviceId, {
    status: msg.status,        // "online" | "offline"
    since: msg.timestamp,
    reason: msg.reason ?? null,
  });
  console.log(`[${msg.deviceId}] ${msg.status}` +
              (msg.reason ? ` (${msg.reason})` : ''));
});

// 사용:
function isOnline(deviceId) {
  return deviceState.get(deviceId)?.status === 'online';
}
```

### 4.3 운영 팁

- **keepalive 기본값**: mqtt.js 기본 60초. 브로커는 1.5×keepalive(=90초) 동안 패킷이 없으면 LWT 발동.
  → 즉 비정상 단절 후 **최대 ~90초까지** offline 인지 지연 가능. 이건 트레이드오프.
  더 빨리 알고 싶으면 엣지 측 mqtt.js 옵션에 `keepalive: 30` 등 명시.
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
  -t home/sensor/light -v

# 조명 직접 제어 테스트
mosquitto_pub -h 192.168.0.230 -u iot_user -P iot_pass_2026 \
  -t home/bedroom/light/control -m '{"preset":"warm"}'

# RPi 서비스 상태
ssh pi@192.168.0.230 'systemctl is-active mosquitto edge-light-test'

# 엣지 노드 로컬 이벤트 로그 (최근 20건)
ssh pi@192.168.0.230 'tail -20 /home/pi/smart-sleep-lighting-onprem/service_log.jsonl | jq .'
```

---

## 변경 이력

| 날짜 | 변경 |
|---|---|
| 2026-04-26 | 초안 — 엣지 모듈 단독 검증 완료 시점 기준 |
| 2026-04-26 | 역할 경계 정리 — Express REST API / SSE / 대시보드 레이어 제거. MQTT 전용 가이드로 정리. |
