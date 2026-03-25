#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> cc-bridge setup"

if ! command -v bun >/dev/null 2>&1; then
  echo "Error: bun is not installed or not in PATH." >&2
  exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "Error: claude is not installed or not in PATH." >&2
  exit 1
fi

cd "${ROOT_DIR}"

echo "==> Installing dependencies"
bun install

echo "==> Registering MCP instances"
bash "${ROOT_DIR}/scripts/cc-bridge-register-instance.sh" 1 cc-bridge-1
bash "${ROOT_DIR}/scripts/cc-bridge-register-instance.sh" 2 cc-bridge-2

echo "==> Verifying MCP registration"
claude mcp get cc-bridge-1 >/dev/null
claude mcp get cc-bridge-2 >/dev/null

echo ""
echo "Setup complete."
echo "Next:"
echo "  1. Open two Claude Code windows in this repo"
echo "  2. Follow QUICKSTART.md or SOP.md"
