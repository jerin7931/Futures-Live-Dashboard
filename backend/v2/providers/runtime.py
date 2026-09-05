from __future__ import annotations

import copy
import re
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable
from zoneinfo import ZoneInfo

from ..math_utils import finite, parse_utc, utc_iso
from ..models import Candidate
from .quantdata import QuantDataClient, ProviderResult, option_flow_evidence
from .webull import WebullMarketDataClient, WebullResult


def _rows(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, list):
        return [row for row in data if isinstance(row, dict)]
    if isinstance(data, dict) and isinstance(data.get("data"), list):
        return [row for row in data["data"] if isinstance(row, dict)]
    return []


def _milliseconds_iso(value: Any) -> str | None:
    parsed = parse_utc(value)
    return parsed.isoformat() if parsed else None


def cash_snapshot_map(result: WebullResult | None) -> dict[str, dict[str, Any]]:
    output: dict[str, dict[str, Any]] = {}
    if not result:
        return output
    for row in _rows(result.data):
        symbol = str(row.get("symbol") or "").upper()
        if symbol not in {"SPY", "QQQ"}:
            continue
        # The regular-session consolidated last is primary. Extended-hours last
        # is only a fallback when the regular field is absent.
        price = finite(row.get("price")) or finite(row.get("extend_hour_last_price")) or finite(row.get("close"))
        output[symbol] = {
            "symbol": symbol,
            "price": price,
            "bid": finite(row.get("bid"), 0.0) or 0.0,
            "ask": finite(row.get("ask"), 0.0) or 0.0,
            "bid_size": finite(row.get("bid_size"), 0.0) or 0.0,
            "ask_size": finite(row.get("ask_size"), 0.0) or 0.0,
            "day_volume": finite(row.get("volume"), 0.0) or 0.0,
            "open": finite(row.get("open")),
            "high": finite(row.get("high")),
            "low": finite(row.get("low")),
            "previous_close": finite(row.get("pre_close") or row.get("previous_close")),
            "provider_event_time": _milliseconds_iso(row.get("quote_time") or row.get("last_trade_time")),
            "local_receive_time": result.local_receive_time,
            "status": result.status,
        }
    return output


def depth_snapshot(result: WebullResult | None) -> dict[str, Any]:
    rows = _rows(result.data) if result else []
    row = rows[0] if rows else (result.data if result and isinstance(result.data, dict) else {})

    def levels(*names: str) -> list[tuple[float, float]]:
        value: Any = None
        for name in names:
            if isinstance(row, dict) and row.get(name) is not None:
                value = row[name]
                break
        found: list[tuple[float, float]] = []
        for level in value if isinstance(value, list) else []:
            if not isinstance(level, dict):
                continue
            price = finite(level.get("price") or level.get("p"))
            size = finite(level.get("size") or level.get("quantity") or level.get("q"), 0.0)
            if price and size is not None:
                found.append((price, max(size, 0.0)))
        return found

    bids, asks = levels("bids", "bid_list", "bidList"), levels("asks", "ask_list", "askList")
    return {
        "bids": bids,
        "asks": asks,
        "provider_event_time": _milliseconds_iso(row.get("quote_time") if isinstance(row, dict) else None) or (result.provider_event_time if result else None),
        "local_receive_time": result.local_receive_time if result else None,
        "status": result.status if result else "UNAVAILABLE",
        "error_code": result.error_code if result else "UNAVAILABLE",
        "l2_valid": bool(len(bids) > 1 and len(asks) > 1 and result and result.status == "LIVE"),
    }


def term_surface(data: Any, expiration: str) -> dict[tuple[float, str], dict[str, Any]]:
    if not isinstance(data, dict):
        return {}
    node = data.get("data")
    if not isinstance(node, dict) or not isinstance(node.get(expiration), dict):
        return {}
    output: dict[tuple[float, str], dict[str, Any]] = {}
    for strike_text, sides in node[expiration].items():
        strike = finite(strike_text)
        if strike is None or not isinstance(sides, dict):
            continue
        for side, values in sides.items():
            option_type = str(side).upper()
            if option_type not in {"CALL", "PUT"} or not isinstance(values, dict):
                continue
            output[(strike, option_type)] = {
                "delta": finite(values.get("delta")),
                "iv": finite(values.get("iv")),
            }
    return output


def listed_expirations(data: Any, now_date: str) -> list[str]:
    node = data.get("data") if isinstance(data, dict) else None
    return sorted(key for key, value in (node or {}).items() if isinstance(value, dict) and key >= now_date)


def dte_expirations(data: Any, now_date: str) -> dict[int, str]:
    expirations = listed_expirations(data, now_date)
    selected: dict[int, str] = {}
    if now_date in expirations:
        selected[0] = now_date
    future = next((value for value in expirations if value > now_date), None)
    if future:
        selected[1] = future
    return selected


def build_candidates(
    symbol: str,
    expiration: str,
    contracts: WebullResult | None,
    quotes: WebullResult | None,
    surface_result: ProviderResult | None,
    spot: float,
) -> list[Candidate]:
    surface = term_surface(surface_result.data if surface_result else None, expiration)
    contract_map = {str(row.get("symbol")): row for row in _rows(contracts.data if contracts else None)}
    output: list[Candidate] = []
    for quote in _rows(quotes.data if quotes else None):
        osi = str(quote.get("symbol") or "")
        contract = contract_map.get(osi)
        if not contract:
            continue
        strike = finite(quote.get("strike_price") or contract.get("strike_price"))
        option_type = str(contract.get("option_type") or "").upper()
        if option_type not in {"CALL", "PUT"}:
            # OCC/OSI layout ends in YYMMDD + C/P + 8-digit strike. Avoid a
            # substring heuristic that could silently turn an unknown symbol
            # into a put.
            match = re.search(r"\d{6}([CP])\d{8}$", osi)
            option_type = "CALL" if match and match.group(1) == "C" else "PUT" if match else ""
        if strike is None or option_type not in {"CALL", "PUT"}:
            continue
        qd = surface.get((strike, option_type), {})
        delta = finite(qd.get("delta"))
        if delta is None:
            delta = finite(quote.get("delta"))
        iv = finite(qd.get("iv"))
        if iv is None:
            iv = finite(quote.get("imp_vol"))
        gamma = finite(quote.get("gamma"), 0.0) or 0.0
        bid, ask = finite(quote.get("bid"), -1.0), finite(quote.get("ask"), -1.0)
        if delta is None or iv is None or bid is None or ask is None:
            continue
        if iv > 3.0:
            iv /= 100.0
        output.append(Candidate(
            symbol=symbol,
            expiration=expiration,
            option_type=option_type,
            strike=strike,
            option_symbol=osi,
            bid=bid,
            ask=ask,
            last=finite(quote.get("price")),
            bid_size=int(finite(quote.get("bid_size"), 0.0) or 0),
            ask_size=int(finite(quote.get("ask_size"), 0.0) or 0),
            volume=int(finite(quote.get("deal_amount"), 0.0) or 0),
            open_interest=int(finite(quote.get("open_interest"), 0.0) or 0),
            delta=delta,
            gamma=gamma,
            iv=iv,
            quote_time=_milliseconds_iso(quote.get("quote_time")),
            # Quant's term-structure response currently omits an exchange event
            # timestamp.  Preserve provider time when it exists; otherwise use
            # the explicitly-labelled local snapshot receipt time so the
            # decision engine can still age (and eventually reject) the Greeks.
            greeks_time=(surface_result.provider_event_time or surface_result.local_receive_time) if surface_result else None,
            spot_at_greeks=finite(surface_result.data.get("stockPrice")) if surface_result and isinstance(surface_result.data, dict) else spot,
        ))
    return output


@dataclass
class SlowContext:
    values: dict[str, Any] = field(default_factory=dict)
    updated_at: str | None = None


class ProviderRuntime:
    """All REST calls run here; the decision hot path only copies snapshots."""

    def __init__(self, quant: QuantDataClient | None = None, webull: WebullMarketDataClient | None = None) -> None:
        self.quant = quant or QuantDataClient()
        self.webull = webull or WebullMarketDataClient()
        self.lock = threading.Lock()
        self.context = SlowContext()
        self.stop_event = threading.Event()
        self.thread: threading.Thread | None = None
        self.next_due: dict[str, float] = {}

    def start(self) -> None:
        if self.thread and self.thread.is_alive():
            return
        self.thread = threading.Thread(target=self._run, name="v2-provider-context", daemon=True)
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=5.0)

    def snapshot(self) -> SlowContext:
        with self.lock:
            return copy.deepcopy(self.context)

    def _store(self, key: str, value: Any) -> None:
        with self.lock:
            self.context.values[key] = value
            self.context.updated_at = utc_iso()

    def _due(self, key: str, interval: float, call: Callable[[], Any]) -> None:
        now = time.monotonic()
        if now < self.next_due.get(key, 0.0):
            return
        self.next_due[key] = now + interval
        try:
            self._store(key, call())
        except Exception as exc:
            self._store(key, {"status": "UNAVAILABLE", "error_code": type(exc).__name__, "local_receive_time": utc_iso()})

    def _run(self) -> None:
        while not self.stop_event.is_set():
            self._due("webull:cash", 1.2, lambda: self.webull.stock_snapshot(["SPY", "QQQ"]))
            for symbol in ("SPY", "QQQ"):
                self._due(f"webull:{symbol}:depth", 2.2, lambda s=symbol: self.webull.cash_depth(s, 10))
                self._due(f"quant:{symbol}:flow", 5.0, lambda s=symbol: self.quant.order_flow(s))
                self._due(f"quant:{symbol}:term", 60.0, lambda s=symbol: self.quant.term_structure(s))
                self._due(f"quant:{symbol}:skew", 60.0, lambda s=symbol: self.quant.volatility_skew(s))
                self._due(f"quant:{symbol}:gex", 60.0, lambda s=symbol: self.quant.exposure(s, "GAMMA"))
                self._due(f"quant:{symbol}:dex", 120.0, lambda s=symbol: self.quant.exposure(s, "DELTA"))
                self._due(f"quant:{symbol}:vanna", 120.0, lambda s=symbol: self.quant.exposure(s, "VANNA"))
                self._due(f"quant:{symbol}:charm", 120.0, lambda s=symbol: self.quant.exposure(s, "CHARM"))
                self._due(f"quant:{symbol}:oi", 900.0, lambda s=symbol: self.quant.open_interest(s))
            self._refresh_option_quotes()
            self.stop_event.wait(0.10)

    def _refresh_option_quotes(self) -> None:
        context = self.snapshot().values
        cash = cash_snapshot_map(context.get("webull:cash"))
        today = datetime.now(ZoneInfo("America/New_York")).date().isoformat()
        selected_by_market: dict[str, list[str]] = {}
        allocations = {"SPY:1DTE": 8, "SPY:0DTE": 4, "QQQ:1DTE": 4, "QQQ:0DTE": 4}
        for symbol in ("SPY", "QQQ"):
            term = context.get(f"quant:{symbol}:term")
            expirations = dte_expirations(term.data if isinstance(term, ProviderResult) else None, today)
            spot = finite(cash.get(symbol, {}).get("price"))
            if spot is None:
                continue
            for dte, expiration in sorted(expirations.items()):
                key = f"{symbol}:{dte}DTE"
                surface = term_surface(term.data if isinstance(term, ProviderResult) else None, expiration)
                strikes = [strike for (strike, _), values in surface.items() if values.get("delta") is not None and 0.50 <= abs(values["delta"]) <= 0.80]
                low, high = (min(strikes), max(strikes)) if strikes else (spot * 0.97, spot * 1.03)
                self._due(f"webull:{key}:contracts", 60.0, lambda s=symbol, e=expiration, lo=low, hi=high: self.webull.option_contracts(s, e, lo, hi))
                contracts = self.snapshot().values.get(f"webull:{key}:contracts")
                rows = [row for row in _rows(contracts.data if isinstance(contracts, WebullResult) else None) if str(row.get("style") or "").upper() == "AMERICAN"]
                def contract_rank(row: dict[str, Any]) -> tuple[float, float, str]:
                    strike = finite(row.get("strike_price"), spot) or spot
                    side = str(row.get("option_type") or "").upper()
                    delta = finite(surface.get((strike, side), {}).get("delta"))
                    return (abs(abs(delta) - 0.65) if delta is not None else 1.0, abs(strike - spot), str(row.get("symbol") or ""))
                calls = sorted((row for row in rows if str(row.get("option_type") or "").upper() == "CALL"), key=contract_rank)
                puts = sorted((row for row in rows if str(row.get("option_type") or "").upper() == "PUT"), key=contract_rank)
                limit = allocations.get(key, 4)
                half = limit // 2
                selected = sorted([*calls[:half], *puts[:limit - half]], key=contract_rank)
                selected_by_market[key] = [str(row.get("symbol")) for row in selected if row.get("symbol")]
        flattened: list[str] = []
        for key in ("SPY:1DTE", "SPY:0DTE", "QQQ:1DTE", "QQQ:0DTE"):
            for symbol in selected_by_market.get(key, []):
                if symbol not in flattened:
                    flattened.append(symbol)
        if flattened and time.monotonic() >= self.next_due.get("webull:options:batch", 0.0):
            self.next_due["webull:options:batch"] = time.monotonic() + 1.2
            try:
                result = self.webull.option_snapshots(flattened[:20])
            except Exception as exc:
                result = {"status": "UNAVAILABLE", "error_code": type(exc).__name__, "local_receive_time": utc_iso()}
            for key in selected_by_market:
                self._store(f"webull:{key}:quotes", result)


def quant_flow_snapshot(context: SlowContext, symbol: str) -> dict[str, Any]:
    result = context.values.get(f"quant:{symbol}:flow")
    return option_flow_evidence(_rows(result.data)) if isinstance(result, ProviderResult) else {"evidence": 0.0, "horizons": {}, "provider_event_time": None}
