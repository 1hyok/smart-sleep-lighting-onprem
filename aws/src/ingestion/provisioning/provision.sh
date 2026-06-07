#!/usr/bin/env bash
# ──────────────────────────────────────────────
# provision.sh — 라즈베리파이 IoT Core 디바이스 프로비저닝 (AWS CLI)
#   Thing 등록 → 최소권한 IoT Policy → X.509 인증서 발급/attach
#   → Amazon Root CA 다운로드 → edge/certs/ 에 저장 → 엔드포인트 안내
# 담당: 정일혁
#
# 사전조건:
#   - AWS CLI v2 설치 + 자격증명 구성 (aws configure)
#   - 사용 계정에 IoT 권한 (iot:CreateThing/CreatePolicy/CreateKeysAndCertificate 등)
#
# 사용:
#   ./provision.sh
#   THING_NAME=rpi-edge-bedroom-02 AWS_REGION=ap-northeast-2 ./provision.sh
#   FORCE_NEW_CERT=true ./provision.sh        # 인증서 강제 재발급(로테이션)
#
# 멱등성: Thing/Policy 는 이미 있으면 통과. 인증서는 기존 활성 인증서가
#   로컬(certs/)에 있으면 재사용한다 → 재실행해도 고아 인증서가 쌓이지 않는다.
#   (재발급이 필요하면 FORCE_NEW_CERT=true)
# ──────────────────────────────────────────────
set -euo pipefail

THING_NAME="${THING_NAME:-rpi-edge-bedroom-01}"
POLICY_NAME="${POLICY_NAME:-SmartSleepEdgePolicy}"
REGION="${AWS_REGION:-ap-northeast-2}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERT_DIR="${CERT_DIR:-$SCRIPT_DIR/../edge/certs}"

echo "▶ 계정/리전 확인..."
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
echo "  account=$ACCOUNT  region=$REGION  thing=$THING_NAME  policy=$POLICY_NAME"

mkdir -p "$CERT_DIR"

# 1) Thing (이미 있으면 통과 — 멱등)
if aws iot describe-thing --thing-name "$THING_NAME" --region "$REGION" >/dev/null 2>&1; then
  echo "▶ Thing 이미 존재: $THING_NAME"
else
  echo "▶ Thing 생성: $THING_NAME"
  aws iot create-thing --thing-name "$THING_NAME" --region "$REGION" >/dev/null
fi

# 2) IoT Policy (region/account 치환 후 생성 — 이미 있으면 통과)
if aws iot get-policy --policy-name "$POLICY_NAME" --region "$REGION" >/dev/null 2>&1; then
  echo "▶ IoT Policy 이미 존재: $POLICY_NAME"
else
  echo "▶ IoT Policy 생성: $POLICY_NAME (최소권한, \${iot:Connection.Thing.ThingName})"
  POLICY_DOC="$(sed -e "s/__REGION__/$REGION/g" -e "s/__ACCOUNT__/$ACCOUNT/g" "$SCRIPT_DIR/iot-policy.json")"
  aws iot create-policy --policy-name "$POLICY_NAME" \
    --policy-document "$POLICY_DOC" --region "$REGION" >/dev/null
fi

# 3) X.509 인증서 + 키 — 기존 활성 인증서가 있으면 재사용(멱등, 고아 인증서 방지)
NEED_CERT=true
CERT_ARN=""
if [[ -f "$CERT_DIR/.cert-arn" && -f "$CERT_DIR/device.pem.crt" && -f "$CERT_DIR/private.pem.key" ]]; then
  EXISTING_ARN="$(cat "$CERT_DIR/.cert-arn")"
  EXISTING_ID="${EXISTING_ARN##*/}"
  STATUS="$(aws iot describe-certificate --certificate-id "$EXISTING_ID" --region "$REGION" \
    --query 'certificateDescription.status' --output text 2>/dev/null || echo MISSING)"
  if [[ "$STATUS" == "ACTIVE" && "${FORCE_NEW_CERT:-false}" != "true" ]]; then
    echo "▶ 기존 활성 인증서 재사용: $EXISTING_ARN"
    echo "  (강제 재발급하려면 FORCE_NEW_CERT=true)"
    CERT_ARN="$EXISTING_ARN"
    NEED_CERT=false
  fi
fi

if [[ "$NEED_CERT" == "true" ]]; then
  echo "▶ X.509 인증서/키 발급..."
  CERT_ARN="$(aws iot create-keys-and-certificate \
    --set-as-active \
    --region "$REGION" \
    --certificate-pem-outfile "$CERT_DIR/device.pem.crt" \
    --private-key-outfile  "$CERT_DIR/private.pem.key" \
    --public-key-outfile   "$CERT_DIR/public.pem.key" \
    --query certificateArn --output text)"
  chmod 600 "$CERT_DIR/private.pem.key"
  echo "$CERT_ARN" > "$CERT_DIR/.cert-arn"
  echo "  certificateArn=$CERT_ARN"
fi

# 4) 인증서 ↔ 정책 ↔ Thing 연결 (attach 는 AWS 측에서 멱등 — 중복 attach 무해)
echo "▶ 정책/Thing attach..."
aws iot attach-policy --policy-name "$POLICY_NAME" --target "$CERT_ARN" --region "$REGION"
aws iot attach-thing-principal --thing-name "$THING_NAME" --principal "$CERT_ARN" --region "$REGION"

# 5) Amazon Root CA (서버 인증서 검증용)
echo "▶ Amazon Root CA 다운로드..."
curl -fsSL https://www.amazontrust.com/repository/AmazonRootCA1.pem -o "$CERT_DIR/AmazonRootCA1.pem"

# 6) 데이터 엔드포인트
ENDPOINT="$(aws iot describe-endpoint --endpoint-type iot:Data-ATS --region "$REGION" --query endpointAddress --output text)"

cat <<EOF

✅ 프로비저닝 완료. edge/.env 에 아래 값을 설정하세요:

   AWS_IOT_ENDPOINT=$ENDPOINT
   IOT_THING_NAME=$THING_NAME
   AWS_REGION=$REGION
   MOCK_IOT=            # 비워두면 실제 IoT Core 접속
   MOCK_SENSOR=         # 라즈베리파이+센서면 비워두기 / PC면 true

   인증서 위치: $CERT_DIR/{private.pem.key, device.pem.crt, AmazonRootCA1.pem}

다음: IoT Rules/모니터링 배포 →  cd ../../../ && sam deploy --config-env ingestion
      엣지 실행 →  cd ../edge && npm install && npm start
EOF
