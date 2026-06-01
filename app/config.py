from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


@dataclass(frozen=True)
class ServerConfig:
    host: str = "0.0.0.0"
    port: int = 8000
    log_level: str = "info"


@dataclass(frozen=True)
class SerialConfig:
    port: str = "/dev/ttyUSB0"
    baud_rate: int = 115200
    connect_timeout_s: float = 0.2
    reconnect_interval_s: float = 2.0
    mock_when_missing: bool = True
    queue_size: int = 200


@dataclass(frozen=True)
class ControlConfig:
    send_rate_hz: int = 50
    neutral_on_disconnect: bool = True
    default_mode: str = "normal"


@dataclass(frozen=True)
class VideoConfig:
    width: int = 1280
    height: int = 720
    fps: int = 30
    bitrate: int = 2_500_000
    codec: str = "h264"
    profile: str = "baseline"
    inline_headers: bool = True
    target_ip: str = "192.168.4.2"
    udp_port: int = 5000
    tcp_bind: str = "0.0.0.0"
    tcp_port: int = 8888
    camera_app: str = "rpicam-vid"


@dataclass(frozen=True)
class AppConfig:
    server: ServerConfig = field(default_factory=ServerConfig)
    serial: SerialConfig = field(default_factory=SerialConfig)
    control: ControlConfig = field(default_factory=ControlConfig)
    video: VideoConfig = field(default_factory=VideoConfig)


def _section(data: dict[str, Any], key: str) -> dict[str, Any]:
    value = data.get(key, {})
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError(f"Config section {key!r} must be a mapping")
    return value


def load_config(path: str | os.PathLike[str] | None = None) -> AppConfig:
    config_path = Path(path or os.getenv("FPV_CONFIG", "config.yaml"))
    if not config_path.exists():
        config_path = Path("config.example.yaml")

    raw: dict[str, Any] = {}
    if config_path.exists():
        with config_path.open("r", encoding="utf-8") as fh:
            loaded = yaml.safe_load(fh) or {}
            if not isinstance(loaded, dict):
                raise ValueError(f"{config_path} must contain a YAML mapping")
            raw = loaded

    return AppConfig(
        server=ServerConfig(**_section(raw, "server")),
        serial=SerialConfig(**_section(raw, "serial")),
        control=ControlConfig(**_section(raw, "control")),
        video=VideoConfig(**_section(raw, "video")),
    )

