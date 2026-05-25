#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${CC_BRIDGE_ENV_FILE:-${ROOT_DIR}/.env}"
PROFILE_RAW="${1:-${CC_BRIDGE_DEFAULT_PROFILE:-claude_api}}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Error: env file not found: ${ENV_FILE}" >&2
  exit 1
fi

set -a
source "${ENV_FILE}"
set +a

PROFILE_KEY="$(echo "${PROFILE_RAW}" | tr '[:lower:]-' '[:upper:]_')"

BASE_URL_VAR="CC_PROFILE_${PROFILE_KEY}_ANTHROPIC_BASE_URL"
API_KEY_VAR="CC_PROFILE_${PROFILE_KEY}_ANTHROPIC_API_KEY"
MODEL_VAR="CC_PROFILE_${PROFILE_KEY}_ANTHROPIC_MODEL"
FAST_MODEL_VAR="CC_PROFILE_${PROFILE_KEY}_ANTHROPIC_SMALL_FAST_MODEL"

# Avoid inheriting persistent Claude auth/model state from user-level config.
unset ANTHROPIC_AUTH_TOKEN
unset ANTHROPIC_MODEL
unset ANTHROPIC_SMALL_FAST_MODEL
unset ANTHROPIC_REASONING_MODEL
unset ANTHROPIC_DEFAULT_HAIKU_MODEL
unset ANTHROPIC_DEFAULT_SONNET_MODEL
unset ANTHROPIC_DEFAULT_OPUS_MODEL

export ANTHROPIC_BASE_URL="${!BASE_URL_VAR:-}"
export ANTHROPIC_API_KEY="${!API_KEY_VAR:-}"
export ANTHROPIC_MODEL="${!MODEL_VAR:-}"
export ANTHROPIC_SMALL_FAST_MODEL="${!FAST_MODEL_VAR:-${ANTHROPIC_MODEL:-}}"

if [[ -z "${ANTHROPIC_BASE_URL}" || -z "${ANTHROPIC_API_KEY}" || -z "${ANTHROPIC_MODEL}" ]]; then
  echo "Error: profile '${PROFILE_RAW}' is missing required Claude env fields in ${ENV_FILE}" >&2
  exit 1
fi

export CC_BRIDGE_ACTIVE_PROFILE="${PROFILE_RAW}"
