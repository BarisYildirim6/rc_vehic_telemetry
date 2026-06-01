#!/usr/bin/env bash
set -euo pipefail

CAMERA_APP="${CAMERA_APP:-rpicam-vid}"

if pgrep -x "$CAMERA_APP" >/dev/null; then
  pkill -INT -x "$CAMERA_APP"
else
  echo "$CAMERA_APP is not running"
fi

