"""Loopback receiver for side-by-side completed-second ES/NQ summaries."""

from __future__ import annotations

import json
import socket
import threading
from typing import Any, Callable


class PredictiveLevel1Receiver:
    def __init__(self, consume: Callable[[dict[str, Any]], None], port: int = 48638) -> None:
        self.consume = consume
        self.port = port
        self.stop_event = threading.Event()
        self.thread: threading.Thread | None = None
        self.last_sequence: dict[str, int] = {}

    def start(self) -> None:
        if self.thread and self.thread.is_alive():
            return
        self.thread = threading.Thread(target=self._run, name="predictive-level1-udp", daemon=True)
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()

    def _run(self) -> None:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1 << 20)
        sock.settimeout(0.25); sock.bind(("127.0.0.1", self.port))
        try:
            while not self.stop_event.is_set():
                try:
                    raw, _address = sock.recvfrom(8192)
                except socket.timeout:
                    continue
                try:
                    row = json.loads(raw)
                    instrument = str(row.get("instrument") or "").upper()
                    sequence = int(row.get("sequence") or -1)
                except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError):
                    continue
                if row.get("type") != "predictive_level1_second_v1" or instrument not in {"ES", "NQ"}:
                    continue
                if sequence <= self.last_sequence.get(instrument, -1):
                    continue
                self.last_sequence[instrument] = sequence
                self.consume(row)
        finally:
            sock.close()
