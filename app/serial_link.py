from __future__ import annotations

import json
import logging
import queue
import threading
import time
from typing import Any

from app.config import SerialConfig

try:
    import serial
except ImportError:  # pragma: no cover - dependency is declared but keep mock mode resilient.
    serial = None


LOGGER = logging.getLogger(__name__)


class SerialLink:
    """Non-blocking serial writer with mock fallback.

    The WebSocket receive loop must never wait for USB/UART IO. Packets are
    queued here and a worker thread owns all serial open/write/reconnect work.
    """

    def __init__(self, config: SerialConfig) -> None:
        self.config = config
        self._queue: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=config.queue_size)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self._serial = None
        self._mode = "starting"
        self._last_error: str | None = None
        self._last_sent: dict[str, Any] | None = None
        self._sent_count = 0
        self._dropped_count = 0
        self._last_mock_log = 0.0
        self._next_connect_attempt = 0.0

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="serial-link", daemon=True)
        self._thread.start()

    def close(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
        self._close_serial()

    def send(self, packet: dict[str, Any], priority: bool = False) -> None:
        if priority:
            self._clear_queue(log=True)
        else:
            self._clear_queue(log=False)
        try:
            self._queue.put_nowait(packet)
        except queue.Full:
            with self._lock:
                self._dropped_count += 1
            try:
                self._queue.get_nowait()
            except queue.Empty:
                pass
            try:
                self._queue.put_nowait(packet)
            except queue.Full:
                LOGGER.warning("serial queue full; dropping control packet seq=%s", packet.get("seq"))

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {
                "mode": self._mode,
                "port": self.config.port,
                "baud_rate": self.config.baud_rate,
                "queue_depth": self._queue.qsize(),
                "sent_count": self._sent_count,
                "dropped_count": self._dropped_count,
                "last_error": self._last_error,
                "last_sent": self._last_sent,
            }

    def _run(self) -> None:
        while not self._stop.is_set():
            self._ensure_connection()
            try:
                packet = self._queue.get(timeout=0.1)
            except queue.Empty:
                continue
            self._write_packet(packet)

    def _ensure_connection(self) -> None:
        if self._serial is not None:
            return

        now = time.monotonic()
        if now < self._next_connect_attempt:
            return

        if serial is None:
            with self._lock:
                self._last_error = "pyserial is not installed"
            self._enter_mock_or_sleep()
            return

        try:
            self._serial = serial.Serial(
                self.config.port,
                self.config.baud_rate,
                timeout=self.config.connect_timeout_s,
                write_timeout=self.config.connect_timeout_s,
            )
            with self._lock:
                self._mode = "serial"
                self._last_error = None
            LOGGER.info("serial connected on %s at %s baud", self.config.port, self.config.baud_rate)
            self._drop_stale_controls_after_connect()
        except Exception as exc:  # noqa: BLE001 - serial raises platform-specific exceptions.
            with self._lock:
                self._last_error = str(exc)
            self._enter_mock_or_sleep()

    def _enter_mock_or_sleep(self) -> None:
        self._next_connect_attempt = time.monotonic() + self.config.reconnect_interval_s
        if self.config.mock_when_missing:
            with self._lock:
                if self._mode != "mock":
                    LOGGER.warning("serial unavailable; entering mock mode: %s", self._last_error)
                self._mode = "mock"
            return
        with self._lock:
            self._mode = "disconnected"

    def _write_packet(self, packet: dict[str, Any]) -> None:
        line = json.dumps(packet, separators=(",", ":")) + "\n"
        if self._mode == "mock":
            self._record_sent(packet)
            now = time.monotonic()
            if now - self._last_mock_log > 1.0:
                LOGGER.info("mock serial packet: %s", line.strip())
                self._last_mock_log = now
            return

        if self._serial is None:
            self._ensure_connection()
            if self._serial is None:
                return

        try:
            self._serial.write(line.encode("utf-8"))
            self._record_sent(packet)
        except Exception as exc:  # noqa: BLE001
            with self._lock:
                self._last_error = str(exc)
                self._mode = "disconnected"
            LOGGER.warning("serial write failed; will reconnect: %s", exc)
            self._close_serial()

    def _record_sent(self, packet: dict[str, Any]) -> None:
        with self._lock:
            self._last_sent = packet
            self._sent_count += 1

    def _close_serial(self) -> None:
        if self._serial is not None:
            try:
                self._serial.close()
            except Exception:  # noqa: BLE001
                LOGGER.debug("serial close failed", exc_info=True)
        self._serial = None

    def _clear_queue(self, log: bool) -> None:
        dropped = 0
        while True:
            try:
                self._queue.get_nowait()
                dropped += 1
            except queue.Empty:
                break
        if dropped:
            with self._lock:
                self._dropped_count += dropped
            if log:
                LOGGER.warning("cleared %s queued control packets before priority safety packet", dropped)

    def _drop_stale_controls_after_connect(self) -> None:
        dropped = 0
        safety_packet: dict[str, Any] | None = None
        while True:
            try:
                packet = self._queue.get_nowait()
            except queue.Empty:
                break
            if packet.get("brake") is True or packet.get("mode") == "estop":
                safety_packet = packet
            else:
                dropped += 1

        if safety_packet is not None:
            self._queue.put_nowait(safety_packet)
        if dropped:
            with self._lock:
                self._dropped_count += dropped
            LOGGER.warning("dropped %s stale control packets after serial reconnect", dropped)
