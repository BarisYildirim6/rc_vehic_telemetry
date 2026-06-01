# DIY Wi-Fi FPV RC Car MVP

FastAPI control backend for a Raspberry Pi hosted FPV RC car. Video streaming and controls are intentionally separate:

- H.264 video: Raspberry Pi camera through `rpicam-vid`.
- Controls: browser WebSocket to the Pi, then newline-delimited JSON to ESP32 over serial.
- Mock mode: runs on a laptop with no camera and no ESP32.

## Repository Layout

```text
app/          FastAPI backend, control path, serial link, UI
scripts/      camera streaming helpers and WebSocket test client
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

Open `http://127.0.0.1:8000`. With no serial device present, `/api/status` should show `serial.mode` as `mock`.

Optional control-path test:

```bash
python scripts/test_control_client.py --seconds 10
```

## Raspberry Pi Setup

Use Raspberry Pi OS Bookworm or newer with Python 3.11+.

```bash
sudo apt update
sudo apt install -y python3-venv python3-pip rpicam-apps
git clone <your-repo-url> /opt/fpv-car
cd /opt/fpv-car
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
cp config.example.yaml config.yaml
```

Edit `config.yaml`:

- Set `serial.port` to `/dev/ttyUSB0`, `/dev/ttyACM0`, or `/dev/serial0`.
- Set `video.target_ip` to the viewing laptop IP for UDP streaming.
- Keep `serial.mock_when_missing: true` while testing without ESP32.

Run the backend:

```bash
. .venv/bin/activate
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Open `http://<pi-ip>:8000` from the controller browser.

## Camera Streaming

UDP H.264 stream from Pi to a laptop:

```bash
TARGET_IP=<laptop-ip> UDP_PORT=5000 bash scripts/start_video_udp.sh
```

View on the laptop with ffplay:

```bash
ffplay -fflags nobuffer -flags low_delay -framedrop udp://@:5000
```

TCP listener on the Pi:

```bash
TCP_PORT=8888 bash scripts/start_video_tcp.sh
```

View from a laptop:

```bash
ffplay -fflags nobuffer -flags low_delay tcp://<pi-ip>:8888
```

The default camera profile is 1280x720, 30 fps, H.264 baseline, inline headers, 2.5 Mbps.

Stop a manually started camera process:

```bash
bash scripts/stop_video.sh
```

## API

- `GET /health`: process health.
- `GET /api/status`: control, serial, and video command status.
- `POST /api/estop`: sends `{throttle:0, steering:0, brake:true, mode:"estop"}` immediately.
- `WS /ws/control`: browser control stream.

Client WebSocket packets:

```json
{"throttle":0.25,"steering":-0.1,"brake":false,"mode":"normal"}
```

Server-to-ESP32 serial packets:

```json
{"seq":1234,"throttle":0.25,"steering":-0.1,"brake":false,"mode":"normal","ts":123456789}
```

All throttle and steering values are clamped to `[-1.0, 1.0]` on the backend. The backend sends neutral brake on WebSocket disconnect.

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
sudo cp systemd/fpv-video.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fpv-control.service
sudo systemctl enable --now fpv-video.service
```

For video service configuration, create `/opt/fpv-car/video.env`:

```bash
TARGET_IP=<laptop-ip>
UDP_PORT=5000
WIDTH=1280
HEIGHT=720
FPS=30
BITRATE=2500000
```
