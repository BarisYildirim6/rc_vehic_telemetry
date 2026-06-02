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


def mediamtx_ingest_command(config: VideoConfig) -> list[str]:
    args = [
        config.camera_app,
        "-t",
        "0",
        "-n",
        "--codec",
        "libav",
        "--libav-format",
        "mpegts",
        "--width",
        str(config.width),
        "--height",
        str(config.height),
        "--framerate",
        str(config.fps),
        "--bitrate",
        str(config.bitrate),
        "-o",
        f"udp://{config.mediamtx_ingest_host}:{config.mediamtx_ingest_port}?pkt_size=1316",
    ]
    if config.low_latency:
        args.insert(6, "--low-latency")
    return args


def video_status(config: VideoConfig) -> dict[str, object]:
    stream_path = config.mediamtx_path.strip("/")
    web_host = config.mediamtx_host.strip()
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
        "mediamtx": {
            "host": web_host,
            "webrtc_port": config.mediamtx_webrtc_port,
            "rtsp_port": config.mediamtx_rtsp_port,
            "path": stream_path,
            "ingest_host": config.mediamtx_ingest_host,
            "ingest_port": config.mediamtx_ingest_port,
            "webrtc_page_path": f"/{stream_path}",
            "whep_path": f"/{stream_path}/whep",
            "rtsp_path": f"/{stream_path}",
        },
        "mediamtx_ingest_command": " ".join(mediamtx_ingest_command(config)),
    }
