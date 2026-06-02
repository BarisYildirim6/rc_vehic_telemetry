# DIY Wi-Fi FPV RC Car MVP

FastAPI control backend for a Raspberry Pi hosted FPV RC car. Video streaming and controls are intentionally separate:

- H.264 video: Raspberry Pi camera through `rpicam-vid`, relayed by MediaMTX for browser WebRTC.
- Controls: browser WebSocket to the Pi, then newline-delimited JSON to ESP32 over serial.
- Mock mode: runs on a laptop with no camera and no ESP32.

## Repository Layout

```text
app/          FastAPI backend, control path, serial link, UI
scripts/      camera streaming helpers and WebSocket test client
mediamtx/     MediaMTX relay configuration
systemd/      Raspberry Pi service unit examples
esp32/        serial protocol and Arduino receiver stub
```

## Laptop Mock Mode

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

On Windows PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Open `http://127.0.0.1:8000`. With no serial device present, `/api/status` should show `serial.mode` as `mock`. The video panel will show disconnected unless MediaMTX and a stream source are running.

Optional control-path test:

```bash
python scripts/test_control_client.py --seconds 10
```

Mock mode includes simulated ESP32 telemetry in the cockpit HUD and `/api/status`: armed state, failsafe state, last control age, throttle/steering PWM estimates, and optional fake battery voltage from `telemetry.mock_battery_voltage`.

## Raspberry Pi Setup

Use Raspberry Pi OS Bookworm or newer with Python 3.11+.

```bash
sudo apt update
sudo apt install -y git python3-venv python3-pip rpicam-apps ffmpeg
sudo mkdir -p /opt/fpv-car
sudo chown "$USER":"$USER" /opt/fpv-car
git clone <your-repo-url> /opt/fpv-car
cd /opt/fpv-car
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
cp config.example.yaml config.yaml
```

For USB serial devices, add the runtime user to `dialout`, then log out and back in:

```bash
sudo usermod -aG dialout "$USER"
```

For the Pi header UART at `/dev/serial0`, run `sudo raspi-config`, enable the serial port, and disable the login shell on serial.

Edit `config.yaml`:

- Set `serial.port` to `/dev/ttyUSB0`, `/dev/ttyACM0`, or `/dev/serial0`.
- Keep `video.mediamtx_host` empty unless MediaMTX runs on a different host.
- Keep `video.mediamtx_path` aligned with `mediamtx/mediamtx.yml`; default is `fpv`.
- Adjust `video.width`, `video.height`, `video.fps`, and `video.bitrate` for latency/bandwidth.
- Keep `video.low_latency: true` for Bookworm rpicam builds; set `LOW_LATENCY=0` for the publisher script only if your installed `rpicam-vid` rejects `--low-latency`.
- Keep `serial.mock_when_missing: true` while testing without ESP32.

## MediaMTX Setup

MediaMTX is the video relay. It receives a local UDP MPEG-TS stream from `rpicam-vid` and exposes it to the cockpit browser with WebRTC.

Install MediaMTX on the Pi:

1. Download the latest MediaMTX release from `https://github.com/bluenviron/mediamtx/releases`.
2. Use `linux_arm64.tar.gz` for Raspberry Pi OS 64-bit, or `linux_armv7.tar.gz` for 32-bit.
3. Extract it and put the `mediamtx` binary in `/usr/local/bin` or `/opt/fpv-car/mediamtx/`.

Example after downloading the archive:

```bash
tar -xzf mediamtx_*_linux_arm64.tar.gz
sudo install -m 0755 mediamtx /usr/local/bin/mediamtx
```

The project config is `mediamtx/mediamtx.yml`. Defaults:

- WebRTC browser endpoint: `http://<pi-ip>:8889/fpv`
- WHEP endpoint used by the cockpit: `http://<pi-ip>:8889/fpv/whep`
- RTSP fallback: `rtsp://<pi-ip>:8554/fpv`
- Camera ingest: `udp+mpegts://127.0.0.1:5600`

## Running The Cockpit

Terminal 1, start the FastAPI control backend:

```bash
. .venv/bin/activate
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Terminal 2, start MediaMTX:

```bash
bash scripts/start_mediamtx.sh
```

Terminal 3, start the Pi camera publisher into MediaMTX:

```bash
bash scripts/start_video_mediamtx.sh
```

Open the unified cockpit from the controller browser:

```text
http://<pi-ip>:8000
```

The browser control WebSocket still connects to FastAPI on port 8000. The video panel connects separately to MediaMTX on port 8889.

## Cockpit Controls

Keyboard:

- `W` / `S`: throttle forward/reverse
- `A` / `D`: steering left/right
- `Space`: E-stop
- `R`: clear E-stop only when throttle is neutral
- `1`: Bench mode
- `2`: Crawl mode
- `3`: Normal mode
- `4`: Sport mode
- `Enter`: arm/disarm toggle only when throttle is neutral

Gamepad support uses configurable constants in `app/static/app.js` for axis mapping, deadzone, expo, and throttle inversion. Gamepad and keyboard inputs both use the same shaping and `sendControl()` path.

The cockpit HUD overlays the video and shows throttle, steering, drive mode, arm state, E-stop state, WebSocket state, video state, RTT last/avg/min/max, jitter, measured control send rate, last command age, and serial/mock state.

## Safety States And Drive Modes

Default state is disarmed, E-stop clear, and `Bench` mode.

- Disarmed: backend forwards fully neutral throttle and steering regardless of browser input.
- Armed: backend may forward shaped commands, subject to E-stop and drive mode limits.
- E-stop active: backend forwards neutral throttle, centered steering, and `brake=true`; arming is blocked.
- Clear E-stop: allowed only when throttle is neutral.
- WebSocket disconnect: backend sends a neutral brake packet.

Drive modes:

- `Bench`: max throttle `0.00`, max steering `0.60`; useful for servo-only testing.
- `Crawl`: max throttle `0.25`, max steering `0.60`, slow ramp.
- `Normal`: max throttle `0.60`, max steering `0.85`, medium ramp.
- `Sport`: max throttle `1.00`, max steering `1.00`, faster ramp.

The browser applies deadzone, expo, rate limiting, drive-mode limits, and optional steering reduction at high throttle. The backend also clamps values and enforces the core safety rules, so UI bugs cannot bypass disarm, E-stop, or Bench throttle lockout.

## Camera Streaming

The v2 cockpit path is:

```text
Raspberry Pi Camera -> rpicam-vid H.264 -> UDP MPEG-TS localhost:5600 -> MediaMTX -> WebRTC -> browser <video>
```

Manual MediaMTX publisher command:

```bash
WIDTH=1280 HEIGHT=720 FPS=30 BITRATE=2500000 bash scripts/start_video_mediamtx.sh
```

MediaMTX standalone browser page:

```text
http://<pi-ip>:8889/fpv
```

External RTSP fallback:

```bash
ffplay rtsp://<pi-ip>:8554/fpv -fflags nobuffer -flags low_delay -framedrop
```

The older direct UDP/TCP helpers remain available for debugging outside the cockpit.

UDP H.264 stream from Pi to a laptop:

```bash
TARGET_IP=<laptop-ip> UDP_PORT=5000 bash scripts/start_video_udp.sh
```

View on the laptop with ffplay:

```bash
ffplay udp://@:5000 -fflags nobuffer -flags low_delay -framedrop
```

TCP listener on the Pi:

```bash
TCP_PORT=8888 bash scripts/start_video_tcp.sh
```

View from a laptop:

```bash
ffplay tcp://<pi-ip>:8888 -vf "setpts=N/30" -fflags nobuffer -flags low_delay -framedrop
```

The default camera profile is 1280x720, 30 fps, H.264 baseline, inline headers, 2.5 Mbps. Raw H.264 over UDP/TCP is low latency but not accepted by every player.

For a more player-compatible UDP MPEG-TS stream:

```bash
TARGET_IP=<laptop-ip> UDP_PORT=5000 bash scripts/start_video_udp_mpegts.sh
vlc udp://@:5000
```

Confirm the camera is detected:

```bash
rpicam-hello --list-cameras
rpicam-vid -t 5000 -n --inline -o test.h264
```

Stop a manually started camera process:

```bash
bash scripts/stop_video.sh
bash scripts/stop_mediamtx_video.sh
```

## Latency Troubleshooting

- Prefer 1280x720 at 30 fps and tune `BITRATE` down before lowering frame rate.
- Keep the Pi and browser client on the same Wi-Fi band or wired network when possible.
- Confirm the camera stream reaches MediaMTX first: open `http://<pi-ip>:8889/fpv`.
- If WebRTC does not connect in the cockpit, try the RTSP fallback with `ffplay`.
- Check that ports `8889/tcp` and `8189/udp` are reachable from the browser device.
- On Raspberry Pi OS Bookworm, UDP receive buffering may need tuning for local MPEG-TS ingest. Add these to `/etc/sysctl.conf`, then run `sudo sysctl -p`:

```text
net.core.rmem_default=1000000
net.core.rmem_max=1000000
```

## API

- `GET /health`: process health.
- `GET /api/status`: control, serial, and video command status.
- `POST /api/estop`: sends `{throttle:0, steering:0, brake:true, mode:"estop"}` immediately.
- `POST /api/clear-estop`: clears global E-stop only when throttle is neutral.
- `POST /api/mode`: body `{"mode":"bench|crawl|normal|sport"}`.
- `POST /api/arm`: body `{"armed":true|false}`.
- `WS /ws/control`: browser control stream.

Legacy client WebSocket packets still parse:

```json
{"throttle":0.25,"steering":-0.1,"brake":false,"mode":"normal"}
```

Cockpit control packets include metrics and safety state:

```json
{"type":"control","seq":42,"throttle":0.25,"steering":-0.1,"brake":false,"armed":true,"estop":false,"mode":"crawl","client_ts":1710000000000}
```

Ping/pong:

```json
{"type":"ping","seq":123,"client_ts":1710000000000}
{"type":"pong","seq":123,"client_ts":1710000000000,"server_ts":1710000000010}
```

The server also sends `{"type":"status", ...}` over the WebSocket at 5 Hz.

Server-to-ESP32 serial packets:

```json
{"seq":1234,"throttle":0.25,"steering":-0.1,"brake":false,"mode":"normal","armed":true,"estop":false,"drive_mode":"crawl","ts":123456789}
```

All throttle and steering values are clamped to `[-1.0, 1.0]` on the backend. The backend sends neutral brake on WebSocket disconnect.

## Mock Mode Test Checklist

1. Start the backend without ESP32 attached and open `http://127.0.0.1:8000`.
2. Confirm HUD/`/api/status` show `mock` serial mode.
3. In `Bench`, press `W`; throttle should remain `0%` and serial `last_packet.throttle` should remain `0.0`.
4. Press `Enter` while throttle is neutral; arm should only succeed if E-stop is clear.
5. Switch to `Crawl` with `2`; throttle should ramp slowly and cap around `25%`.
6. Press `Space`; E-stop should become active, arm should drop, and packet `brake` should be `true`.
7. Release throttle and press `R`; E-stop should clear.
8. Watch HUD RTT/jitter/send-rate/last-age while holding `A/D/W/S`.
9. Stop or disconnect the browser tab; backend should send a neutral brake packet.

## ESP32 Later

Connect the ESP32 by USB serial first. Confirm the device path:

```bash
ls /dev/ttyUSB* /dev/ttyACM*
```

Set that path in `config.yaml`, restart the backend, and check `/api/status`. The ESP32 firmware must also implement the 300 ms failsafe described in `esp32/protocol.md`.

## systemd

Copy the service files after installing the project at `/opt/fpv-car`:

```bash
sudo cp systemd/fpv-control.service /etc/systemd/system/
sudo cp systemd/mediamtx.service /etc/systemd/system/
sudo cp systemd/fpv-video.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fpv-control.service
sudo systemctl enable --now mediamtx.service
sudo systemctl enable --now fpv-video.service
```

For video service configuration, create `/opt/fpv-car/video.env`:

```bash
TARGET_IP=<laptop-ip>
UDP_PORT=5000
MEDIAMTX_INGEST_HOST=127.0.0.1
MEDIAMTX_INGEST_PORT=5600
WIDTH=1280
HEIGHT=720
FPS=30
BITRATE=2500000
LOW_LATENCY=1
```
