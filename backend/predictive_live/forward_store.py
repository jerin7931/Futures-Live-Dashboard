"""Bounded asynchronous append-only forward-data persistence."""

from __future__ import annotations

import json
import math
import queue
import re
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


SECRET_KEY_PATTERN = re.compile(r"(?i)(api[_-]?key|secret|authorization|signature|service[_-]?role|password)")


def _sanitize(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _sanitize(item) for key, item in value.items() if not SECRET_KEY_PATTERN.search(str(key))}
    if isinstance(value, list):
        return [_sanitize(item) for item in value]
    if isinstance(value, tuple):
        return [_sanitize(item) for item in value]
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


@dataclass(frozen=True)
class WriteItem:
    dataset: str
    timestamp: datetime
    payload: dict[str, Any]


class AsyncForwardRecorder:
    DATASETS = {
        "model_events", "option_quotes", "option_ladder", "gex", "market_context",
        "invalidation_events", "provider_health", "latency",
    }

    def __init__(self, root: Path, max_queue: int = 20_000):
        self.root = root.resolve()
        self.queue: queue.Queue[WriteItem | None] = queue.Queue(maxsize=max_queue)
        self._thread = threading.Thread(target=self._run, name="predictive-forward-writer", daemon=True)
        self._errors: list[str] = []
        self._written = 0
        self._dropped = 0
        self._thread.start()

    def submit(self, dataset: str, payload: dict[str, Any], timestamp: datetime | None = None) -> None:
        if dataset not in self.DATASETS:
            raise ValueError(f"Unknown forward dataset: {dataset}")
        stamp = timestamp or datetime.now(timezone.utc)
        try:
            self.queue.put_nowait(WriteItem(dataset, stamp, _sanitize(payload)))
        except queue.Full:
            self._dropped += 1

    def _run(self) -> None:
        while True:
            item = self.queue.get()
            if item is None:
                self.queue.task_done()
                return
            try:
                folder = self.root / item.dataset / item.timestamp.strftime("%Y-%m-%d")
                folder.mkdir(parents=True, exist_ok=True)
                path = folder / "events.jsonl"
                row = {"recorded_at": item.timestamp.isoformat(), **item.payload}
                with path.open("a", encoding="utf-8", newline="\n") as handle:
                    handle.write(json.dumps(row, separators=(",", ":"), allow_nan=False) + "\n")
                self._written += 1
            except Exception as exc:  # writer must never stall inference
                self._errors.append(f"{type(exc).__name__}: {exc}")
                self._errors[:] = self._errors[-20:]
            finally:
                self.queue.task_done()

    def health(self) -> dict[str, Any]:
        return {"status": "ERROR" if self._errors or self._dropped else "LIVE", "queued": self.queue.qsize(), "written": self._written, "dropped": self._dropped, "errors": list(self._errors)}

    def close(self, timeout: float = 5.0) -> None:
        self.queue.put(None)
        self._thread.join(timeout=timeout)


class AsyncPublishQueue:
    """Priority/coalesced current-state transport isolated from inference."""

    HIGH = {"predictive_model_state_live", "predictive_provider_health_live"}
    MEDIUM = {"predictive_market_context_live", "predictive_gex_surface_live"}

    def __init__(self, publish: Callable[[str, dict[str, Any]], None] | None, max_queue: int = 1000):
        self.publish = publish
        self.queue: queue.PriorityQueue[tuple[int, int, str]] = queue.PriorityQueue()
        self.max_queue = max_queue
        self.lock = threading.Lock()
        self.pending: dict[str, tuple[int, int, str, dict[str, Any], float]] = {}
        self.sequence = 0
        self.errors: list[str] = []
        self.dropped = 0
        self.ack_latency_ms: list[float] = []
        self.closed = False
        self._thread = threading.Thread(target=self._run, name="predictive-publisher", daemon=True)
        self._thread.start()

    @staticmethod
    def _key(channel: str, payload: dict[str, Any]) -> str:
        if channel == "predictive_model_state_live":
            identity = payload.get("model_id")
        elif channel == "predictive_provider_health_live":
            identity = payload.get("provider")
        elif channel == "predictive_market_context_live":
            identity = payload.get("symbol")
        elif channel == "predictive_gex_surface_live":
            identity = f"{payload.get('symbol')}:{payload.get('surface_kind')}:{payload.get('scope')}"
        elif channel == "predictive_option_ladder_live" and isinstance(payload.get("_batch"), list):
            rows = payload["_batch"]
            if len(rows) == 1:
                # Fast quote patches coalesce by contract and must not replace
                # a pending full-chain snapshot for the same symbol.
                identity = "contract:" + str(rows[0].get("contract_key") or rows[0].get("contract"))
            else:
                symbols = sorted({str(row.get("symbol")) for row in rows if row.get("symbol")})
                identity = "batch:" + ",".join(symbols)
        else:
            identity = payload.get("contract_key") or payload.get("contract")
        return f"{channel}:{identity}"

    @classmethod
    def _priority(cls, channel: str) -> int:
        return 0 if channel in cls.HIGH else 1 if channel in cls.MEDIUM else 2

    def submit(self, channel: str, payload: dict[str, Any]) -> None:
        if self.publish is None:
            return
        key = self._key(channel, payload)
        priority = self._priority(channel)
        with self.lock:
            if key not in self.pending and len(self.pending) >= self.max_queue:
                if priority == 0:
                    victims = [(item[0], name) for name, item in self.pending.items() if item[0] > priority]
                    if victims:
                        _value, victim = max(victims)
                        del self.pending[victim]
                    else:
                        self.dropped += 1; return
                else:
                    self.dropped += 1; return
            self.sequence += 1
            sequence = self.sequence
            self.pending[key] = (priority, sequence, channel, _sanitize(payload), time.perf_counter())
            self.queue.put_nowait((priority, sequence, key))

    def _run(self) -> None:
        while True:
            priority, sequence, key = self.queue.get()
            if key == "__CLOSE__":
                self.queue.task_done(); return
            with self.lock:
                item = self.pending.get(key)
                if item is None or item[1] != sequence:
                    self.queue.task_done(); continue
                del self.pending[key]
            try:
                assert self.publish is not None
                _priority, _sequence, channel, payload, enqueued = item
                self.publish(channel, payload)
                self.ack_latency_ms.append((time.perf_counter() - enqueued) * 1000.0)
                self.ack_latency_ms[:] = self.ack_latency_ms[-10_000:]
            except Exception as exc:
                self.errors.append(f"{type(exc).__name__}: {exc}")
                self.errors[:] = self.errors[-20:]
            finally:
                self.queue.task_done()

    def close(self, timeout: float = 5.0) -> None:
        self.wait_idle(timeout=max(0.1, timeout * .8))
        self.closed = True
        self.sequence += 1
        self.queue.put((-1, self.sequence, "__CLOSE__")); self._thread.join(timeout)

    def wait_idle(self, timeout: float = 5.0) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self.lock:
                if not self.pending:
                    return True
            time.sleep(0.005)
        return False

    def health(self) -> dict[str, Any]:
        with self.lock:
            pending = len(self.pending)
        values = sorted(self.ack_latency_ms)
        percentile = lambda q: values[min(len(values) - 1, int(q * (len(values) - 1)))] if values else None
        status = "DISABLED" if self.publish is None else "ERROR" if self.errors or self.dropped else "LIVE"
        return {"status": status, "pending": pending,
                "dropped": self.dropped, "errors": list(self.errors),
                "ack_p50_ms": percentile(.50), "ack_p95_ms": percentile(.95), "ack_p99_ms": percentile(.99)}
