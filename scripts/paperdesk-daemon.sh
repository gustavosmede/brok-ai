#!/bin/zsh
set -u

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_DIR" || exit 1

npm run start &
SERVER_PID=$!
FINANCIALJUICE_PID=""

shutdown() {
  if [ -n "$FINANCIALJUICE_PID" ]; then
    kill "$FINANCIALJUICE_PID" >/dev/null 2>&1 || true
  fi
  kill "$SERVER_PID" >/dev/null 2>&1 || true
}
trap shutdown EXIT INT TERM

attempt=0
until curl -fsS "http://127.0.0.1:3000/api/state" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    exit 1
  fi
  sleep 1
done

node scripts/financialjuice-collector.mjs &
FINANCIALJUICE_PID=$!

while true; do
  curl -fsS -X POST "http://127.0.0.1:3000/api/market" \
    -H "content-type: application/json" \
    --data '{}' >/dev/null 2>&1 || true
  sleep 300
done
