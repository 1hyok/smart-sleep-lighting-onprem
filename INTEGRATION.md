# Smart Sleep Lighting — 엣지 노드 MQTT 인계 명세

본 엣지 노드는 라즈베리파이에서 두 가지 책임을 가집니다.

1. **[Publish]** I2C 조도 센서(YL-40 / PCF8591 + LDR) 값을 노이즈 필터링 후 Mosquitto MQTT 브로커로 발행
2. **[Subscribe]** 백엔드의 조명 제어 명령(`level`, `durationMs`)을 수신해 GPIO PWM 으로 LED 를 점진(Fade) 제어

수면 루틴 판단/스케줄 산출/Fitbit 연동/추천 등 비즈니스 로직은 모두 백엔드 책임이며, 엣지는 "센서값 수집 발행" + "백엔드가 시키는 대로 조명 제어" 두 액션만 수행합니다. 본 문서는 백엔드 팀이 발행/구독할 MQTT 인터페이스를 정의합니다.

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
│ (Pub & Sub)         │                            │  - I2C YL-40 (PCF8591)│
└─────────────────────┘                            │  - GPIO PWM LED      │
                                                   └──────────────────────┘
              ▲                                                │
              │  Subscribe                                     │  Publish
              │   home/sensor/illuminance                      │   home/sensor/illuminance
              │   home/edge/status (LWT)                       │   home/edge/status (LWT)
              │                                                │
              │  Publish                                       │  Subscribe
              ▼   home/edge/light/command                      ▼   home/edge/light/command
```

엣지 노드의 외부 통신은 모두 MQTT 로 이루어집니다. HTTP/REST 서버, Fitbit API 호출, DB 접근은 일체 포함하지 않습니다.

---

## 2. MQTT 토픽 카탈로그

### 2.1 발행 (Edge → Subscribers)

| 토픽 | QoS | retain | 주기 | 페이로드 |
|---|---|---|---|---|
| `home/sensor/illuminance` | 1 | false | ~3s (env: `SENSOR_PUBLISH_INTERVAL_MS`) | [LuxReading](#31-luxreading) |
| `home/edge/status` | 1 | **true** | 접속/종료 시 + LWT | [DeviceStatus](#32-devicestatus) |

### 2.2 구독 (Backend → Edge)

| 토픽 | QoS | retain | 페이로드 | 동작 |
|---|---|---|---|---|
| `home/edge/light/command` | 1 | false | [LightCommand](#33-lightcommand) | `level` 까지 `durationMs` 동안 PWM 페이드 (`durationMs=0` 이면 즉시 점프) |

엣지는 `clean=true` 로 접속하므로 백엔드는 **retain=false** 로 발행해도 됩니다. 단, 엣지가 disconnect 상태일 때의 명령은 수신되지 않으니, 시간 민감한 명령은 `home/edge/status` 의 `online` 확인 후 발행하는 것을 권장합니다.

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

### 3.3 LightCommand

`home/edge/light/command` 구독 페이로드. 백엔드가 발행, 엣지가 수신.

```json
{
  "level": 30,
  "durationMs": 5000
}
```

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `level` | number | ✅ | 목표 밝기 (0..100, %). 범위 밖이면 명령 드랍 + `light_command_invalid` 이벤트 로그. |
| `durationMs` | number | optional | 페이드 소요 시간(ms). 생략/0/음수 → 즉시 점프. |

**동작 보증**:
- 진행 중인 페이드가 있는 상태에서 새 명령이 들어오면 **이전 인터벌을 취소하고 현재 듀티에서 새 타겟까지** 다시 페이드 (LED 깜빡임 방지).
- 페이드 업데이트 주기는 50ms (~20Hz). RPi CPU 부하는 무시 수준.
- 인지 비선형(웨버-페히너) 미적용 — 균등 매핑. 추후 감마 보정으로 교체 예정.
- 엣지가 비-RPi 환경 또는 `pigpio` 미설치 시 `MOCK` 모드로 폴백 — 실제 LED 는 켜지지 않지만 듀티값은 로그로 남아 명령 전달 검증은 가능.

**예시**:
```jsonc
// 5초간 천천히 30%로 디밍 (취침 루틴)
{ "level": 30, "durationMs": 5000 }

// 즉시 소등
{ "level": 0 }

// 30분간 0 → 80% 점진 점등 (기상 알람)
{ "level": 80, "durationMs": 1800000 }
```

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

// 조명 제어 명령 발행 예시 — 5초간 30% 로 디밍
function fadeTo(level, durationMs) {
  if (!isOnline('rpi-edge-bedroom-01')) {
    console.warn('엣지 오프라인 — 명령 드랍');
    return;
  }
  client.publish(
    'home/edge/light/command',
    JSON.stringify({ level, durationMs }),
    { qos: 1, retain: false },
  );
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

엣지 모듈은 센서 발행 + 조명 명령 수신까지 구현 완료 상태이며, 백엔드가 들어올 때 다음을 확인합니다:

- [ ] **MQTT 외부 listener** — RPi `/etc/mosquitto/conf.d/auth.conf` 에 `listener 1883 0.0.0.0` 추가 후 `sudo systemctl restart mosquitto`
- [ ] **방화벽** — 현재 RPi 에는 ufw/iptables 미설치. 필요 시 1883 포트 명시 허용
- [ ] **시간 동기화** — 모든 컴포넌트가 NTP 동기화되어 있어야 timestamp 정렬 정확. RPi 는 RTC 가 없어 NTP 의존.
- [ ] **`deviceId` 합의** — 멀티 디바이스 확장 시 `MQTT_CLIENT_ID` 명명 규칙 (`rpi-edge-{room}-{seq}`) 통일
- [ ] **조명 제어 토픽 발행 권한** — Mosquitto ACL 분리 시 백엔드 계정에 `home/edge/light/command` write 허용
- [ ] **명령 발행 시 online 확인** — `home/edge/status` retained 메시지로 디바이스가 `online` 일 때만 발행 (오프라인 시 명령 휘발)
- [ ] **pigpio 시스템 의존성** — RPi 에 `sudo apt install pigpio` (libpigpio C 라이브러리). 미설치 시 엣지는 자동 mock 폴백

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
| 2026-04-26 | **조명 액추에이터 R&R 복구** — 직전 항목의 "publish-only" 결정이 MVP 요구사항(점진 조명 제어)을 누락한 것으로 확인되어 재정합화. 엣지에 `home/edge/light/command` 구독 + `lightController.js` (pigpio PWM 페이드) 추가. 백엔드는 수면/기상 루틴 산출 후 명령만 발행, GPIO 제어는 엣지가 담당. |
