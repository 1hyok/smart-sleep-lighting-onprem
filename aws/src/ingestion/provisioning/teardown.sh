#!/usr/bin/env bash
# ──────────────────────────────────────────────
# teardown.sh — provision.sh 가 만든 디바이스 리소스 정리.
#   인증서 detach/deactivate/delete → (선택) 정책/Thing 삭제.
# 담당: 정일혁
# 사용: ./teardown.sh           (인증서만 정리)
#       DELETE_POLICY=true DELETE_THING=true ./teardown.sh
# ──────────────────────────────────────────────
set -euo pipefail

THING_NAME="${THING_NAME:-rpi-edge-bedroom-01}"
POLICY_NAME="${POLICY_NAME:-SmartSleepEdgePolicy}"
REGION="${AWS_REGION:-ap-northeast-2}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERT_DIR="${CERT_DIR:-$SCRIPT_DIR/../edge/certs}"

if [[ ! -f "$CERT_DIR/.cert-arn" ]]; then
  echo "⚠️  $CERT_DIR/.cert-arn 없음 — 인증서 ARN 을 모름. 콘솔에서 수동 정리 필요."
  exit 1
fi
CERT_ARN="$(cat "$CERT_DIR/.cert-arn")"
CERT_ID="${CERT_ARN##*/}"
echo "▶ 대상 인증서: $CERT_ARN"

echo "▶ detach (policy/thing)..."
aws iot detach-policy --policy-name "$POLICY_NAME" --target "$CERT_ARN" --region "$REGION" || true
aws iot detach-thing-principal --thing-name "$THING_NAME" --principal "$CERT_ARN" --region "$REGION" || true

echo "▶ 인증서 비활성화 + 삭제..."
aws iot update-certificate --certificate-id "$CERT_ID" --new-status INACTIVE --region "$REGION" || true
aws iot delete-certificate --certificate-id "$CERT_ID" --force-delete --region "$REGION" || true

if [[ "${DELETE_POLICY:-false}" == "true" ]]; then
  echo "▶ 정책 삭제: $POLICY_NAME"
  aws iot delete-policy --policy-name "$POLICY_NAME" --region "$REGION" || true
fi
if [[ "${DELETE_THING:-false}" == "true" ]]; then
  echo "▶ Thing 삭제: $THING_NAME"
  aws iot delete-thing --thing-name "$THING_NAME" --region "$REGION" || true
fi

rm -f "$CERT_DIR/.cert-arn"
echo "✅ 정리 완료. (IoT Rules 스택은 'sam delete --stack-name smartsleep-ingestion' 로 별도 삭제)"
