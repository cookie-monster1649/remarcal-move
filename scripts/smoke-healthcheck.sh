#!/usr/bin/env bash
set -euo pipefail

HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/api/health}"
EXPECTED_STATUS="${EXPECTED_STATUS:-ok}"

response="$(curl -fsS "$HEALTH_URL")"

if ! echo "$response" | jq -e --arg expected "$EXPECTED_STATUS" '.status == $expected' >/dev/null; then
  echo "Smoke check failed. Response: $response"
  exit 1
fi

echo "Smoke check passed: $response"
