#!/usr/bin/env bash
set -euo pipefail

CAMERA_APP="${CAMERA_APP:-rpicam-vid}"

if pgrep -x "$CAMERA_APP" >/dev/null 2>&1; then
  pkill -INT -x "$CAMERA_APP"
fi

if pgrep -x mediamtx >/dev/null 2>&1; then
  pkill -INT -x mediamtx
fi

echo "MediaMTX video stack stopped if it was running."

