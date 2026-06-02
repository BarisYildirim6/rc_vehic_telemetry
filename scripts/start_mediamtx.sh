#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

MEDIAMTX_BIN="${MEDIAMTX_BIN:-mediamtx}"
MEDIAMTX_CONFIG="${MEDIAMTX_CONFIG:-${PROJECT_DIR}/mediamtx/mediamtx.yml}"

if [[ "${FPV_SYSTEMD:-0}" != "1" ]] && pgrep -x mediamtx >/dev/null 2>&1; then
  echo "MediaMTX is already running."
  exit 0
fi

if ! command -v "$MEDIAMTX_BIN" >/dev/null 2>&1; then
  if [[ -x "${PROJECT_DIR}/mediamtx/mediamtx" ]]; then
    MEDIAMTX_BIN="${PROJECT_DIR}/mediamtx/mediamtx"
  else
    echo "MediaMTX binary not found. Set MEDIAMTX_BIN or install mediamtx into PATH." >&2
    exit 1
  fi
fi

exec "$MEDIAMTX_BIN" "$MEDIAMTX_CONFIG"
