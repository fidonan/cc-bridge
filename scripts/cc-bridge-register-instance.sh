#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTANCE="${1:?usage: cc-bridge-register-instance.sh <instance> [mcp-name]}"
MCP_NAME="${2:-cc-bridge-${INSTANCE}}"

eval "$(bash "${ROOT_DIR}/scripts/cc-bridge-instance-env.sh" "$INSTANCE")"

claude mcp remove "${MCP_NAME}" -s user >/dev/null 2>&1 || true
JSON_CONFIG=$(cat <<EOF
{"type":"stdio","command":"bun","args":["run","${ROOT_DIR}/src/bridge.ts"],"env":{"AGENTBRIDGE_INSTANCE":"${AGENTBRIDGE_INSTANCE}","AGENTBRIDGE_BASE_PORT":"${AGENTBRIDGE_BASE_PORT}","AGENTBRIDGE_PORT_STRIDE":"${AGENTBRIDGE_PORT_STRIDE}","CODEX_WS_PORT":"${CODEX_WS_PORT}","CODEX_PROXY_PORT":"${CODEX_PROXY_PORT}","AGENTBRIDGE_CONTROL_PORT":"${AGENTBRIDGE_CONTROL_PORT}","AGENTBRIDGE_PID_FILE":"${AGENTBRIDGE_PID_FILE}","AGENTBRIDGE_LOG_FILE":"${AGENTBRIDGE_LOG_FILE}","AGENTBRIDGE_MODE":"pull","AGENTBRIDGE_IDLE_SHUTDOWN_MS":"600000"}} 
EOF
)

claude mcp add-json -s user "${MCP_NAME}" "${JSON_CONFIG}"

echo "Registered MCP server '${MCP_NAME}' for instance '${INSTANCE}'"
echo "Proxy URL: ws://127.0.0.1:${CODEX_PROXY_PORT}"
