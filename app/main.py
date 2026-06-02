from __future__ import annotations

import json
import logging
import asyncio
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app.config import load_config
from app.control import ControlManager
from app.schemas import parse_client_packet
from app.serial_link import SerialLink
from app.video import video_status


CONFIG = load_config()
logging.basicConfig(
    level=getattr(logging, CONFIG.server.log_level.upper(), logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
LOGGER = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))

serial_link = SerialLink(CONFIG.serial)
control_manager = ControlManager(CONFIG.control, CONFIG.telemetry, serial_link)


@asynccontextmanager
async def lifespan(app: FastAPI):
    serial_link.start()
    LOGGER.info("fpv control backend started")
    try:
        yield
    finally:
        LOGGER.info("fpv control backend stopping")
        serial_link.close()


app = FastAPI(title="FPV RC Car Control", version="0.1.0", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")


@app.get("/", response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(
        "index.html",
        {
            "request": request,
            "send_rate_hz": CONFIG.control.send_rate_hz,
        },
    )


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/status")
async def api_status() -> dict[str, object]:
    serial_status = serial_link.status()
    return {
        "control": control_manager.status(serial_status),
        "serial": serial_status,
        "video": video_status(CONFIG.video),
    }


@app.post("/api/estop")
async def api_estop() -> dict[str, object]:
    return control_manager.set_estop()


@app.post("/api/clear-estop")
async def api_clear_estop() -> dict[str, object]:
    return control_manager.clear_estop()


@app.post("/api/mode")
async def api_mode(request: Request) -> dict[str, object]:
    body = await request.json()
    mode = body.get("mode", "") if isinstance(body, dict) else ""
    return control_manager.set_mode(str(mode))


@app.post("/api/arm")
async def api_arm(request: Request) -> dict[str, object]:
    body = await request.json()
    armed = bool(body.get("armed", False)) if isinstance(body, dict) else False
    return control_manager.set_armed(armed)


@app.websocket("/ws/control")
async def ws_control(websocket: WebSocket) -> None:
    await websocket.accept()
    control_manager.register_client()
    send_lock = asyncio.Lock()

    async def send_json(payload: dict[str, object]) -> None:
        async with send_lock:
            await websocket.send_json(payload)

    async def status_loop() -> None:
        while True:
            await asyncio.sleep(0.2)
            await send_json(control_manager.websocket_status_message(serial_link.status()))

    status_task = asyncio.create_task(status_loop())

    try:
        await send_json({"type": "hello", "send_rate_hz": CONFIG.control.send_rate_hz})
        while True:
            try:
                raw = await asyncio.wait_for(
                    websocket.receive_text(),
                    timeout=CONFIG.control.client_timeout_s,
                )
            except asyncio.TimeoutError:
                LOGGER.warning("control websocket missed heartbeat; forcing neutral stop")
                await websocket.close(code=1001, reason="control heartbeat timeout")
                break

            try:
                data = json.loads(raw)
                if not isinstance(data, dict):
                    raise ValueError("packet must be a JSON object")
            except Exception as exc:  # noqa: BLE001 - malformed client input should not kill server.
                LOGGER.warning("ignoring malformed control packet: %s", exc)
                control_manager.send_neutral(brake=True, estop=True)
                await send_json({"type": "error", "message": "invalid JSON packet"})
                continue

            message_type = data.get("type", "control")
            try:
                if message_type == "ping":
                    await send_json(
                        {
                            "type": "pong",
                            "seq": data.get("seq"),
                            "client_ts": data.get("client_ts"),
                            "server_ts": int(time.time() * 1000),
                        }
                    )
                    continue
                if message_type == "mode":
                    result = control_manager.set_mode(str(data.get("mode", "")))
                    await send_json({"type": "mode", **result})
                    continue
                if message_type == "arm":
                    result = control_manager.set_armed(bool(data.get("armed", False)))
                    await send_json({"type": "arm", **result})
                    continue
                if message_type == "estop":
                    result = control_manager.set_estop()
                    await send_json({"type": "estop", **result})
                    continue
                if message_type == "clear_estop":
                    result = control_manager.clear_estop()
                    await send_json({"type": "clear_estop", **result})
                    continue

                packet = parse_client_packet(data)
            except Exception as exc:  # noqa: BLE001
                LOGGER.warning("ignoring malformed websocket message: %s", exc)
                control_manager.send_neutral(brake=True, estop=True)
                await send_json({"type": "error", "message": "invalid control message"})
                continue

            server_packet = control_manager.handle_client_packet(packet)
            await send_json(
                {
                    "type": "ack",
                    "seq": server_packet["seq"],
                    "ts": server_packet["ts"],
                    "serial_mode": serial_link.status()["mode"],
                    "armed": server_packet["armed"],
                    "estop": server_packet["estop"],
                    "mode": server_packet["drive_mode"],
                }
            )
    except WebSocketDisconnect:
        LOGGER.info("control websocket disconnected")
    except Exception:
        LOGGER.exception("control websocket failed")
    finally:
        status_task.cancel()
        try:
            await status_task
        except asyncio.CancelledError:
            pass
        control_manager.unregister_client()


@app.exception_handler(Exception)
async def unhandled_exception_handler(_: Request, exc: Exception) -> JSONResponse:
    LOGGER.exception("unhandled request error: %s", exc)
    return JSONResponse(status_code=500, content={"detail": "internal server error"})
