#!/usr/bin/env python3
"""ES/NQ order-flow + SPY/QQQ options paper-signal service.

The service has three deliberately separate paths:

* NinjaTrader sends 100 ms ES/NQ feature snapshots over loopback UDP.
* Deterministic Python scoring selects a liquid 0.60-0.70 delta contract.
* Ollama may explain an already-selected contract, but never touches the hot path.

No broker API is present and this process cannot place an order.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import socket
import statistics
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Optional
from zoneinfo import ZoneInfo


VERSION = "TRADYTICS_OPTIONS_SIGNAL_ENGINE_1_0_0"
UDP_HOST = "127.0.0.1"
UDP_PORT = 48636
OPTION_SITE = "https://www.optionchainlive.com"
OPTION_POLL_SECONDS = 30.0
ORDERFLOW_PUBLISH_SECONDS = 0.25
SIGNAL_PUBLISH_SECONDS = 0.50
FLOW_STALE_SECONDS = 2.0
OLLAMA_URL = "http://127.0.0.1:11434"
OLLAMA_MODEL = "qwen2.5:0.5b"
USER_AGENT = "tradytics-options-command/1.0"
CHICAGO = ZoneInfo("America/Chicago")
SYMBOL_MAP = {"SPY": "ES", "QQQ": "NQ"}
REQUIRED_GREEKS = ("delta", "gamma", "iv")


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_now() -> str:
    return utc_now().isoformat()


def clamp(value: float, low: float, high: float) -> float:
    return low if value < low else high if value > high else value


def fnum(value: Any) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def inum(value: Any) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def parse_dt(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc)
    text = str(value or "").strip()
    if not text:
        return utc_now()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def request_json(
    url: str,
    *,
    method: str = "GET",
    payload: Any = None,
    headers: Optional[dict[str, str]] = None,
    timeout: float = 12.0,
) -> Any:
    body = None if payload is None else json.dumps(payload, separators=(",", ":")).encode("utf-8")
    actual_headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    if body is not None:
        actual_headers["Content-Type"] = "application/json"
    if headers:
        actual_headers.update(headers)
    req = urllib.request.Request(url, data=body, headers=actual_headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        raw = response.read()
        if not raw:
            return None
        return json.loads(raw.decode("utf-8"))


def request_text(url: str, timeout: float = 12.0) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html"})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.read().decode("utf-8", errors="replace")


def load_project_env() -> Optional[Path]:
    """Load an existing local production env without exposing it or overwriting env vars."""
    docs = Path.home() / "Documents"
    dashboard = docs / "Futures Dashboard V28"
    candidates = [
        dashboard / "FUTURES_DASHBOARD_V28_PRODUCTION_COMPLETION_KIT" / ".env",
        dashboard / "FUTURES_DASHBOARD_V28_PRODUCTION_COMPLETION_KIT" / "config" / "production.env",
        dashboard / "FUTURES_PRODUCTION_AUTOMATION_V1_0_1" / ".env",
        dashboard / "FUTURES_PRODUCTION_AUTOMATION_V1_0_1" / "config" / "production.env",
        Path(__file__).resolve().parent.parent / ".env",
    ]
    for path in candidates:
        if not path.is_file():
            continue
        for raw in path.read_text(encoding="utf-8-sig").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            if line.lower().startswith("export "):
                line = line[7:].lstrip()
            key, value = line.split("=", 1)
            key, value = key.strip(), value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            if key:
                os.environ.setdefault(key, value)
        return path
    return None


class SupabaseRest:
    def __init__(self) -> None:
        load_project_env()
        self.url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        self.key = (
            os.environ.get("SUPABASE_SECRET_KEY", "").strip()
            or os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        )
        if not self.url or not self.key:
            raise RuntimeError("SUPABASE_URL and a local Supabase secret/service key are required")

    def upsert(self, table: str, rows: list[dict[str, Any]], on_conflict: str) -> float:
        if not rows:
            return 0.0
        query = urllib.parse.urlencode({"on_conflict": on_conflict})
        headers = {
            "apikey": self.key,
            "Authorization": "Bearer " + self.key,
            "Prefer": "resolution=merge-duplicates,return=minimal",
        }
        started = time.perf_counter()
        request_json(
            f"{self.url}/rest/v1/{table}?{query}",
            method="POST",
            payload=rows,
            headers=headers,
            timeout=10,
        )
        return (time.perf_counter() - started) * 1000.0

    def select_latest_snapshot(self) -> Optional[dict[str, Any]]:
        query = urllib.parse.urlencode(
            {
                "select": "captured_at,technicals,gex_context,flowline,source_status",
                "order": "captured_at.desc",
                "limit": "1",
            }
        )
        headers = {"apikey": self.key, "Authorization": "Bearer " + self.key}
        result = request_json(f"{self.url}/rest/v1/market_snapshots?{query}", headers=headers, timeout=8)
        return result[0] if isinstance(result, list) and result else None


class OrderFlowReceiver:
    def __init__(self, host: str = UDP_HOST, port: int = UDP_PORT) -> None:
        self.host = host
        self.port = port
        self.lock = threading.Lock()
        self.latest: dict[str, dict[str, Any]] = {}
        self.running = False
        self.thread: Optional[threading.Thread] = None
        self.decode_us: list[float] = []

    def start(self) -> None:
        self.running = True
        self.thread = threading.Thread(target=self._run, name="orderflow-udp", daemon=True)
        self.thread.start()

    def stop(self) -> None:
        self.running = False

    def snapshot(self) -> dict[str, dict[str, Any]]:
        with self.lock:
            return {key: dict(value) for key, value in self.latest.items()}

    def _run(self) -> None:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1 << 20)
        sock.settimeout(0.5)
        sock.bind((self.host, self.port))
        while self.running:
            try:
                raw, _ = sock.recvfrom(65535)
            except socket.timeout:
                continue
            except OSError:
                break
            started = time.perf_counter_ns()
            try:
                payload = json.loads(raw)
                symbol = str(payload.get("symbol") or "").upper()
                if payload.get("type") != "options_orderflow_snapshot" or symbol not in {"ES", "NQ"}:
                    continue
                payload["bridge_received_at"] = iso_now()
                payload["bridge_received_monotonic"] = time.monotonic()
                with self.lock:
                    self.latest[symbol] = payload
                elapsed = (time.perf_counter_ns() - started) / 1000.0
                self.decode_us.append(elapsed)
                if len(self.decode_us) > 2048:
                    del self.decode_us[:1024]
            except (UnicodeDecodeError, json.JSONDecodeError, TypeError):
                continue
        sock.close()


@dataclass(frozen=True)
class ChainResult:
    symbol: str
    dte: int
    expiration: str
    spot: float
    rows: list[dict[str, Any]]
    latency_ms: float
    fetched_at: str


class OptionChainLiveAdapter:
    def discover_expirations(self, symbol: str) -> tuple[list[str], float]:
        started = time.perf_counter()
        page = request_text(f"{OPTION_SITE}/{symbol.lower()}-option-chain/")
        marker = 'data-expiry="'
        dates: list[str] = []
        cursor = 0
        while True:
            cursor = page.find(marker, cursor)
            if cursor < 0:
                break
            cursor += len(marker)
            candidate = page[cursor : cursor + 10]
            try:
                date.fromisoformat(candidate)
            except ValueError:
                continue
            if candidate not in dates:
                dates.append(candidate)
        if not dates:
            raise RuntimeError(f"OptionChainLive published no {symbol} expirations")
        return dates, (time.perf_counter() - started) * 1000.0

    @staticmethod
    def pick_expiration(expirations: list[str], requested_dte: int) -> str:
        today = datetime.now(CHICAGO).date()
        listed = sorted(date.fromisoformat(value) for value in expirations if date.fromisoformat(value) >= today)
        if requested_dte == 0:
            if today not in listed:
                raise RuntimeError("No 0DTE expiration is listed for the current Chicago trading date")
            return today.isoformat()
        future = [value for value in listed if value > today]
        if not future:
            raise RuntimeError("No next-session expiration is listed")
        return future[0].isoformat()

    def fetch(self, symbol: str, requested_dte: int) -> ChainResult:
        expirations, page_ms = self.discover_expirations(symbol)
        expiration = self.pick_expiration(expirations, requested_dte)
        query = urllib.parse.urlencode({"symbol": symbol, "expiration": expiration})
        started = time.perf_counter()
        payload = request_json(f"{OPTION_SITE}/api/chain?{query}")
        chain_ms = (time.perf_counter() - started) * 1000.0
        if not isinstance(payload, dict) or not isinstance(payload.get("chain"), dict):
            raise RuntimeError(f"Unexpected {symbol} option-chain response")
        spot = fnum(payload.get("underlying_price"))
        if spot is None:
            raise RuntimeError(f"{symbol} option chain has no underlying price")
        rows = self._nearby_rows(symbol, expiration, requested_dte, spot, payload["chain"])
        return ChainResult(symbol, requested_dte, expiration, spot, rows, page_ms + chain_ms, iso_now())

    @staticmethod
    def _nearby_rows(
        symbol: str,
        expiration: str,
        requested_dte: int,
        spot: float,
        payload: dict[str, Any],
    ) -> list[dict[str, Any]]:
        calls = {fnum(row.get("strike")): row for row in payload.get("calls", []) if fnum(row.get("strike")) is not None}
        puts = {fnum(row.get("strike")): row for row in payload.get("puts", []) if fnum(row.get("strike")) is not None}
        strikes = sorted(set(calls) & set(puts))
        chosen = [value for value in strikes if value < spot][-5:] + [value for value in strikes if value > spot][:5]
        if len(chosen) != 10:
            raise RuntimeError(f"{symbol} chain does not have five strikes on each side of {spot:.2f}")
        now = iso_now()
        output: list[dict[str, Any]] = []
        for strike in chosen:
            for option_type, source in (("CALL", calls[strike]), ("PUT", puts[strike])):
                bid, ask, last = fnum(source.get("bid")), fnum(source.get("ask")), fnum(source.get("last"))
                mark = (bid + ask) / 2.0 if bid is not None and ask is not None and ask >= bid and ask > 0 else last
                output.append(
                    {
                        "symbol": symbol,
                        "expiration": expiration,
                        "dte": requested_dte,
                        "option_type": option_type,
                        "strike": strike,
                        "bid": bid,
                        "ask": ask,
                        "last": last,
                        "mark": mark,
                        "delta": fnum(source.get("delta")),
                        "gamma": fnum(source.get("gamma")),
                        "theta": fnum(source.get("theta")),
                        "vega": fnum(source.get("vega")),
                        "iv": fnum(source.get("iv")),
                        "open_interest": inum(source.get("open_interest")),
                        "volume": inum(source.get("volume")),
                        "underlying_price": spot,
                        "quote_time": now,
                        "source": "OPTIONCHAINLIVE_TEST",
                        "source_latency_ms": None,
                        "updated_at": now,
                    }
                )
        return output


class SpotHistory:
    def __init__(self) -> None:
        self.rows: dict[str, list[tuple[float, float]]] = {"SPY": [], "QQQ": []}

    def add(self, symbol: str, spot: float) -> None:
        now = time.time()
        rows = self.rows[symbol]
        if rows and now - rows[-1][0] < 5 and abs(rows[-1][1] - spot) < 1e-9:
            return
        rows.append((now, spot))
        cutoff = now - 7200
        while rows and rows[0][0] < cutoff:
            rows.pop(0)

    def stats(self, symbol: str) -> dict[str, Optional[float]]:
        rows = self.rows[symbol]
        if not rows:
            return {"recent_high": None, "recent_low": None, "momentum": 0.0}
        values = [value for _, value in rows]
        momentum = 0.0 if len(values) < 2 else (values[-1] - values[max(0, len(values) - 5)]) / max(values[-1], 1e-9)
        return {"recent_high": max(values), "recent_low": min(values), "momentum": momentum}


def futures_row(payload: dict[str, Any]) -> dict[str, Any]:
    received = parse_dt(payload.get("bridge_received_at"))
    event_time = parse_dt(payload.get("event_time"))
    transport_ms = max(0.0, (received - event_time).total_seconds() * 1000.0)
    return {
        "symbol": str(payload["symbol"]),
        "contract": str(payload.get("contract") or ""),
        "event_time": event_time.isoformat(),
        "bid": fnum(payload.get("bid")),
        "ask": fnum(payload.get("ask")),
        "last": fnum(payload.get("last")),
        "bid_size": inum(payload.get("bid_size")) or 0,
        "ask_size": inum(payload.get("ask_size")) or 0,
        "trade_count_1s": inum(payload.get("trade_count_1s")) or 0,
        "volume_1s": inum(payload.get("volume_1s")) or 0,
        "buy_volume_1s": inum(payload.get("buy_volume_1s")) or 0,
        "sell_volume_1s": inum(payload.get("sell_volume_1s")) or 0,
        "delta_1s": inum(payload.get("delta_1s")) or 0,
        "delta_5s": inum(payload.get("delta_5s")) or 0,
        "cumulative_delta": inum(payload.get("cumulative_delta")) or 0,
        "book_bid_volume": inum(payload.get("book_bid_volume")) or 0,
        "book_ask_volume": inum(payload.get("book_ask_volume")) or 0,
        "book_imbalance": clamp(fnum(payload.get("book_imbalance")) or 0.0, -1, 1),
        "microprice": fnum(payload.get("microprice")),
        "spread_ticks": fnum(payload.get("spread_ticks")),
        "session_vwap": fnum(payload.get("session_vwap")),
        "absorption_side": str(payload.get("absorption_side") or "NONE"),
        "absorption_score": clamp(fnum(payload.get("absorption_score")) or 0.0, 0, 1),
        "flow_score": clamp(fnum(payload.get("flow_score")) or 0.0, -1, 1),
        "large_trade_count_1s": inum(payload.get("large_trade_count_1s")) or 0,
        "source": "NINJATRADER_OPTIONS_ORDERFLOW",
        "latency": {
            "ninjatrader_engine_us": fnum(payload.get("engine_us")),
            "event_to_bridge_ms": round(transport_ms, 3),
            "ninjatrader_event_age_ms": fnum(payload.get("event_age_ms")),
            "sequence": inum(payload.get("sequence")),
        },
        "updated_at": received.isoformat(),
    }


def greek_required_move(mark: float, delta: float, gamma: float) -> float:
    premium_change = mark * 0.30
    d = abs(delta)
    g = max(0.0, gamma)
    if g < 1e-9:
        return premium_change / max(d, 0.01)
    return (-d + math.sqrt(d * d + 2.0 * g * premium_change)) / g


def structure_for(
    symbol: str,
    chain: ChainResult,
    flow: Optional[dict[str, Any]],
    history: SpotHistory,
) -> dict[str, Any]:
    spot = chain.spot
    calls = [row for row in chain.rows if row["option_type"] == "CALL" and row["strike"] > spot]
    puts = [row for row in chain.rows if row["option_type"] == "PUT" and row["strike"] < spot]
    resistance_row = max(calls, key=lambda row: row.get("open_interest") or 0, default=None)
    support_row = max(puts, key=lambda row: row.get("open_interest") or 0, default=None)
    stats = history.stats(symbol)
    vwap_proxy = None
    if flow:
        future_last, future_vwap = fnum(flow.get("last")), fnum(flow.get("session_vwap"))
        if future_last and future_vwap:
            vwap_proxy = spot * future_vwap / future_last
    return {
        "spot": spot,
        "vwap_proxy": vwap_proxy,
        "vwap_label": "futures-implied VWAP",
        "support": support_row["strike"] if support_row else stats["recent_low"],
        "support_source": "nearby put OI" if support_row else "rolling spot low",
        "resistance": resistance_row["strike"] if resistance_row else stats["recent_high"],
        "resistance_source": "nearby call OI" if resistance_row else "rolling spot high",
        "recent_high": stats["recent_high"],
        "recent_low": stats["recent_low"],
        "momentum": stats["momentum"],
    }


def candidate_score(row: dict[str, Any], flow_strength: float) -> tuple[float, float]:
    delta = abs(fnum(row.get("delta")) or 0.0)
    delta_fit = clamp(1.0 - abs(delta - 0.65) / 0.05, 0.0, 1.0)
    oi = max(0, inum(row.get("open_interest")) or 0)
    volume = max(0, inum(row.get("volume")) or 0)
    liquidity = clamp((math.log10(oi + 1) + math.log10(volume + 1)) / 8.0, 0.0, 1.0)
    bid, ask, mark = fnum(row.get("bid")), fnum(row.get("ask")), fnum(row.get("mark"))
    spread_pct = 1.0
    if bid is not None and ask is not None and mark and ask >= bid:
        spread_pct = (ask - bid) / mark
    spread_quality = clamp(1.0 - spread_pct / 0.12, 0.0, 1.0)
    gamma_quality = clamp((fnum(row.get("gamma")) or 0.0) / 0.08, 0.0, 1.0)
    score = 100.0 * (
        0.30 * delta_fit
        + 0.25 * liquidity
        + 0.20 * spread_quality
        + 0.10 * gamma_quality
        + 0.15 * clamp(flow_strength, 0.0, 1.0)
    )
    return score, spread_pct * 100.0


def build_signal(
    chain: ChainResult,
    flow_payload: Optional[dict[str, Any]],
    history: SpotHistory,
    explanation: Optional[str] = None,
) -> dict[str, Any]:
    started = time.perf_counter_ns()
    symbol, dte, spot = chain.symbol, chain.dte, chain.spot
    flow = futures_row(flow_payload) if flow_payload else None
    structure = structure_for(symbol, chain, flow, history)
    flow_score = fnum(flow.get("flow_score")) if flow else 0.0
    momentum = clamp(float(structure.get("momentum") or 0.0) * 200.0, -1.0, 1.0)
    vwap = fnum(structure.get("vwap_proxy"))
    structure_score = 0.0 if vwap is None else clamp((spot - vwap) / max(spot * 0.0015, 0.01), -1.0, 1.0)
    direction_score = 0.55 * (flow_score or 0.0) + 0.30 * structure_score + 0.15 * momentum
    flow_age = float("inf")
    if flow_payload and flow_payload.get("bridge_received_monotonic") is not None:
        flow_age = max(0.0, time.monotonic() - float(flow_payload["bridge_received_monotonic"]))

    base = {
        "symbol": symbol,
        "dte": dte,
        "as_of": iso_now(),
        "expiration": chain.expiration,
        "source_version": VERSION,
        "updated_at": iso_now(),
        "structure": structure,
        "orderflow": {} if flow is None else {
            "symbol": flow["symbol"],
            "contract": flow["contract"],
            "flow_score": flow["flow_score"],
            "delta_1s": flow["delta_1s"],
            "delta_5s": flow["delta_5s"],
            "cumulative_delta": flow["cumulative_delta"],
            "book_imbalance": flow["book_imbalance"],
            "absorption_side": flow["absorption_side"],
            "absorption_score": flow["absorption_score"],
            "volume_1s": flow["volume_1s"],
            "trade_count_1s": flow["trade_count_1s"],
            "large_trade_count_1s": flow["large_trade_count_1s"],
            "age_ms": None if not math.isfinite(flow_age) else round(flow_age * 1000.0, 2),
        },
    }

    missing_greeks = any(any(row.get(field) is None for field in REQUIRED_GREEKS) for row in chain.rows)
    if flow is None or flow_age > FLOW_STALE_SECONDS:
        return {
            **base,
            "status": "WAITING" if flow is None else "STALE",
            "direction": "NONE",
            "regime": "WAITING FOR ES/NQ" if flow is None else "FUTURES FLOW STALE",
            "model_read": "No contract is eligible until a fresh NinjaTrader futures snapshot is available.",
            "latency": {"option_source_ms": chain.latency_ms, "feature_us": (time.perf_counter_ns() - started) / 1000.0},
        }
    if missing_greeks:
        return {
            **base,
            "status": "WAITING",
            "direction": "NONE",
            "regime": "CHAIN INCOMPLETE",
            "model_read": "The requested expiration is listed, but the test feed has not published complete Greeks yet.",
            "latency": {"option_source_ms": chain.latency_ms, "feature_us": (time.perf_counter_ns() - started) / 1000.0},
        }
    if abs(direction_score) < 0.15:
        return {
            **base,
            "status": "NO_TRADE",
            "direction": "NONE",
            "regime": "MIXED / NO EDGE",
            "score": round(50.0 + abs(direction_score) * 25.0, 2),
            "confidence": round(clamp(abs(direction_score), 0.0, 0.85), 4),
            "model_read": "Futures flow and market structure are not aligned strongly enough for a paper candidate.",
            "latency": {"option_source_ms": chain.latency_ms, "feature_us": (time.perf_counter_ns() - started) / 1000.0},
        }

    direction = "CALL" if direction_score > 0 else "PUT"
    candidates = [
        row for row in chain.rows
        if row["option_type"] == direction
        and row.get("delta") is not None
        and 0.60 <= abs(float(row["delta"])) <= 0.70
        and (row.get("mark") or 0) > 0
    ]
    ranked = sorted(
        ((candidate_score(row, abs(direction_score)), row) for row in candidates),
        key=lambda item: item[0][0],
        reverse=True,
    )
    if not ranked:
        return {
            **base,
            "status": "NO_TRADE",
            "direction": "NONE",
            "regime": "NO ELIGIBLE DELTA",
            "model_read": "No contract in the nearby ladder meets the 0.60-0.70 delta rule with usable pricing.",
            "latency": {"option_source_ms": chain.latency_ms, "feature_us": (time.perf_counter_ns() - started) / 1000.0},
        }

    (score, spread_pct), selected = ranked[0]
    mark = float(selected["mark"])
    delta = float(selected["delta"])
    gamma = float(selected["gamma"])
    required_move = greek_required_move(mark, delta, gamma)
    target_underlying = spot + required_move if direction == "CALL" else spot - required_move
    support, resistance = fnum(structure.get("support")), fnum(structure.get("resistance"))
    invalidation = vwap
    if invalidation is None:
        invalidation = support if direction == "CALL" else resistance
    confidence = clamp(0.35 + score / 200.0 + abs(direction_score) * 0.20, 0.0, 0.88)
    contract_symbol = f"{symbol} {chain.expiration} {selected['strike']:g} {direction}"
    deterministic_read = (
        f"{SYMBOL_MAP[symbol]} flow is {'positive' if direction == 'CALL' else 'negative'} "
        f"({flow_score:+.2f}) and the {selected['strike']:g} {direction.lower()} is the highest-scoring "
        "liquid contract inside the 0.60-0.70 delta band. The 30% target is a delta/gamma estimate, not a guarantee."
    )
    return {
        **base,
        "status": "READY",
        "direction": direction,
        "contract_symbol": contract_symbol,
        "strike": selected["strike"],
        "entry_bid": selected.get("bid"),
        "entry_ask": selected.get("ask"),
        "entry_mid": mark,
        "target_price": mark * 1.30,
        "target_underlying": target_underlying,
        "required_underlying_move_pct": required_move / spot * 100.0,
        "delta": delta,
        "gamma": gamma,
        "iv": selected.get("iv"),
        "open_interest": selected.get("open_interest"),
        "volume": selected.get("volume"),
        "spread_pct": spread_pct,
        "score": round(score, 2),
        "confidence": round(confidence, 4),
        "regime": "ALIGNED LONG" if direction == "CALL" else "ALIGNED SHORT",
        "model_read": explanation or deterministic_read,
        "invalidation": invalidation,
        "latency": {
            "option_source_ms": round(chain.latency_ms, 3),
            "feature_us": round((time.perf_counter_ns() - started) / 1000.0, 3),
            "flow_age_ms": round(flow_age * 1000.0, 3),
            "ollama_in_hot_path": False,
        },
    }


class OllamaExplainer:
    def __init__(self) -> None:
        self.enabled = os.environ.get("OLLAMA_EXPLAIN", "1").strip().lower() not in {"0", "false", "off"}
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ollama-explain")
        self.future: Optional[Future[str]] = None
        self.key: Optional[str] = None
        self.results: dict[str, str] = {}

    def maybe_submit(self, signal: dict[str, Any]) -> None:
        if not self.enabled or signal.get("status") != "READY":
            return
        key = f"{signal['symbol']}:{signal['dte']}:{signal.get('direction')}:{signal.get('strike')}"
        self.collect()
        if key in self.results or self.future is not None:
            return
        compact = {
            name: signal.get(name)
            for name in ("symbol", "dte", "direction", "strike", "delta", "gamma", "iv", "spread_pct", "score", "regime")
        }
        compact["structure"] = signal.get("structure")
        compact["orderflow"] = signal.get("orderflow")
        self.key = key
        self.future = self.pool.submit(self._explain, compact)

    def get(self, signal: dict[str, Any]) -> Optional[str]:
        self.collect()
        key = f"{signal['symbol']}:{signal['dte']}:{signal.get('direction')}:{signal.get('strike')}"
        return self.results.get(key)

    def collect(self) -> None:
        if self.future is None or not self.future.done():
            return
        try:
            result = self.future.result()
            if self.key and result:
                self.results[self.key] = result
        except Exception:
            pass
        self.future = None
        self.key = None

    @staticmethod
    def _explain(compact: dict[str, Any]) -> str:
        prompt = (
            "Explain this already-selected paper options candidate in two short sentences. "
            "Do not change the contract, promise profit, or add facts. State that the 30% target is conditional.\n"
            + json.dumps(compact, separators=(",", ":"))
        )
        payload = {
            "model": OLLAMA_MODEL,
            "stream": False,
            "think": False,
            "messages": [{"role": "user", "content": prompt}],
            "options": {"temperature": 0, "num_predict": 100},
            "keep_alive": "10m",
        }
        response = request_json(f"{OLLAMA_URL}/api/chat", method="POST", payload=payload, timeout=15)
        return " ".join(str(response.get("message", {}).get("content") or "").split())


class Service:
    def __init__(self, *, offline: bool = False) -> None:
        self.offline = offline
        self.db = None if offline else SupabaseRest()
        self.receiver = OrderFlowReceiver()
        self.adapter = OptionChainLiveAdapter()
        self.history = SpotHistory()
        self.explainer = OllamaExplainer()
        self.chains: dict[tuple[str, int], ChainResult] = {}
        self.signals: dict[tuple[str, int], dict[str, Any]] = {}
        self.last_flow_publish = 0.0
        self.last_signal_publish = 0.0
        self.last_health_publish = 0.0
        self.last_flow_write_ms = 0.0
        self.last_signal_write_ms = 0.0
        self.next_option_poll = 0.0
        self.last_error: Optional[str] = None

    def poll_options(self) -> None:
        for symbol in ("SPY", "QQQ"):
            for dte in (0, 1):
                try:
                    chain = self.adapter.fetch(symbol, dte)
                    rows = [{**row, "source_latency_ms": round(chain.latency_ms, 3)} for row in chain.rows]
                    chain = ChainResult(chain.symbol, chain.dte, chain.expiration, chain.spot, rows, chain.latency_ms, chain.fetched_at)
                    self.chains[(symbol, dte)] = chain
                    self.history.add(symbol, chain.spot)
                    if self.db:
                        self.db.upsert(
                            "options_chain_live",
                            rows,
                            "symbol,expiration,option_type,strike",
                        )
                except Exception as exc:
                    self.last_error = f"{symbol} {dte}DTE: {exc}"
                    print("WARN", self.last_error, file=sys.stderr, flush=True)
        self.next_option_poll = time.monotonic() + OPTION_POLL_SECONDS

    def publish_flow(self, raw: dict[str, dict[str, Any]]) -> None:
        rows = [futures_row(payload) for payload in raw.values()]
        if self.db and rows:
            for row in rows:
                row["latency"]["previous_supabase_write_ms"] = round(self.last_flow_write_ms, 3)
            self.last_flow_write_ms = self.db.upsert("futures_orderflow_live", rows, "symbol")

    def score_and_publish(self, raw: dict[str, dict[str, Any]]) -> None:
        rows: list[dict[str, Any]] = []
        for key, chain in self.chains.items():
            flow = raw.get(SYMBOL_MAP[chain.symbol])
            signal = build_signal(chain, flow, self.history)
            self.explainer.maybe_submit(signal)
            explanation = self.explainer.get(signal)
            if explanation and signal.get("status") == "READY":
                signal["model_read"] = explanation
                signal.setdefault("latency", {})["ollama_async"] = True
            self.signals[key] = signal
            rows.append(signal)
        self.explainer.collect()
        if self.db and rows:
            for row in rows:
                row.setdefault("latency", {})["supabase_write_ms"] = round(self.last_signal_write_ms, 3)
            self.last_signal_write_ms = self.db.upsert("options_signal_live", rows, "symbol,dte")

    def publish_health(self, status: str, message: str) -> None:
        if not self.db:
            return
        row = {
            "service": "options_signal_engine",
            "status": status,
            "message": message,
            "last_event_at": iso_now(),
            "updated_at": iso_now(),
            "metadata": {
                "version": VERSION,
                "udp": f"{UDP_HOST}:{UDP_PORT}",
                "option_source": "OPTIONCHAINLIVE_TEST",
                "option_poll_seconds": OPTION_POLL_SECONDS,
                "order_execution_enabled": False,
            },
        }
        self.db.upsert("service_health", [row], "service")

    def run(self, once: bool = False) -> None:
        self.receiver.start()
        self.publish_health("WAITING", "Options signal engine started; waiting for ES/NQ UDP and option data")
        try:
            while True:
                now = time.monotonic()
                if now >= self.next_option_poll:
                    self.poll_options()
                raw = self.receiver.snapshot()
                if now - self.last_flow_publish >= ORDERFLOW_PUBLISH_SECONDS:
                    self.publish_flow(raw)
                    self.last_flow_publish = now
                if now - self.last_signal_publish >= SIGNAL_PUBLISH_SECONDS:
                    self.score_and_publish(raw)
                    self.last_signal_publish = now
                if now - self.last_health_publish >= 10.0:
                    if raw:
                        self.publish_health("LIVE", "Options signal engine receiving NinjaTrader ES/NQ features")
                    else:
                        self.publish_health("WAITING", "Signal engine is healthy; waiting for NinjaTrader ES/NQ features")
                    self.last_health_publish = now
                if once:
                    break
                time.sleep(0.025)
        finally:
            self.receiver.stop()


def synthetic_flow(symbol: str, score: float = 0.55) -> dict[str, Any]:
    now = iso_now()
    return {
        "type": "options_orderflow_snapshot",
        "source_version": "SYNTHETIC_TEST",
        "sequence": 1,
        "symbol": symbol,
        "contract": f"{symbol} 09-26",
        "event_time": now,
        "received_utc": now,
        "bridge_received_at": now,
        "bridge_received_monotonic": time.monotonic(),
        "bid": 6500.0,
        "ask": 6500.25,
        "last": 6500.25,
        "bid_size": 100,
        "ask_size": 80,
        "trade_count_1s": 50,
        "volume_1s": 250,
        "buy_volume_1s": 175,
        "sell_volume_1s": 75,
        "delta_1s": 100,
        "delta_5s": 380,
        "cumulative_delta": 4200,
        "book_bid_volume": 850,
        "book_ask_volume": 500,
        "book_imbalance": 0.259,
        "microprice": 6500.14,
        "spread_ticks": 1.0,
        "session_vwap": 6494.25,
        "absorption_side": "NONE",
        "absorption_score": 0.1,
        "flow_score": score,
        "large_trade_count_1s": 3,
        "event_age_ms": 2.0,
        "engine_us": 12.0,
    }


def synthetic_chain(symbol: str = "SPY", dte: int = 1) -> ChainResult:
    spot = 600.25 if symbol == "SPY" else 520.25
    expiration = date.today().isoformat()
    rows: list[dict[str, Any]] = []
    for strike in range(int(spot) - 4, int(spot) + 6):
        for option_type in ("CALL", "PUT"):
            distance = spot - strike
            call_delta = clamp(0.5 + distance * 0.055, 0.05, 0.95)
            delta = call_delta if option_type == "CALL" else call_delta - 1.0
            mark = max(0.25, 2.5 + (distance if option_type == "CALL" else -distance) * 0.45)
            rows.append(
                {
                    "symbol": symbol,
                    "expiration": expiration,
                    "dte": dte,
                    "option_type": option_type,
                    "strike": float(strike),
                    "bid": mark - 0.03,
                    "ask": mark + 0.03,
                    "last": mark,
                    "mark": mark,
                    "delta": delta,
                    "gamma": 0.05,
                    "theta": -0.2,
                    "vega": 0.04,
                    "iv": 18.0,
                    "open_interest": 2500,
                    "volume": 4200,
                    "underlying_price": spot,
                    "quote_time": iso_now(),
                    "source": "SYNTHETIC_TEST",
                    "source_latency_ms": 0.0,
                    "updated_at": iso_now(),
                }
            )
    return ChainResult(symbol, dte, expiration, spot, rows, 0.0, iso_now())


def self_test(bench_iterations: int = 5000) -> int:
    history = SpotHistory()
    chain = synthetic_chain()
    history.add("SPY", chain.spot - 0.2)
    history.add("SPY", chain.spot)
    flow = synthetic_flow("ES")
    signal = build_signal(chain, flow, history)
    assert signal["status"] == "READY", signal
    assert signal["direction"] == "CALL", signal
    assert 0.60 <= abs(signal["delta"]) <= 0.70, signal
    assert abs(signal["target_price"] / signal["entry_mid"] - 1.30) < 1e-9, signal
    samples = []
    for _ in range(bench_iterations):
        started = time.perf_counter_ns()
        build_signal(chain, flow, history)
        samples.append((time.perf_counter_ns() - started) / 1000.0)
    ordered = sorted(samples)
    p50 = statistics.median(ordered)
    p95 = ordered[int(len(ordered) * 0.95)]
    p99 = ordered[int(len(ordered) * 0.99)]
    print(json.dumps({"status": "PASS", "candidate": signal["contract_symbol"], "feature_latency_us": {"p50": round(p50, 2), "p95": round(p95, 2), "p99": round(p99, 2)}, "iterations": bench_iterations}, indent=2))
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true", help="run deterministic scoring tests and a microbenchmark")
    parser.add_argument("--benchmark-iterations", type=int, default=5000)
    parser.add_argument("--once", action="store_true", help="run one external-source cycle then exit")
    parser.add_argument("--offline", action="store_true", help="do not connect to Supabase")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.self_test:
        return self_test(max(100, args.benchmark_iterations))
    service = Service(offline=args.offline)
    service.run(once=args.once)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
    except (RuntimeError, OSError, urllib.error.URLError, json.JSONDecodeError) as exc:
        print(f"ERROR {exc}", file=sys.stderr)
        raise SystemExit(1)
