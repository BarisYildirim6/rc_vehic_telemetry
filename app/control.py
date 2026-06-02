from __future__ import annotations

import logging
import threading
import time
from collections import deque
from typing import Any

from app.config import ControlConfig, TelemetryConfig
from app.schemas import ClientControlPacket, DriveMode, SerialControlPacket, clamp_unit
from app.serial_link import SerialLink


LOGGER = logging.getLogger(__name__)

DRIVE_LIMITS: dict[DriveMode, dict[str, float]] = {
    "bench": {"throttle": 0.0, "steering": 0.60},
    "crawl": {"throttle": 0.25, "steering": 0.60},
    "normal": {"throttle": 0.60, "steering": 0.85},
    "sport": {"throttle": 1.00, "steering": 1.00},
}


def _now_ms() -> int:
    return int(time.time() * 1000)


class ControlManager:
    def __init__(self, config: ControlConfig, telemetry_config: TelemetryConfig, serial_link: SerialLink) -> None:
        self.config = config
        self.telemetry_config = telemetry_config
        self.serial_link = serial_link
        self._lock = threading.Lock()
        self._seq = 0
        self._client_count = 0
        self._packets_received = 0
        self._packet_times: deque[float] = deque(maxlen=300)
        self._last_packet: dict[str, Any] | None = None
        self._last_requested: dict[str, Any] | None = None
        self._last_client_ts: float | None = None
        self._last_command_monotonic: float | None = None
        self._armed = False
        self._estop = False
        self._drive_mode: DriveMode = self._coerce_drive_mode(config.default_mode)

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
            self.send_neutral(brake=True, estop=True)

    def handle_client_packet(self, packet: ClientControlPacket) -> dict[str, Any]:
        requested_throttle = clamp_unit(packet.throttle)
        requested_steering = clamp_unit(packet.steering)

        with self._lock:
            self._packets_received += 1
            now = time.monotonic()
            self._packet_times.append(now)
            self._last_client_ts = time.time()
            self._last_command_monotonic = now
            self._last_requested = {
                "seq": packet.seq,
                "throttle": requested_throttle,
                "steering": requested_steering,
                "brake": bool(packet.brake),
                "armed": packet.armed,
                "estop": packet.estop,
                "mode": packet.mode,
                "client_ts": packet.client_ts,
            }

            if packet.mode in DRIVE_LIMITS:
                self._drive_mode = packet.mode  # type: ignore[assignment]

            if packet.estop is True or packet.brake or packet.mode == "estop":
                self._estop = True

            if packet.armed is not None and packet.armed != self._armed:
                if packet.armed:
                    if self._is_neutral_locked() and not self._estop:
                        self._armed = True
                    else:
                        LOGGER.warning("arm request ignored; throttle not neutral or estop active")
                else:
                    self._armed = False

            payload = self._build_serial_packet_locked(requested_throttle, requested_steering, bool(packet.brake))

        self.serial_link.send(payload, priority=payload["brake"] or payload["mode"] == "estop")
        return payload

    def send_neutral(self, brake: bool = False, estop: bool = False) -> dict[str, Any]:
        with self._lock:
            if estop:
                self._estop = True
                self._armed = False
            self._last_requested = {
                "seq": None,
                "throttle": 0.0,
                "steering": 0.0,
                "brake": brake or estop,
                "armed": self._armed,
                "estop": self._estop,
                "mode": self._drive_mode,
                "client_ts": None,
            }
            payload = self._build_serial_packet_locked(0.0, 0.0, brake or estop)
        self.serial_link.send(payload, priority=payload["brake"] or payload["mode"] == "estop")
        return payload

    def set_armed(self, armed: bool) -> dict[str, Any]:
        with self._lock:
            if armed and (not self._is_neutral_locked() or self._estop):
                return {"ok": False, "armed": self._armed, "reason": "neutral throttle required and estop must be clear"}
            self._armed = armed
            if not armed:
                self._last_requested = {
                    "seq": None,
                    "throttle": 0.0,
                    "steering": 0.0,
                    "brake": False,
                    "armed": False,
                    "estop": self._estop,
                    "mode": self._drive_mode,
                    "client_ts": None,
                }
                payload = self._build_serial_packet_locked(0.0, 0.0, False)
            else:
                payload = None
        if payload:
            self.serial_link.send(payload, priority=True)
        return {"ok": True, "armed": armed}

    def set_estop(self) -> dict[str, Any]:
        packet = self.send_neutral(brake=True, estop=True)
        return {"ok": True, "packet": packet}

    def clear_estop(self) -> dict[str, Any]:
        with self._lock:
            if not self._is_neutral_locked():
                return {"ok": False, "estop": self._estop, "reason": "throttle must be neutral"}
            self._estop = False
            self._last_requested = {
                "seq": None,
                "throttle": 0.0,
                "steering": 0.0,
                "brake": False,
                "armed": self._armed,
                "estop": False,
                "mode": self._drive_mode,
                "client_ts": None,
            }
            packet = self._build_serial_packet_locked(0.0, 0.0, False)
        self.serial_link.send(packet, priority=True)
        return {"ok": True, "estop": False, "packet": packet}

    def set_mode(self, mode: str) -> dict[str, Any]:
        drive_mode = self._coerce_drive_mode(mode)
        with self._lock:
            self._drive_mode = drive_mode
            packet = None
            if drive_mode == "bench":
                self._last_requested = {
                    "seq": None,
                    "throttle": 0.0,
                    "steering": 0.0,
                    "brake": False,
                    "armed": self._armed,
                    "estop": self._estop,
                    "mode": self._drive_mode,
                    "client_ts": None,
                }
                packet = self._build_serial_packet_locked(0.0, 0.0, False)
        if packet:
            self.serial_link.send(packet, priority=True)
        return {"ok": True, "mode": drive_mode}

    def status(self, serial_status: dict[str, Any] | None = None) -> dict[str, Any]:
        with self._lock:
            return self._status_locked(serial_status)

    def telemetry(self, serial_status: dict[str, Any] | None = None) -> dict[str, Any]:
        with self._lock:
            serial_mode = (serial_status or {}).get("mode", "unknown")
            last_age = self._last_command_age_ms_locked()
            packet = self._last_packet or {}
            throttle = float(packet.get("throttle", 0.0))
            steering = float(packet.get("steering", 0.0))
            mock = serial_mode != "serial"
            return {
                "source": "mock" if mock else "serial",
                "mock": mock,
                "armed": self._armed,
                "failsafe": last_age is None or last_age > 300,
                "last_control_age_ms": last_age,
                "throttle_pwm_us": self._mix_pwm(throttle, 1000, 1500, 2000) if mock else None,
                "steering_pwm_us": self._mix_pwm(steering, 1000, 1500, 2000) if mock else None,
                "battery_voltage": self.telemetry_config.mock_battery_voltage if mock else None,
            }

    def websocket_status_message(self, serial_status: dict[str, Any]) -> dict[str, Any]:
        return {"type": "status", **self.status(serial_status)}

    def _build_serial_packet_locked(self, throttle: float, steering: float, brake_request: bool) -> dict[str, Any]:
        drive_limits = DRIVE_LIMITS[self._drive_mode]
        throttle = clamp_unit(throttle) * drive_limits["throttle"]
        steering = clamp_unit(steering) * drive_limits["steering"]

        safety_stop = self._estop or brake_request
        if safety_stop or not self._armed or self._drive_mode == "bench":
            throttle = 0.0
        if safety_stop or not self._armed:
            steering = 0.0

        self._seq += 1
        serial_packet = SerialControlPacket(
            seq=self._seq,
            throttle=throttle,
            steering=steering,
            brake=safety_stop,
            mode="estop" if safety_stop else "normal",
            armed=self._armed,
            estop=self._estop,
            drive_mode=self._drive_mode,
            ts=_now_ms(),
        )
        payload = serial_packet.model_dump()
        self._last_packet = payload
        self._last_command_monotonic = time.monotonic()
        return payload

    def _status_locked(self, serial_status: dict[str, Any] | None) -> dict[str, Any]:
        now = time.monotonic()
        while self._packet_times and now - self._packet_times[0] > 2.0:
            self._packet_times.popleft()
        pps = len(self._packet_times) / 2.0
        serial_status = serial_status or {}
        telemetry = self.telemetry(serial_status) if not self._lock.locked() else self._telemetry_locked(serial_status)
        return {
            "clients": self._client_count,
            "seq": self._seq,
            "packets_received": self._packets_received,
            "packets_per_second": round(pps, 2),
            "last_command_age_ms": self._last_command_age_ms_locked(),
            "last_packet": self._last_packet,
            "last_requested": self._last_requested,
            "last_client_ts": self._last_client_ts,
            "send_rate_hz": self.config.send_rate_hz,
            "armed": self._armed,
            "estop": self._estop,
            "mode": self._drive_mode,
            "serial": serial_status,
            "telemetry": telemetry,
        }

    def _telemetry_locked(self, serial_status: dict[str, Any]) -> dict[str, Any]:
        serial_mode = serial_status.get("mode", "unknown")
        last_age = self._last_command_age_ms_locked()
        packet = self._last_packet or {}
        throttle = float(packet.get("throttle", 0.0))
        steering = float(packet.get("steering", 0.0))
        mock = serial_mode != "serial"
        return {
            "source": "mock" if mock else "serial",
            "mock": mock,
            "armed": self._armed,
            "failsafe": last_age is None or last_age > 300,
            "last_control_age_ms": last_age,
            "throttle_pwm_us": self._mix_pwm(throttle, 1000, 1500, 2000) if mock else None,
            "steering_pwm_us": self._mix_pwm(steering, 1000, 1500, 2000) if mock else None,
            "battery_voltage": self.telemetry_config.mock_battery_voltage if mock else None,
        }

    def _last_command_age_ms_locked(self) -> int | None:
        if self._last_command_monotonic is None:
            return None
        return int((time.monotonic() - self._last_command_monotonic) * 1000)

    def _is_neutral_locked(self) -> bool:
        if self._last_requested is None:
            return True
        return abs(float(self._last_requested.get("throttle", 0.0))) <= 0.01

    @staticmethod
    def _mix_pwm(value: float, min_us: int, neutral_us: int, max_us: int) -> int:
        value = clamp_unit(value)
        if value >= 0:
            return int(neutral_us + (max_us - neutral_us) * value)
        return int(neutral_us - (neutral_us - min_us) * abs(value))

    @staticmethod
    def _coerce_drive_mode(mode: str) -> DriveMode:
        normalized = str(mode).lower()
        if normalized in DRIVE_LIMITS:
            return normalized  # type: ignore[return-value]
        return "bench"
