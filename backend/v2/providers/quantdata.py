from __future__ import annotations

import math
import os
import re
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests

from ..math_utils import clamp, parse_utc, safe_ratio, utc_iso


BASE_URL = "https://api.quantdata.us/v1"


def load_quantdata_key() -> str:
    value = os.environ.get("QUANTDATA_API_KEY", "").strip() or os.environ.get("QD_API_KEY", "").strip()
    if not value:
        path = Path.home() / "Documents" / "Api keys" / "API-key - quant data.txt"
        if path.is_file():
            match = re.search(r"qd_[A-Za-z0-9_-]{32}", path.read_text(encoding="utf-8-sig"))
            value = match.group(0) if match else ""
    if not re.fullmatch(r"qd_[A-Za-z0-9_-]{32}", value):
        raise RuntimeError("Quant Data credential is missing or malformed")
    return value


@dataclass
class ProviderResult:
    data: Any
    provider_event_time: str | None
    local_receive_time: str
    latency_ms: float
    status: str
    error_code: str | None = None


class QuantDataClient:
    """Read-only REST adapter with last-good snapshots and bounded retry/backoff."""

    def __init__(self, api_key: str | None = None) -> None:
        self.key = api_key or load_quantdata_key()
        self.session = requests.Session()
        self.session.headers.update({"Authorization": f"Bearer {self.key}", "Content-Type": "application/json"})
        self.last_good: dict[str, ProviderResult] = {}
        self.next_allowed = 0.0
        self.lock = threading.Lock()

    def post(self, name: str, path: str, payload: dict[str, Any], timeout: float = 20.0) -> ProviderResult:
        with self.lock:
            wait = self.next_allowed - time.monotonic()
            if wait > 0.0:
                time.sleep(min(wait, 1.0))
            started = time.perf_counter()
            try:
                response = self.session.post(BASE_URL + path, json=payload, timeout=timeout)
                latency = (time.perf_counter() - started) * 1000.0
                if response.status_code == 429:
                    retry = min(float(response.headers.get("Retry-After", "1") or 1), 30.0)
                    self.next_allowed = time.monotonic() + retry
                    return ProviderResult(None, None, utc_iso(), latency, "DEGRADED", "RATE_LIMITED")
                response.raise_for_status()
                body = response.json()
                event_time = latest_provider_time(body)
                result = ProviderResult(body, event_time, utc_iso(), latency, "LIVE")
                self.last_good[name] = result
                self.next_allowed = time.monotonic() + 0.01
                return result
            except (requests.RequestException, ValueError) as exc:
                latency = (time.perf_counter() - started) * 1000.0
                cached = self.last_good.get(name)
                if cached:
                    return ProviderResult(cached.data, cached.provider_event_time, utc_iso(), latency, "DEGRADED", type(exc).__name__)
                return ProviderResult(None, None, utc_iso(), latency, "UNAVAILABLE", type(exc).__name__)

    def order_flow(self, symbol: str, size: int = 1000) -> ProviderResult:
        return self.post(
            f"{symbol}:order_flow",
            "/options/tool/order-flow/unconsolidated",
            {
                "filter": {"ticker": symbol},
                "size": min(max(size, 1), 1000),
                "sort": {"field": "tradeTime", "direction": "DESCENDING"},
                "includes": ["TICKER", "OSI", "CONTRACT_TYPE", "EXPIRATION_DATE", "DTE", "STRIKE_PRICE", "SIZE", "TRADE_SIDE_CODE", "GREEKS", "TRADE_TIME"],
            },
        )

    def term_structure(self, symbol: str) -> ProviderResult:
        return self.post(f"{symbol}:term", "/options/tool/term-structure", {"filter": {"ticker": symbol}})

    def volatility_skew(self, symbol: str) -> ProviderResult:
        return self.post(f"{symbol}:skew", "/options/tool/volatility-skew", {"filter": {"ticker": symbol}})

    def open_interest(self, symbol: str, expiration: str | None = None) -> ProviderResult:
        filters: dict[str, Any] = {"ticker": symbol}
        if expiration:
            filters["expirationDate"] = expiration
        return self.post(f"{symbol}:oi:{expiration or 'all'}", "/options/tool/open-interest-by-strike", {"filter": filters})

    def exposure(self, symbol: str, greek: str) -> ProviderResult:
        mode = greek.upper()
        if mode not in {"GAMMA", "DELTA", "VANNA", "CHARM"}:
            raise ValueError("Unsupported Quant Data exposure mode")
        return self.post(
            f"{symbol}:exposure:{mode}",
            "/options/tool/exposure-by-strike",
            {"greekMode": mode, "representationMode": "PER_ONE_PERCENT_MOVE", "filter": {"ticker": symbol}},
        )

    def stock_price_history(self, symbol: str, start_time: str, end_time: str, aggregation_period: str = "15m") -> ProviderResult:
        return self.post(
            f"{symbol}:stock_price:{aggregation_period}",
            "/equities/tool/stock-price-over-time",
            {
                "timeRange": {"startTime": start_time, "endTime": end_time},
                "aggregationPeriod": aggregation_period,
                "filter": {"ticker": symbol},
            },
        )


def latest_provider_time(value: Any) -> str | None:
    newest: float | None = None

    def visit(item: Any, key: str = "") -> None:
        nonlocal newest
        if isinstance(item, dict):
            for child_key, child in item.items():
                if str(child_key).isdigit() and len(str(child_key)) >= 10:
                    number = float(child_key)
                    if number > 10_000_000_000:
                        number /= 1000.0
                    newest = number if newest is None else max(newest, number)
                if str(child_key).lower() in {"tradetime", "time", "timestamp", "snapshottime"} and isinstance(child, (int, float)):
                    number = float(child)
                    if number > 10_000_000_000:
                        number /= 1000.0
                    newest = number if newest is None else max(newest, number)
                elif str(child_key).lower() in {"tradetime", "time", "timestamp", "snapshottime"}:
                    parsed = parse_utc(child)
                    if parsed is not None:
                        number = parsed.timestamp()
                        newest = number if newest is None else max(newest, number)
                visit(child, str(child_key))
        elif isinstance(item, list):
            for child in item:
                visit(child, key)

    visit(value)
    return datetime.fromtimestamp(newest, tz=timezone.utc).isoformat() if newest is not None else None


def option_flow_evidence(rows: list[dict[str, Any]], horizons: tuple[int, ...] = (10, 30, 120)) -> dict[str, Any]:
    trade_times = [float(row.get("tradeTime")) / 1000.0 for row in rows if isinstance(row.get("tradeTime"), (int, float))]
    reference = max(trade_times) if trade_times else 0.0
    output: dict[str, Any] = {"provider_event_time": datetime.fromtimestamp(reference, timezone.utc).isoformat() if reference else None, "horizons": {}}
    for horizon in horizons:
        numerator = denominator = 0.0
        trades = 0
        for row in rows:
            raw_time = row.get("tradeTime")
            if not isinstance(raw_time, (int, float)) or float(raw_time) / 1000.0 < reference - horizon:
                continue
            contract_type = str(row.get("contractType") or "").upper()
            side = str(row.get("tradeSideCode") or "").upper()
            greeks = row.get("greeks") if isinstance(row.get("greeks"), dict) else {}
            try:
                delta = abs(float(greeks.get("delta")))
                size = max(float(row.get("size") or 0.0), 0.0)
            except (TypeError, ValueError):
                continue
            direction = 0.0
            # Quant Data codes: A/AA are ask/above-ask, B/BB are
            # bid/below-bid, and M is mid/neutral.
            at_ask = side in {"A", "AA", "ASK", "AT_ASK", "ABOVE_ASK"}
            at_bid = side in {"B", "BB", "BID", "AT_BID", "BELOW_BID"}
            if contract_type == "CALL":
                direction = 1.0 if at_ask else -1.0 if at_bid else 0.0
            elif contract_type == "PUT":
                direction = -1.0 if at_ask else 1.0 if at_bid else 0.0
            weight = delta * size
            numerator += direction * weight
            denominator += weight
            trades += 1
        output["horizons"][str(horizon)] = {
            "evidence": clamp(safe_ratio(numerator, denominator), -1.0, 1.0),
            "weighted_size": denominator,
            "trade_count": trades,
        }
    values = [bucket["evidence"] for bucket in output["horizons"].values() if bucket["trade_count"] > 0]
    output["evidence"] = sum(values) / len(values) if values else 0.0
    return output


def exposure_concentrations(result: ProviderResult, symbol: str, expirations: set[str], limit: int = 5) -> list[dict[str, Any]]:
    try:
        node = result.data["data"][symbol]["exposureMap"]
    except (TypeError, KeyError):
        return []
    totals: dict[float, float] = {}
    for expiration, strikes in node.items():
        if expirations and expiration not in expirations:
            continue
        for strike, cell in strikes.items():
            value = sum(float(item or 0.0) for item in cell.values()) if isinstance(cell, dict) else 0.0
            totals[float(strike)] = totals.get(float(strike), 0.0) + value
    ranked = sorted(totals.items(), key=lambda item: (-abs(item[1]), item[0]))[:limit]
    return [{"strike": strike, "net_exposure": value, "prominence": abs(value) / max((abs(v) for v in totals.values()), default=1.0)} for strike, value in ranked]


def open_interest_concentrations(result: ProviderResult, spot: float, limit: int = 5, window_pct: float = 0.10) -> list[dict[str, Any]]:
    """Return slow positioning concentrations without assigning direction."""
    node = result.data.get("data") if isinstance(result.data, dict) else None
    if not isinstance(node, dict) or spot <= 0.0:
        return []
    totals: dict[float, float] = {}
    for strike_text, cell in node.items():
        try:
            strike = float(strike_text)
        except (TypeError, ValueError):
            continue
        if abs(strike - spot) / spot > window_pct or not isinstance(cell, dict):
            continue
        total = max(float(cell.get("callOpenInterest") or 0.0), 0.0) + max(float(cell.get("putOpenInterest") or 0.0), 0.0)
        if total > 0.0:
            totals[strike] = total
    maximum = max(totals.values(), default=1.0)
    ranked = sorted(totals.items(), key=lambda item: (-item[1], item[0]))[:limit]
    return [{"strike": strike, "open_interest": value, "prominence": value / maximum} for strike, value in ranked]
