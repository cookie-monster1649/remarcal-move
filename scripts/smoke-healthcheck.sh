#!/usr/bin/env bash
set -euo pipefail

HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/api/health}"
EXPECTED_STATUS="${EXPECTED_STATUS:-ok}"
TIMEOUT="${TIMEOUT:-30}"

deadline=$(( $(date +%s) + TIMEOUT ))

until response="$(curl -fsS "$HEALTH_URL" 2>/dev/null)"; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "Smoke check timed out after ${TIMEOUT}s waiting for $HEALTH_URL"
    exit 1
  fi
  sleep 1
done

if ! echo "$response" | jq -e --arg expected "$EXPECTED_STATUS" '.status == $expected' >/dev/null; then
  echo "Smoke check failed. Response: $response"
  exit 1
fi

echo "Smoke check passed: $response"
