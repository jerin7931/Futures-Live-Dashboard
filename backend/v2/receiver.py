from __future__ import annotations

import json
import socket
import threading
import time
from typing import Any

from .math_utils import utc_iso


class LatestUdpReceiver:
    def __init__(self, port: int = 48637) -> None:
        self.port = port
        self.lock = threading.Lock()
        self.latest: dict[str, dict[str, Any]] = {}
        self.stop_event = threading.Event()
        self.thread: threading.Thread | None = None

    def start(self) -> None:
        self.thread = threading.Thread(target=self._run, daemon=True, name="v2-orderflow-udp")
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()

    def snapshot(self) -> dict[str, dict[str, Any]]:
        with self.lock:
            return {key: dict(value) for key, value in self.latest.items()}

    def _run(self) -> None:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1 << 20)
        sock.settimeout(0.25)
        sock.bind(("127.0.0.1", self.port))
        try:
            while not self.stop_event.is_set():
                try:
                    raw, _ = sock.recvfrom(65535)
                except socket.timeout:
                    continue
                try:
                    payload = json.loads(raw)
                except (UnicodeDecodeError, json.JSONDecodeError):
                    continue
                symbol = str(payload.get("symbol") or "").upper()
                if payload.get("type") != "options_orderflow_snapshot_v2" or symbol not in {"ES", "NQ"}:
                    continue
                payload["bridge_receive_time"] = utc_iso()
                payload["bridge_receive_monotonic"] = time.monotonic()
                with self.lock:
                    prior = self.latest.get(symbol)
                    if prior and int(payload.get("sequence") or 0) <= int(prior.get("sequence") or 0):
                        continue
                    self.latest[symbol] = payload
        finally:
            sock.close()
