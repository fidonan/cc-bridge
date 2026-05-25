#!/usr/bin/env bash
# cc-bridge-watch.sh — Persistent message watcher that injects received messages
# into a Claude Code Terminal window as prompts, driving the conversation forward.
#
# Usage: cc-bridge-watch.sh <endpoint> <window_title> [room] [port]
#
# This script runs an infinite loop:
#   1. cc-bridge wait-for-messages 120 (2 min timeout)
#   2. If messages received, inject a nudge into the target Claude window
#   3. Repeat
#
# The nudge tells Claude to read the messages and reply, then keeps polling.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENDPOINT="${1:?usage: cc-bridge-watch.sh <endpoint> <window_title> [room] [port]}"
WINDOW_TITLE="${2:?usage: cc-bridge-watch.sh <endpoint> <window_title> [room] [port]}"
ROOM="${3:-${CC_BRIDGE_ROOM:-default}}"
PORT="${4:-${AGENTBRIDGE_CONTROL_PORT:-4522}}"
POLL_TIMEOUT="${CC_BRIDGE_WATCH_POLL_TIMEOUT:-120}"

export CC_BRIDGE_ROOM="${ROOM}"
export CC_BRIDGE_ENDPOINT="${ENDPOINT}"
export AGENTBRIDGE_CONTROL_PORT="${PORT}"
export PATH="${ROOT_DIR}/bin:${ROOT_DIR}/scripts:${PATH}"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [watch-${ENDPOINT}] $*"
}

inject_prompt() {
  local prompt="$1"
  osascript << EOF 2>/dev/null
set nudgeText to "$(echo "${prompt}" | sed 's/"/\\"/g')"
set the clipboard to nudgeText
tell application "Terminal"
  repeat with w in windows
    try
      if custom title of selected tab of w contains "${WINDOW_TITLE}" then
        set index of w to 1
        exit repeat
      end if
    end try
  end repeat
  activate
end tell
delay 0.3
tell application "System Events"
  keystroke "v" using command down
  delay 0.5
  keystroke return
end tell
EOF
}

is_window_idle() {
  # Check if the target window shows ✳ (idle) or ❯ prompt
  local title
  title=$(osascript -e "
    tell application \"Terminal\"
      repeat with w in windows
        try
          if custom title of selected tab of w contains \"${WINDOW_TITLE}\" then
            return custom title of selected tab of w
          end if
        end try
      end repeat
      return \"\"
    end tell" 2>/dev/null || echo "")

  # ✳ means idle, ⠐/⠂/⠈ means working
  if echo "${title}" | grep -q '✳'; then
    return 0
  fi
  return 1
}

CONSECUTIVE_EMPTY=0

log "Started watching for endpoint=${ENDPOINT} room=${ROOM} port=${PORT}"
log "Target window title contains: ${WINDOW_TITLE}"

while true; do
  # Wait for messages
  output=$(cc-bridge wait-for-messages "${POLL_TIMEOUT}" 2>&1) || true

  if echo "${output}" | grep -q "timeout.*no messages"; then
    CONSECUTIVE_EMPTY=$((CONSECUTIVE_EMPTY + 1))
    log "No messages (empty streak: ${CONSECUTIVE_EMPTY})"

    # After 3 consecutive empties (6 min), nudge Claude to poll
    if (( CONSECUTIVE_EMPTY >= 3 )); then
      if is_window_idle; then
        log "Window idle after ${CONSECUTIVE_EMPTY} empty polls — nudging"
        inject_prompt "Check for new peer messages: run cc-bridge wait-for-messages 120. If you have messages, reply to continue the discussion. If no messages, wait again."
        CONSECUTIVE_EMPTY=0
      fi
    fi
    continue
  fi

  # Got messages
  CONSECUTIVE_EMPTY=0
  msg_count=$(echo "${output}" | grep -c '^\[From' || true)
  log "Received ${msg_count} message(s)"

  # Only inject if window is idle (not mid-response)
  if is_window_idle; then
    log "Window idle — injecting nudge"
    inject_prompt "You have new peer messages. Run cc-bridge get-messages to read them, then reply with cc-bridge reply to continue the discussion. After replying, run cc-bridge wait-for-messages 120 to keep listening."
  else
    log "Window busy — skipping injection, will retry next cycle"
  fi

  # Brief pause before next poll
  sleep 5
done
