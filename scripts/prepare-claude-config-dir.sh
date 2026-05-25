#!/usr/bin/env bash

set -euo pipefail

ENDPOINT="${1:?usage: prepare-claude-config-dir.sh <endpoint> [profile]}"
PROFILE="${2:-default}"

SOURCE_DIR="${CLAUDE_SOURCE_CONFIG_DIR:-$HOME/.claude}"
TARGET_ROOT="${CC_BRIDGE_CLAUDE_CONFIG_ROOT:-$HOME/.claude/isolated}"
TARGET_DIR="${TARGET_ROOT}/${ENDPOINT}-${PROFILE}"
SOURCE_GLOBAL_CONFIG="${CLAUDE_SOURCE_GLOBAL_CONFIG:-$HOME/.claude.json}"
TARGET_GLOBAL_CONFIG="${TARGET_DIR}/.claude.json"

mkdir -p "${TARGET_DIR}"

link_path() {
  local src="$1"
  local dst="$2"

  if [[ ! -e "${src}" ]]; then
    return
  fi

  rm -rf "${dst}"
  ln -s "${src}" "${dst}"
}

sanitize_settings() {
  local src="$1"
  local dst="$2"

  if [[ ! -f "${src}" ]]; then
    printf '{}\n' > "${dst}"
    return
  fi

  python3 - <<'PY' "${src}" "${dst}"
import json
import sys
from pathlib import Path

src = Path(sys.argv[1])
dst = Path(sys.argv[2])
data = json.loads(src.read_text())

env = data.get("env")
if isinstance(env, dict):
    blocked = {
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_MODEL",
        "ANTHROPIC_SMALL_FAST_MODEL",
        "ANTHROPIC_REASONING_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
    }
    cleaned = {k: v for k, v in env.items() if k not in blocked}
    if cleaned:
        data["env"] = cleaned
    else:
        data.pop("env", None)

dst.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
PY
}

sanitize_settings "${SOURCE_DIR}/settings.json" "${TARGET_DIR}/settings.json"

sanitize_global_config() {
  local src="$1"
  local dst="$2"

  if [[ ! -f "${src}" ]]; then
    printf '{}\n' > "${dst}"
    return
  fi

  python3 - <<'PY' "${src}" "${dst}"
import json
import sys
from pathlib import Path

src = Path(sys.argv[1])
dst = Path(sys.argv[2])
data = json.loads(src.read_text())

for key in [
    "oauthAccount",
    "cachedGrowthBookFeatures",
    "groveConfigCache",
    "clientDataCache",
    "metricsStatusCache",
    "cachedExtraUsageDisabledReason",
    "overageCreditGrantCache",
]:
    data.pop(key, None)

dst.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
PY
}

sanitize_global_config "${SOURCE_GLOBAL_CONFIG}" "${TARGET_GLOBAL_CONFIG}"

if [[ -f "${SOURCE_DIR}/settings.local.json" ]]; then
  cp "${SOURCE_DIR}/settings.local.json" "${TARGET_DIR}/settings.local.json"
fi

for dir_name in \
  skills \
  agents \
  commands \
  output-styles \
  workflows \
  hooks \
  rules \
  plugins \
  scripts \
  mcp-configs \
  .agents \
  .codex \
  .cursor \
  .opencode
do
  link_path "${SOURCE_DIR}/${dir_name}" "${TARGET_DIR}/${dir_name}"
done

for file_name in \
  AGENTS.md \
  CLAUDE.md \
  README.md \
  PLUGIN_SCHEMA_NOTES.md \
  marketplace.json \
  plugin.json \
  keybindings.json
do
  link_path "${SOURCE_DIR}/${file_name}" "${TARGET_DIR}/${file_name}"
done

mkdir -p \
  "${TARGET_DIR}/projects" \
  "${TARGET_DIR}/sessions" \
  "${TARGET_DIR}/session-env" \
  "${TARGET_DIR}/shell-snapshots" \
  "${TARGET_DIR}/telemetry" \
  "${TARGET_DIR}/history"

printf '%s\n' "${TARGET_DIR}"
