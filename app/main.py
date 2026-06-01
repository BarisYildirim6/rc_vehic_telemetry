from __future__ import annotations

import json
import logging
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
control_manager = ControlManager(CONFIG.control, serial_link)


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
    return {
        "control": control_manager.status(),
        "serial": serial_link.status(),
        "video": video_status(CONFIG.video),
    }


@app.post("/api/estop")
async def api_estop() -> dict[str, object]:
    packet = control_manager.send_neutral(brake=True, mode="estop")
    return {"ok": True, "packet": packet}


@app.websocket("/ws/control")
async def ws_control(websocket: WebSocket) -> None:
    await websocket.accept()
    control_manager.register_client()
    await websocket.send_json({"type": "hello", "send_rate_hz": CONFIG.control.send_rate_hz})

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
                if not isinstance(data, dict):
                    raise ValueError("packet must be a JSON object")
                packet = parse_client_packet(data)
            except Exception as exc:  # noqa: BLE001 - malformed client input should not kill server.
                LOGGER.warning("ignoring malformed control packet: %s", exc)
                await websocket.send_json({"type": "error", "message": "invalid control packet"})
                continue

            server_packet = control_manager.handle_client_packet(packet)
            await websocket.send_json(
                {
                    "type": "ack",
                    "seq": server_packet["seq"],
                    "ts": server_packet["ts"],
                    "serial_mode": serial_link.status()["mode"],
                }
            )
    except WebSocketDisconnect:
        LOGGER.info("control websocket disconnected")
    except Exception:
        LOGGER.exception("control websocket failed")
    finally:
        control_manager.unregister_client()


@app.exception_handler(Exception)
async def unhandled_exception_handler(_: Request, exc: Exception) -> JSONResponse:
    LOGGER.exception("unhandled request error: %s", exc)
    return JSONResponse(status_code=500, content={"detail": "internal server error"})

