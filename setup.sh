#!/usr/bin/env bash
# ==========================================================
# smart-sleep-lighting-onprem 엣지 노드 셋업 스크립트
#
#  단일 책임: 라즈베리파이를 "조도 센서 → MQTT 발행" 엣지 노드로
#  부팅 가능한 상태로 준비.
#
#  포함:
#    1) I2C 인터페이스 활성화 (YL-40 / PCF8591 통신용)
#    2) Node.js 설치 (NodeSource LTS)
#    3) Mosquitto MQTT 브로커 설치 + 인증 설정
#    4) 프로젝트 의존성 설치 (npm install)
#    5) systemd 서비스 등록 (smart-sleep-edge.service)
#
#  포함하지 않음 (R&R 외):
#    - GPIO/pigpio/LED 제어, 루틴/스케줄러, 백엔드 코드
#
#  사용법 (라즈베리파이 터미널, sudo 권한 필요):
#    cd /home/pi/smart-sleep-lighting-onprem
#    bash setup.sh
# ==========================================================

set -euo pipefail

# ----------------------------------------------------------
# 환경
# ----------------------------------------------------------
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_NAME="smart-sleep-edge"
SERVICE_USER="${SUDO_USER:-pi}"

# .env 의 MQTT 자격증명을 읽어 Mosquitto 사용자로 등록.
# 없으면 fallback (개발 디폴트와 일치).
if [ -f "$PROJECT_DIR/.env" ]; then
  # shellcheck disable=SC1091
  set -a; source "$PROJECT_DIR/.env"; set +a
fi
MQTT_USERNAME="${MQTT_USERNAME:-iot_user}"
MQTT_PASSWORD="${MQTT_PASSWORD:-iot_pass_2026}"

echo "── 프로젝트 디렉터리: $PROJECT_DIR"
echo "── 서비스 실행 사용자: $SERVICE_USER"
echo

# ----------------------------------------------------------
# 0) sudo 사전 검증
# ----------------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
  echo "이 스크립트는 sudo 권한이 필요합니다 — 'sudo bash setup.sh' 로 다시 실행해 주세요."
  exit 1
fi

# ----------------------------------------------------------
# 1) I2C 인터페이스 활성화
# ----------------------------------------------------------
echo "── [1/5] I2C 인터페이스 활성화"
if command -v raspi-config >/dev/null 2>&1; then
  # 0 = enable
  raspi-config nonint do_i2c 0 || true
  echo "   raspi-config: I2C enabled"
else
  echo "   ⚠️  raspi-config 미설치 환경 — /boot/firmware/config.txt 직접 편집 필요할 수 있음"
fi
# i2c-tools — i2cdetect 등 진단 유틸
apt-get install -y i2c-tools >/dev/null

if [ -e /dev/i2c-1 ]; then
  echo "   /dev/i2c-1 사용 가능"
else
  echo "   ⚠️  /dev/i2c-1 미인식 — 재부팅 후 다시 확인하세요"
fi

# ----------------------------------------------------------
# 2) Node.js 설치 (NodeSource LTS)
# ----------------------------------------------------------
echo "── [2/5] Node.js 설치 확인"
if ! command -v node >/dev/null 2>&1; then
  echo "   Node.js 미설치 → NodeSource LTS 추가 후 설치"
  curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
  apt-get install -y nodejs
else
  echo "   기존 Node.js 사용: $(node --version)"
fi
echo "   npm: $(npm --version)"

# ----------------------------------------------------------
# 3) Mosquitto 브로커 설치 + 인증 설정
# ----------------------------------------------------------
echo "── [3/5] Mosquitto 설치 및 인증 설정"
apt-get update -y >/dev/null
apt-get install -y mosquitto mosquitto-clients >/dev/null

PASSWD_FILE="/etc/mosquitto/passwd"
CONF_FILE="/etc/mosquitto/conf.d/auth.conf"

# 사용자 등록 (이미 존재하면 비밀번호 업데이트). -b: batch, -c: 새 파일 생성.
if [ ! -f "$PASSWD_FILE" ]; then
  mosquitto_passwd -b -c "$PASSWD_FILE" "$MQTT_USERNAME" "$MQTT_PASSWORD"
else
  mosquitto_passwd -b "$PASSWD_FILE" "$MQTT_USERNAME" "$MQTT_PASSWORD"
fi
chown mosquitto:mosquitto "$PASSWD_FILE"
chmod 600 "$PASSWD_FILE"

# 인증 강제 + 로컬 listener. 외부 접속 필요 시 백엔드 합류 시점에
# `listener 1883 0.0.0.0` 한 줄 추가하도록 INTEGRATION.md 에 안내.
cat > "$CONF_FILE" <<EOF
# 자동 생성 (smart-sleep-lighting-onprem/setup.sh)
listener 1883 127.0.0.1
listener 1883 ::1
allow_anonymous false
password_file $PASSWD_FILE
EOF

systemctl enable mosquitto >/dev/null 2>&1 || true
systemctl restart mosquitto
echo "   Mosquitto: $(systemctl is-active mosquitto)"

# ----------------------------------------------------------
# 4) 프로젝트 의존성 설치
# ----------------------------------------------------------
echo "── [4/5] npm install (mqtt, dotenv, i2c-bus)"
sudo -u "$SERVICE_USER" -H bash -c "cd '$PROJECT_DIR' && npm install"

# ----------------------------------------------------------
# 5) systemd 서비스 등록
# ----------------------------------------------------------
echo "── [5/5] systemd 서비스 등록: $SERVICE_NAME"

NODE_BIN="$(command -v node)"
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Smart Sleep Lighting — edge node (illuminance sensor → MQTT publish)
After=network-online.target mosquitto.service
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$PROJECT_DIR
EnvironmentFile=$PROJECT_DIR/.env
ExecStart=$NODE_BIN $PROJECT_DIR/index.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
systemctl restart "$SERVICE_NAME"

echo
echo "✅ 셋업 완료"
echo
echo "▶ 서비스 상태:"
echo "    sudo systemctl status $SERVICE_NAME"
echo "    journalctl -u $SERVICE_NAME -f"
echo
echo "▶ MQTT 동작 확인 (다른 터미널 또는 다른 머신):"
echo "    mosquitto_sub -h localhost -u $MQTT_USERNAME -P '<password>' -t 'home/edge/status' -C 1 -v"
echo "    mosquitto_sub -h localhost -u $MQTT_USERNAME -P '<password>' -t 'home/sensor/illuminance' -v"
echo
echo "▶ I2C 센서 진단:"
echo "    sudo i2cdetect -y 1   # 0x48 위치에 PCF8591 검출되어야 함"
