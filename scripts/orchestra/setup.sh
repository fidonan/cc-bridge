#!/usr/bin/env bash
#
# setup.sh — Register 4 cc-bridge MCP instances for the PM/Consultant/Programmer/Messenger orchestra.
#
# Instance mapping:
#   1 (A) → bridge.ts       → Claude (PM, Opus 4.7)
#   2 (B) → bridge-codex.ts → Codex (Consultant, GPT-5.5)
#   3 (C) → bridge.ts       → Claude (Programmer)
#   4 (D) → bridge.ts       → Claude (Messenger, Haiku)
#
# Usage: bash scripts/orchestra/setup.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "==> cc-bridge Orchestra Setup (4 windows)"
echo "    Root: ${ROOT_DIR}"

# Check prerequisites
if ! command -v bun >/dev/null 2>&1; then
  echo "Error: bun is not installed." >&2
  exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "Error: claude CLI is not installed." >&2
  exit 1
fi

cd "${ROOT_DIR}"

echo "==> Installing dependencies"
bun install

# ── Helper ─────────────────────────────────────────────────────────────────

register_instance() {
  local INSTANCE="$1"
  local MCP_NAME="$2"
  local BRIDGE_ENTRY="$3"  # bridge.ts or bridge-codex.ts
  local ENDPOINT="$4"
  local ROOM="${CC_BRIDGE_ROOM:-default}"

  # Compute ports (same logic as cc-bridge-instance-env.sh)
  local BASE_PORT="${AGENTBRIDGE_BASE_PORT:-4500}"
  local PORT_STRIDE="${AGENTBRIDGE_PORT_STRIDE:-10}"
  local SLOT="${INSTANCE}"
  local APP_PORT=$((BASE_PORT + SLOT * PORT_STRIDE))
  local PROXY_PORT=$((APP_PORT + 1))
  local CONTROL_PORT=$((APP_PORT + 2))
  local LOG_FILE="/tmp/cc-bridge-${INSTANCE}.log"
  local PID_FILE="/tmp/cc-bridge-daemon-${INSTANCE}-${CONTROL_PORT}.pid"

  # Remove existing registration if any
  claude mcp remove "${MCP_NAME}" -s user >/dev/null 2>&1 || true

  local JSON_CONFIG
  JSON_CONFIG=$(cat <<EOF
{
  "type": "stdio",
  "command": "bun",
  "args": ["run", "${ROOT_DIR}/src/${BRIDGE_ENTRY}"],
  "env": {
    "AGENTBRIDGE_INSTANCE": "${INSTANCE}",
    "AGENTBRIDGE_BASE_PORT": "${BASE_PORT}",
    "AGENTBRIDGE_PORT_STRIDE": "${PORT_STRIDE}",
    "AGENTBRIDGE_MODE": "pull",
    "AGENTBRIDGE_IDLE_SHUTDOWN_MS": "600000",
    "CC_BRIDGE_ROOM": "${ROOM}",
    "CC_BRIDGE_ENDPOINT": "${ENDPOINT}"
  }
}
EOF
)

  claude mcp add-json -s user "${MCP_NAME}" "${JSON_CONFIG}"
  echo "  Registered: ${MCP_NAME} → ${BRIDGE_ENTRY} (endpoint=${ENDPOINT}, control=${CONTROL_PORT})"
}

# ── Register 4 instances ──────────────────────────────────────────────────

echo ""
echo "==> Registering MCP instances"

register_instance 1 "cc-bridge-1" "bridge.ts"       "A"
register_instance 2 "cc-bridge-2" "bridge-codex.ts" "B"
register_instance 3 "cc-bridge-3" "bridge.ts"       "C"
register_instance 4 "cc-bridge-4" "bridge.ts"       "D"

# ── Verify ─────────────────────────────────────────────────────────────────

echo ""
echo "==> Verifying registration"
for NAME in cc-bridge-1 cc-bridge-2 cc-bridge-3 cc-bridge-4; do
  if claude mcp get "${NAME}" >/dev/null 2>&1; then
    echo "  ✓ ${NAME}"
  else
    echo "  ✗ ${NAME} — NOT FOUND" >&2
  fi
done

echo ""
echo "==> Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Open 4 Claude Code windows (or 3 Claude + 1 terminal for Codex)"
echo "  2. In Window A (PM):     paste scripts/orchestra/prompt-pm.md"
echo "  3. In Window B (Codex):  paste scripts/orchestra/prompt-consultant.md"
echo "  4. In Window C (Coder):  paste scripts/orchestra/prompt-programmer.md"
echo "  5. In Window D (Relay):  paste scripts/orchestra/prompt-messenger.md"
echo "  6. Then give A your project requirements"
echo ""
echo "Logs:"
echo "  tail -f /tmp/cc-bridge-1.log  (A/PM)"
echo "  tail -f /tmp/cc-bridge-2.log  (B/Codex)"
echo "  tail -f /tmp/cc-bridge-3.log  (C/Programmer)"
echo "  tail -f /tmp/cc-bridge-4.log  (D/Messenger)"
echo ""
echo "Port map:"
echo "  Instance 1 (A): app=4510, proxy=4511, control=4512"
echo "  Instance 2 (B): app=4520, proxy=4521, control=4522"
echo "  Instance 3 (C): app=4530, proxy=4531, control=4532"
echo "  Instance 4 (D): app=4540, proxy=4541, control=4542"
