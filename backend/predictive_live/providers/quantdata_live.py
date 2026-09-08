"""Official Quant Data REST ingestion with lossless cursor watermarking."""

from __future__ import annotations

import json
import os
import random
import tempfile
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable
from zoneinfo import ZoneInfo

import requests

from v2.math_utils import utc_iso
from v2.providers.quantdata import BASE_URL, ProviderResult, load_quantdata_key


ET = ZoneInfo("America/New_York")
PROJECTION = [
    "ID", "TICKER", "OSI", "CONTRACT_TYPE", "EXPIRATION_DATE", "DTE",
    "STRIKE_PRICE", "PREMIUM", "SIZE", "OPTION_PRICE", "STOCK_PRICE",
    "ASK_PRICE", "BID_PRICE", "BID_ASK_SPREAD", "IMPLIED_VOLATILITY",
    "TRADE_SIDE_CODE", "TRADE_TYPE", "GREEKS", "MONEYNESS", "TRADE_TIME",
    "IS_CANCELLED", "IS_COMPLEX", "IS_TIED",
]


class QuantWatermarkStore:
    """Durable per-symbol/session event-id ledger and high watermark."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.Lock()
        self.state: dict[str, Any] = {"schema_version": 1, "symbols": {}}
        if path.is_file():
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if loaded.get("schema_version") != 1:
                raise RuntimeError("Unsupported Quant watermark schema")
            self.state = loaded

    def _symbol(self, symbol: str, session_date: str) -> dict[str, Any]:
        node = self.state["symbols"].setdefault(symbol, {})
        if node.get("session_date") != session_date:
            node.clear()
            node.update({"session_date": session_date, "high_trade_time": 0,
                         "high_event_id": "", "event_ids": []})
        return node

    def snapshot(self, symbol: str, session_date: str) -> tuple[set[str], tuple[int, str]]:
        with self.lock:
            node = self._symbol(symbol, session_date)
            return set(node["event_ids"]), (int(node["high_trade_time"]), str(node["high_event_id"]))

    def acknowledge(self, symbol: str, session_date: str, row: dict[str, Any]) -> None:
        identity = str(row.get("id") or "")
        if not identity:
            raise ValueError("Quant event has no durable ID")
        key = (int(row["tradeTime"]), identity)
        with self.lock:
            node = self._symbol(symbol, session_date)
            ids = set(node["event_ids"])
            ids.add(identity)
            node["event_ids"] = sorted(ids)
            if key > (int(node["high_trade_time"]), str(node["high_event_id"])):
                node["high_trade_time"], node["high_event_id"] = key
            node["updated_at"] = utc_iso()
            self._save()

    def acknowledge_many(self, symbol: str, session_date: str, rows: list[dict[str, Any]]) -> None:
        if not rows:
            return
        with self.lock:
            node = self._symbol(symbol, session_date)
            ids = set(node["event_ids"])
            high = (int(node["high_trade_time"]), str(node["high_event_id"]))
            for row in rows:
                identity = str(row.get("id") or "")
                if not identity:
                    raise ValueError("Quant event has no durable ID")
                key = (int(row["tradeTime"]), identity)
                ids.add(identity)
                high = max(high, key)
            node["event_ids"] = sorted(ids)
            node["high_trade_time"], node["high_event_id"] = high
            node["updated_at"] = utc_iso()
            self._save()

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=self.path.parent,
                                         delete=False) as handle:
            json.dump(self.state, handle, indent=2, sort_keys=True)
            handle.write("\n")
            temporary = Path(handle.name)
        os.replace(temporary, self.path)


class QuantDataLiveClient:
    def __init__(self, api_key: str | None = None, *, state_path: Path | None = None,
                 post_override: Callable[[str, dict[str, Any]], tuple[dict[str, Any], dict[str, str]]] | None = None,
                 max_pages: int = 100) -> None:
        self.session = requests.Session()
        self.session.headers.update({"Authorization": f"Bearer {api_key or load_quantdata_key()}",
                                     "Content-Type": "application/json"})
        self.lock = threading.Lock()
        self.next_allowed = 0.0
        self.ledger = QuantWatermarkStore(state_path or Path.home() / "Documents" / "TradyticsPredictiveLive" / "state" / "quant_watermarks.json")
        self.post_override = post_override
        self.max_pages = max_pages
        self.last_poll_diagnostics: dict[str, dict[str, Any]] = {}
        self.last_successful_request_time: dict[str, str] = {}
        self.last_real_provider_event_time: dict[str, int] = {}

    def _post(self, path: str, payload: dict[str, Any]) -> tuple[dict[str, Any], dict[str, str]]:
        if self.post_override is not None:
            return self.post_override(path, payload)
        with self.lock:
            delay = self.next_allowed - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            response = self.session.post(BASE_URL + path, json=payload, timeout=15)
            if response.status_code == 429:
                retry = max(float(response.headers.get("Retry-After", "1") or 1), 1.0)
                self.next_allowed = time.monotonic() + retry + random.uniform(0.05, 0.50)
                raise RuntimeError("QUANT_DATA_RATE_LIMITED")
            response.raise_for_status()
            remaining = int(response.headers.get("X-RateLimit-Remaining", "100") or 100)
            reset = float(response.headers.get("X-RateLimit-Reset", "0") or 0)
            self.next_allowed = time.monotonic() + (reset / max(remaining, 1) if remaining < 10 else 0.01)
            return response.json(), dict(response.headers)

    @staticmethod
    def _base_payload(symbol: str, session_date: str, page_size: int) -> dict[str, Any]:
        return {
            "sessionDate": session_date,
            "filter": {"ticker": symbol}, "size": min(max(page_size, 1), 1000),
            "sort": {"field": "tradeTime", "direction": "DESCENDING"},
            "includes": PROJECTION,
        }

    def _walk(self, symbol: str, *, session_date: str, page_size: int,
              since_ms: int | None) -> list[dict[str, Any]]:
        known, watermark = self.ledger.snapshot(symbol, session_date)
        if watermark[0] > 0:
            self.last_real_provider_event_time[symbol] = max(
                watermark[0], self.last_real_provider_event_time.get(symbol, 0)
            )
        payload = self._base_payload(symbol, session_date, page_size)
        cursor: Any = None
        rows_by_id: dict[str, dict[str, Any]] = {}
        pages = 0
        boundary_reached = False
        cursor_seen: set[str] = set()
        while True:
            request = dict(payload)
            if cursor is not None:
                request["searchAfter"] = cursor
            body, _headers = self._post("/options/tool/order-flow/unconsolidated", request)
            pages += 1
            self.last_successful_request_time[symbol] = utc_iso()
            page = body.get("data") if isinstance(body, dict) else None
            if not isinstance(page, list):
                raise RuntimeError("QUANT_DATA_INVALID_PAGE_SHAPE")
            page_keys: list[tuple[int, str]] = []
            for row in page:
                if not isinstance(row, dict) or not row.get("id"):
                    raise RuntimeError("QUANT_DATA_EVENT_ID_MISSING")
                try:
                    key = (int(row["tradeTime"]), str(row["id"]))
                except (KeyError, TypeError, ValueError) as exc:
                    raise RuntimeError("QUANT_DATA_EVENT_TIME_INVALID") from exc
                page_keys.append(key)
                if key[1] in known:
                    boundary_reached = True
                if (since_ms is not None and key[0] >= since_ms) or (since_ms is None and key[1] not in known):
                    rows_by_id.setdefault(key[1], row)
            newest = max((key[0] for key in page_keys), default=0)
            if newest:
                self.last_real_provider_event_time[symbol] = max(newest, self.last_real_provider_event_time.get(symbol, 0))
            oldest_key = min(page_keys, default=(0, ""))
            reached_since = since_ms is not None and page_keys and oldest_key[0] < since_ms
            # Do not stop inside the watermark millisecond. The provider sorts
            # by tradeTime and its opaque cursor is the authority for ties, so
            # every page sharing that millisecond must be walked before the
            # durable boundary is complete.
            reached_watermark = (since_ms is None and boundary_reached and page_keys
                                 and oldest_key[0] < watermark[0])
            cursor = body.get("nextSearchAfter") if isinstance(body, dict) else None
            if reached_since or reached_watermark or cursor is None:
                break
            cursor_token = json.dumps(cursor, sort_keys=True)
            if cursor_token in cursor_seen:
                raise RuntimeError("QUANT_DATA_CURSOR_LOOP")
            cursor_seen.add(cursor_token)
            if pages >= self.max_pages:
                raise RuntimeError("QUANT_DATA_PAGINATION_SAFETY_LIMIT")
        fresh = sorted(rows_by_id.values(), key=lambda row: (int(row["tradeTime"]), str(row["id"])))
        gaps = [int(right["tradeTime"]) - int(left["tradeTime"]) for left, right in zip(fresh, fresh[1:])]
        self.last_poll_diagnostics[symbol] = {
            "session_date": session_date, "pages": pages, "new_rows": len(fresh),
            "boundary_reached": boundary_reached, "since_ms": since_ms,
            "oldest_event_time_ms": int(fresh[0]["tradeTime"]) if fresh else None,
            "newest_event_time_ms": int(fresh[-1]["tradeTime"]) if fresh else None,
            "max_inter_event_gap_ms": max(gaps, default=None),
            "watermark_before": [watermark[0], watermark[1]],
        }
        return fresh

    def poll_option_prints(self, symbol: str, *, session_date: str | None = None,
                           page_size: int = 1000) -> list[dict[str, Any]]:
        symbol = symbol.upper()
        if symbol not in {"SPY", "QQQ"}:
            raise ValueError("Unsupported symbol")
        day = session_date or datetime.now(ET).date().isoformat()
        return self._walk(symbol, session_date=day, page_size=page_size, since_ms=None)

    def backfill_option_prints(self, symbol: str, *, since_ms: int,
                               session_date: str | None = None, page_size: int = 1000) -> list[dict[str, Any]]:
        symbol = symbol.upper()
        day = session_date or datetime.now(ET).date().isoformat()
        return self._walk(symbol, session_date=day, page_size=page_size, since_ms=since_ms)

    def acknowledge(self, symbol: str, session_date: str, row: dict[str, Any]) -> None:
        self.ledger.acknowledge(symbol.upper(), session_date, row)

    def acknowledge_many(self, symbol: str, session_date: str, rows: list[dict[str, Any]]) -> None:
        self.ledger.acknowledge_many(symbol.upper(), session_date, rows)

    def exposure_by_strike(self, symbol: str, *, greek: str = "GAMMA") -> dict[str, Any]:
        body, _headers = self._post("/options/tool/exposure-by-strike", {
            "greekMode": greek.upper(), "representationMode": "PER_ONE_PERCENT_MOVE",
            "filter": {"ticker": symbol.upper()},
        })
        return body

    def term_structure(self, symbol: str) -> ProviderResult:
        started = time.perf_counter()
        body, _headers = self._post("/options/tool/term-structure", {"filter": {"ticker": symbol.upper()}})
        return ProviderResult(body, None, utc_iso(), (time.perf_counter() - started) * 1000.0, "LIVE")

    def net_drift(self, symbol: str, session_date: str) -> dict[str, Any]:
        body, _headers = self._post("/options/tool/net-drift", {
            "sessionDate": session_date, "aggregationPeriod": "1m", "filter": {"ticker": symbol.upper()}
        })
        return body

    def volatility_skew(self, symbol: str, session_date: str) -> dict[str, Any]:
        body, _headers = self._post("/options/tool/volatility-skew", {
            "sessionDate": session_date, "filter": {"ticker": symbol.upper()}
        })
        return body
