#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTANCE="${1:?usage: cc-bridge-register-instance.sh <instance> [mcp-name]}"
MCP_NAME="${2:-cc-bridge-${INSTANCE}}"
ENV_FILE="${CC_BRIDGE_ENV_FILE:-${ROOT_DIR}/.env}"

eval "$(bash "${ROOT_DIR}/scripts/cc-bridge-instance-env.sh" "$INSTANCE")"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  source "${ENV_FILE}"
  set +a
fi

resolve_endpoint() {
  local instance="$1"
  if [[ "${instance}" =~ ^[0-9]+$ ]]; then
    local n="${instance}"
    local label=""
    while (( n > 0 )); do
      local remainder=$(( (n - 1) % 26 ))
      label="$(printf "\\$(printf '%03o' $((65 + remainder)))")${label}"
      n=$(( (n - 1) / 26 ))
    done
    printf '%s' "${label}"
    return
  fi
  printf '%s' "${instance}"
}

ENDPOINT="$(resolve_endpoint "${INSTANCE}")"
ROOM="${CC_BRIDGE_ROOM:-default}"
LAUNCH_TEMPLATE="${ROOT_DIR}/scripts/launch-claude-peer.sh {endpoint} {profile} {workdir} {prompt_b64}"
DEFAULT_PROFILE="${CC_BRIDGE_DEFAULT_PROFILE:-claude_api}"
ENDPOINT_INSTANCE_MAP="${CC_BRIDGE_ENDPOINT_INSTANCE_MAP:-}"

claude mcp remove "${MCP_NAME}" -s user >/dev/null 2>&1 || true
JSON_CONFIG=$(cat <<EOF
{"type":"stdio","command":"bun","args":["run","${ROOT_DIR}/src/bridge.ts"],"env":{"AGENTBRIDGE_INSTANCE":"${AGENTBRIDGE_INSTANCE}","AGENTBRIDGE_BASE_PORT":"${AGENTBRIDGE_BASE_PORT}","AGENTBRIDGE_PORT_STRIDE":"${AGENTBRIDGE_PORT_STRIDE}","CODEX_WS_PORT":"${CODEX_WS_PORT}","CODEX_PROXY_PORT":"${CODEX_PROXY_PORT}","AGENTBRIDGE_CONTROL_PORT":"${AGENTBRIDGE_CONTROL_PORT}","AGENTBRIDGE_PID_FILE":"${AGENTBRIDGE_PID_FILE}","AGENTBRIDGE_LOG_FILE":"${AGENTBRIDGE_LOG_FILE}","AGENTBRIDGE_MODE":"pull","AGENTBRIDGE_IDLE_SHUTDOWN_MS":"600000","CC_BRIDGE_ROOM":"${ROOM}","CC_BRIDGE_ENDPOINT":"${ENDPOINT}","CC_BRIDGE_ENV_FILE":"${ENV_FILE}","CC_BRIDGE_LAUNCH_TEMPLATE":"${LAUNCH_TEMPLATE}","CC_BRIDGE_DEFAULT_PROFILE":"${DEFAULT_PROFILE}","CC_BRIDGE_ENDPOINT_INSTANCE_MAP":"${ENDPOINT_INSTANCE_MAP}"}} 
EOF
)

claude mcp add-json -s user "${MCP_NAME}" "${JSON_CONFIG}"

echo "Registered MCP server '${MCP_NAME}' for instance '${INSTANCE}'"
echo "Proxy URL: ws://127.0.0.1:${CODEX_PROXY_PORT}"
