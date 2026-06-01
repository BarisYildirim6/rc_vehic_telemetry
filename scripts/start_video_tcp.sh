#!/usr/bin/env bash
set -euo pipefail

CAMERA_APP="${CAMERA_APP:-rpicam-vid}"
TCP_BIND="${TCP_BIND:-0.0.0.0}"
TCP_PORT="${TCP_PORT:-8888}"
WIDTH="${WIDTH:-1280}"
HEIGHT="${HEIGHT:-720}"
FPS="${FPS:-30}"
BITRATE="${BITRATE:-2500000}"

exec "$CAMERA_APP" -t 0 \
  --codec h264 \
  --width "$WIDTH" \
  --height "$HEIGHT" \
  --framerate "$FPS" \
  --bitrate "$BITRATE" \
  --profile baseline \
  --inline \
  --listen \
  -o "tcp://${TCP_BIND}:${TCP_PORT}"

