#!/bin/bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
ROOT_DIR="/Users/fido/Desktop/projects/cc-bridge"
BRIDGE="${ROOT_DIR}/bin/cc-bridge"
LOG="/tmp/cc-bridge-b-cron.log"

export CC_BRIDGE_ENDPOINT="${CC_BRIDGE_ENDPOINT:-B}"
export CC_BRIDGE_ROOM="${CC_BRIDGE_ROOM:-orchestra}"
export AGENTBRIDGE_CONTROL_PORT="${AGENTBRIDGE_CONTROL_PORT:-4522}"
WINDOW_HINT="${CC_BRIDGE_WINDOW_HINT:-cc-bridge B /}"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"
}

inject_prompt() {
  local prompt="$1"
  local prompt_json
  local title_json

  prompt_json=$(python3 - <<'PY' "$prompt"
import json
import sys
print(json.dumps(sys.argv[1]))
PY
)
  title_json=$(python3 - <<'PY' "$WINDOW_HINT"
import json
import sys
print(json.dumps(sys.argv[1]))
PY
)

  osascript <<EOF
set nudgeText to ${prompt_json}
set targetTitle to ${title_json}
set the clipboard to nudgeText

tell application "Terminal"
  repeat with w in windows
    try
      if custom title of selected tab of w contains targetTitle then
        set index of w to 1
        activate
        delay 0.3
        tell application "System Events"
          keystroke "v" using command down
          delay 0.4
          keystroke return
        end tell
        return "ok"
      end if
    end try
  end repeat
end tell

return "window-not-found"
EOF
}

log "Polling bridge"
output=$("$BRIDGE" get-messages 2>&1 || true)
while IFS= read -r line; do
  log "$line"
done <<< "$output"

if [[ "$output" == *"[From "* ]]; then
  prompt=$'You have new bridge messages captured by the 5-minute cron poller. Review them and reply with `cc-bridge reply` if a response is needed.\n\nMessages:\n'
  prompt+="$output"
  prompt+=$'\n\nAfter replying, run `cc-bridge wait-for-messages 120` to keep listening.'

  result=$(inject_prompt "$prompt" 2>>"$LOG" || true)
  if [[ "$result" == "ok" ]]; then
    log "Injected prompt into target Terminal window"
  else
    log "Target Terminal window not found for hint: ${WINDOW_HINT}"
  fi
else
  log "No new messages"
fi
