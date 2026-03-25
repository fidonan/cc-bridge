#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTANCE="${1:-default}"
shift || true

eval "$(bash "${ROOT_DIR}/scripts/cc-bridge-instance-env.sh" "$INSTANCE")"

echo "Starting cc-bridge instance '${AGENTBRIDGE_INSTANCE}'"
echo "  app-server: ws://127.0.0.1:${CODEX_WS_PORT}"
echo "  proxy:      ws://127.0.0.1:${CODEX_PROXY_PORT}"
echo "  control:    ws://127.0.0.1:${AGENTBRIDGE_CONTROL_PORT}/ws"
echo "  log:        ${AGENTBRIDGE_LOG_FILE}"

cd "${ROOT_DIR}"
exec bun run src/bridge.ts "$@"
