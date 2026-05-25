#!/usr/bin/env bash
#
# Wrapper for Codex TUI that protects terminal state from corruption.
#
# Usage: ./cc-bridge-attach.sh [proxy-url]
#   Default proxy URL: ws://127.0.0.1:4501
#   Or:
#     eval "$(bash ./scripts/cc-bridge-instance-env.sh 1)"
#     ./scripts/cc-bridge-attach.sh "ws://127.0.0.1:${CODEX_PROXY_PORT}"

set -uo pipefail

PROXY_URL="${1:-ws://127.0.0.1:4501}"

if [ -t 0 ]; then
  SAVED_STTY=$(stty -g 2>/dev/null || true)
else
  SAVED_STTY=""
fi

restore_terminal() {
  if [ -n "$SAVED_STTY" ] && [ -t 0 ]; then
    if ! stty "$SAVED_STTY" 2>/dev/null; then
      stty sane 2>/dev/null || true
    fi
  fi

  local tty_target="/dev/tty"
  if ! [ -w "$tty_target" ]; then
    if [ -t 1 ]; then
      tty_target="/dev/stdout"
    else
      return
    fi
  fi
  printf '\e[<u' >"$tty_target" 2>/dev/null || true
  printf '\e[?2004l' >"$tty_target" 2>/dev/null || true
  printf '\e[?1004l' >"$tty_target" 2>/dev/null || true
  printf '\e[?1049l' >"$tty_target" 2>/dev/null || true
  printf '\e[?25h' >"$tty_target" 2>/dev/null || true
  printf '\e[0m' >"$tty_target" 2>/dev/null || true
}

trap restore_terminal EXIT INT TERM

echo "Attaching Codex TUI to cc-bridge proxy at ${PROXY_URL}..."
echo "(Terminal state saved — will be restored on exit)"
echo ""

CHILD_EXIT=0
codex --enable tui_app_server --remote "$PROXY_URL" || CHILD_EXIT=$?

exit "$CHILD_EXIT"
