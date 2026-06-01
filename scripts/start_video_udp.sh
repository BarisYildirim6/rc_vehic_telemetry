#!/usr/bin/env bash
set -euo pipefail

CAMERA_APP="${CAMERA_APP:-rpicam-vid}"
TARGET_IP="${TARGET_IP:-192.168.4.2}"
UDP_PORT="${UDP_PORT:-5000}"
WIDTH="${WIDTH:-1280}"
HEIGHT="${HEIGHT:-720}"
FPS="${FPS:-30}"
BITRATE="${BITRATE:-2500000}"

exec "$CAMERA_APP" -t 0 \
  -n \
  --codec h264 \
  --width "$WIDTH" \
  --height "$HEIGHT" \
  --framerate "$FPS" \
  --bitrate "$BITRATE" \
  --profile baseline \
  --inline \
  -o "udp://${TARGET_IP}:${UDP_PORT}"
