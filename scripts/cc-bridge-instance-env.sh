#!/usr/bin/env bash

set -euo pipefail

INSTANCE="${1:-default}"
BASE_PORT="${AGENTBRIDGE_BASE_PORT:-4500}"
PORT_STRIDE="${AGENTBRIDGE_PORT_STRIDE:-10}"

if [[ "$INSTANCE" == "default" ]]; then
  SLOT=0
elif [[ "$INSTANCE" =~ ^[0-9]+$ ]]; then
  SLOT="$INSTANCE"
else
  SLOT=$(python3 - <<'PY' "$INSTANCE"
import sys
s = sys.argv[1]
h = 0
for ch in s:
    h = ((h * 31) + ord(ch)) & 0xffffffff
print((h % 200) + 1)
PY
)
fi

APP_PORT=$((BASE_PORT + SLOT * PORT_STRIDE))
PROXY_PORT=$((APP_PORT + 1))
CONTROL_PORT=$((APP_PORT + 2))
LOG_FILE="/tmp/cc-bridge.log"
PID_FILE="/tmp/cc-bridge-daemon-${CONTROL_PORT}.pid"

if [[ "$INSTANCE" != "default" ]]; then
  LOG_FILE="/tmp/cc-bridge-${INSTANCE}.log"
  PID_FILE="/tmp/cc-bridge-daemon-${INSTANCE}-${CONTROL_PORT}.pid"
fi

cat <<EOF
export AGENTBRIDGE_INSTANCE='${INSTANCE}'
export AGENTBRIDGE_BASE_PORT='${BASE_PORT}'
export AGENTBRIDGE_PORT_STRIDE='${PORT_STRIDE}'
export CODEX_WS_PORT='${APP_PORT}'
export CODEX_PROXY_PORT='${PROXY_PORT}'
export AGENTBRIDGE_CONTROL_PORT='${CONTROL_PORT}'
export AGENTBRIDGE_PID_FILE='${PID_FILE}'
export AGENTBRIDGE_LOG_FILE='${LOG_FILE}'
EOF
