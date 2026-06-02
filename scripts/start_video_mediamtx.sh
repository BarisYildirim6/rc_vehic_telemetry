#!/usr/bin/env bash
set -euo pipefail

CAMERA_APP="${CAMERA_APP:-rpicam-vid}"
MEDIAMTX_INGEST_HOST="${MEDIAMTX_INGEST_HOST:-127.0.0.1}"
MEDIAMTX_INGEST_PORT="${MEDIAMTX_INGEST_PORT:-5600}"
WIDTH="${WIDTH:-1280}"
HEIGHT="${HEIGHT:-720}"
FPS="${FPS:-30}"
BITRATE="${BITRATE:-2500000}"
LOW_LATENCY="${LOW_LATENCY:-1}"
LOW_LATENCY_ARGS=()
if [[ "$LOW_LATENCY" != "0" ]]; then
  LOW_LATENCY_ARGS=(--low-latency)
fi

if [[ "${FPV_SYSTEMD:-0}" != "1" ]] && pgrep -f "${CAMERA_APP}.*udp://${MEDIAMTX_INGEST_HOST}:${MEDIAMTX_INGEST_PORT}" >/dev/null 2>&1; then
  echo "Camera publisher is already streaming to ${MEDIAMTX_INGEST_HOST}:${MEDIAMTX_INGEST_PORT}."
  exit 0
fi

exec "$CAMERA_APP" -t 0 \
  -n \
  --codec libav \
  "${LOW_LATENCY_ARGS[@]}" \
  --libav-format mpegts \
  --width "$WIDTH" \
  --height "$HEIGHT" \
  --framerate "$FPS" \
  --bitrate "$BITRATE" \
  -o "udp://${MEDIAMTX_INGEST_HOST}:${MEDIAMTX_INGEST_PORT}?pkt_size=1316"
