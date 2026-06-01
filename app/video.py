from __future__ import annotations

from app.config import VideoConfig


def rpicam_base_args(config: VideoConfig) -> list[str]:
    args = [
        config.camera_app,
        "-t",
        "0",
        "--codec",
        config.codec,
        "--width",
        str(config.width),
        "--height",
        str(config.height),
        "--framerate",
        str(config.fps),
        "--bitrate",
        str(config.bitrate),
        "--profile",
        config.profile,
    ]
    if config.no_preview:
        args.append("-n")
    if config.inline_headers:
        args.append("--inline")
    return args


def udp_command(config: VideoConfig) -> list[str]:
    return [*rpicam_base_args(config), "-o", f"udp://{config.target_ip}:{config.udp_port}"]


def tcp_command(config: VideoConfig) -> list[str]:
    return [
        *rpicam_base_args(config),
        "--listen",
        "-o",
        f"tcp://{config.tcp_bind}:{config.tcp_port}",
    ]


def video_status(config: VideoConfig) -> dict[str, object]:
    return {
        "profile": {
            "width": config.width,
            "height": config.height,
            "fps": config.fps,
            "bitrate": config.bitrate,
            "codec": config.codec,
        },
        "udp_command": " ".join(udp_command(config)),
        "tcp_command": " ".join(tcp_command(config)),
    }
