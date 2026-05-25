#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENDPOINT="${1:?usage: launch-claude-peer.sh <endpoint> [profile] [workdir] [prompt_b64] [target_room]}"
PROFILE="${2:-${CC_BRIDGE_DEFAULT_PROFILE:-claude_api}}"
WORKDIR="${3:-${ROOT_DIR}}"
PROMPT_B64="${4:-}"
TARGET_ROOM="${5:-}"
CLAUDE_CONFIG_DIR="$("${ROOT_DIR}/scripts/prepare-claude-config-dir.sh" "${ENDPOINT}" "${PROFILE}")"

resolve_instance() {
  local endpoint="$1"
  if [[ "${endpoint}" =~ ^[A-Z]$ ]]; then
    printf '%d' "$(( $(printf '%d' "'${endpoint}") - 64 ))"
    return
  fi
  printf '%s' "${endpoint}"
}

INSTANCE="$(resolve_instance "${ENDPOINT}")"
MCP_NAME="cc-bridge-${INSTANCE}"

# Pass TARGET_ROOM so the MCP config (and daemon it spawns) use the correct room
CC_BRIDGE_ROOM="${TARGET_ROOM:-${CC_BRIDGE_ROOM:-default}}" \
  bash "${ROOT_DIR}/scripts/cc-bridge-register-instance.sh" "${INSTANCE}" "${MCP_NAME}" >/dev/null

MCP_CONFIG_FILE="$(python3 - <<'PY' "${MCP_NAME}"
import json
import os
import sys
from pathlib import Path

mcp_name = sys.argv[1]
claude_config = Path.home() / ".claude.json"
data = json.loads(claude_config.read_text())
server = data.get("mcpServers", {}).get(mcp_name)
if not server:
    raise SystemExit(f"missing MCP config for {mcp_name}")

tmp_dir = Path("/tmp/cc-bridge-mcp")
tmp_dir.mkdir(parents=True, exist_ok=True)
path = tmp_dir / f"{mcp_name}.json"
path.write_text(json.dumps({"mcpServers": {mcp_name: server}}, ensure_ascii=False))
print(path, end="")
PY
)"

if [[ -n "${PROMPT_B64}" ]]; then
  INITIAL_PROMPT="$(python3 - <<'PY' "${PROMPT_B64}"
import base64
import sys
print(base64.b64decode(sys.argv[1]).decode("utf-8"), end="")
PY
)"
else
  INITIAL_PROMPT=""
fi

SYSTEM_PROMPT="Peer ${ENDPOINT}. After replying, always call wait_for_messages again. Never stop the loop."
KICKSTART_PROMPT="Call get_messages now, reply to any messages, then call wait_for_messages."

FIRST_PROMPT="${INITIAL_PROMPT:-${KICKSTART_PROMPT}}"

SYSTEM_PROMPT_FILE="${ROOT_DIR}/scripts/peer-system-prompt.md"

CLAUDE_CMD=$(python3 - <<'PY' "${MCP_CONFIG_FILE}" "${SYSTEM_PROMPT_FILE}" "${FIRST_PROMPT}"
import shlex
import sys
mcp_config = sys.argv[1]
sys_file = sys.argv[2]
first_prompt = sys.argv[3]
# Keep normal user-level skills/plugins loading, while profile env is still
# injected process-locally by load-profile-env.sh before Claude starts.
print("exec claude --strict-mcp-config --mcp-config " + shlex.quote(mcp_config) + " --append-system-prompt-file " + shlex.quote(sys_file) + " -- " + shlex.quote(first_prompt))
PY
)

ROOM_EXPORT=""
if [[ -n "${TARGET_ROOM}" ]]; then
  ROOM_EXPORT="CC_BRIDGE_ROOM='${TARGET_ROOM}' "
fi

INNER_COMMAND=$(cat <<EOF
cd '${WORKDIR}' && \
source '${ROOT_DIR}/scripts/load-profile-env.sh' '${PROFILE}' && \
export CLAUDE_CONFIG_DIR='${CLAUDE_CONFIG_DIR}' && \
export PATH="${ROOT_DIR}/bin:${ROOT_DIR}/scripts:\${PATH}" && \
printf '\033]0;%s\007' 'cc-bridge ${ENDPOINT} / ${PROFILE} / ${MCP_NAME}' && \
echo 'cc-bridge peer window ${ENDPOINT} started with profile ${PROFILE} (MCP: ${MCP_NAME})' && \
echo 'Claude config: ${CLAUDE_CONFIG_DIR}' && \
echo 'CLI: cc-bridge get-messages | cc-bridge reply MSG | cc-bridge wait-for-messages' && \
${ROOM_EXPORT}${CLAUDE_CMD}
EOF
)

COMMAND=$(python3 - <<'PY' "${INNER_COMMAND}"
import shlex
import sys
print("bash -lc " + shlex.quote(sys.argv[1]))
PY
)

ESCAPED_COMMAND=$(python3 - <<'PY' "${COMMAND}"
import json
import sys
print(json.dumps(sys.argv[1]))
PY
)

WINDOW_TITLE="cc-bridge ${ENDPOINT} / ${PROFILE} / ${MCP_NAME}"
ESCAPED_TITLE=$(python3 - <<'PY' "${WINDOW_TITLE}"
import json
import sys
print(json.dumps(sys.argv[1]))
PY
)

ESCAPED_KICKSTART_PROMPT=$(python3 - <<'PY' "${KICKSTART_PROMPT}"
import json
import sys
print(json.dumps(sys.argv[1]))
PY
)

osascript <<EOF
set launchCommand to ${ESCAPED_COMMAND}
set launchTitle to ${ESCAPED_TITLE}
tell application "Terminal"
  activate
  do script launchCommand
  delay 0.2
  set custom title of selected tab of front window to launchTitle
  set index of front window to 1
  activate
end tell
EOF

LOG_FILE="/tmp/${MCP_NAME}.log"
for _ in $(seq 1 30); do
  if [[ -f "${LOG_FILE}" ]] && grep -q "MCP server connected (mode: pull)" "${LOG_FILE}"; then
    break
  fi
  sleep 1
done

# Wait for MCP server to appear in the log (indicates claude is running)
sleep 5
echo "B peer window launched. Initial prompt will drive the message loop."
