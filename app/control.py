from __future__ import annotations

import logging
import threading
import time
from typing import Any

from app.config import ControlConfig
from app.schemas import ClientControlPacket, SerialControlPacket, clamp_unit
from app.serial_link import SerialLink


LOGGER = logging.getLogger(__name__)


class ControlManager:
    def __init__(self, config: ControlConfig, serial_link: SerialLink) -> None:
        self.config = config
        self.serial_link = serial_link
        self._lock = threading.Lock()
        self._seq = 0
        self._client_count = 0
        self._last_packet: dict[str, Any] | None = None
        self._last_client_ts: float | None = None

    def register_client(self) -> None:
        with self._lock:
            self._client_count += 1
            LOGGER.info("control client connected; clients=%s", self._client_count)

    def unregister_client(self) -> None:
        should_neutral = False
        with self._lock:
            self._client_count = max(0, self._client_count - 1)
            should_neutral = self.config.neutral_on_disconnect
            LOGGER.info("control client disconnected; clients=%s", self._client_count)
        if should_neutral:
            self.send_neutral(brake=True, mode="estop")

    def handle_client_packet(self, packet: ClientControlPacket) -> dict[str, Any]:
        throttle = clamp_unit(packet.throttle)
        steering = clamp_unit(packet.steering)
        brake = bool(packet.brake)
        mode = "estop" if brake or packet.mode == "estop" else self.config.default_mode

        with self._lock:
            self._seq += 1
            serial_packet = SerialControlPacket(
                seq=self._seq,
                throttle=0.0 if brake else throttle,
                steering=0.0 if brake else steering,
                brake=brake,
                mode=mode,  # type: ignore[arg-type]
                ts=int(time.time() * 1000),
            )
            payload = serial_packet.model_dump()
            self._last_packet = payload
            self._last_client_ts = time.time()

        self.serial_link.send(payload)
        return payload

    def send_neutral(self, brake: bool = False, mode: str = "normal") -> dict[str, Any]:
        packet = ClientControlPacket(throttle=0.0, steering=0.0, brake=brake, mode="estop" if brake else "normal")
        return self.handle_client_packet(packet)

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {
                "clients": self._client_count,
                "seq": self._seq,
                "last_packet": self._last_packet,
                "last_client_ts": self._last_client_ts,
                "send_rate_hz": self.config.send_rate_hz,
            }

