#!/usr/bin/env python3
"""Deterministic Tradytics V2 paper/shadow service. No broker code exists here."""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.v2.config import load_config
from backend.v2.engine import MarketEngine
from backend.v2.explain import OllamaExplanationCache
from backend.v2.math_utils import age_seconds, sanitize_json, stable_hash, utc_iso
from backend.v2.metrics import StabilityMetrics
from backend.v2.providers.quantdata import ProviderResult, exposure_concentrations, open_interest_concentrations
from backend.v2.providers.runtime import (
    ProviderRuntime,
    build_candidates,
    cash_snapshot_map,
    depth_snapshot,
    dte_expirations,
    quant_flow_snapshot,
)
from backend.v2.providers.webull import WebullResult
from backend.v2.receiver import LatestUdpReceiver
from backend.v2.supabase import SupabasePublisher


NEW_YORK = ZoneInfo("America/New_York")


class V2Service:
    def __init__(self, *, offline: bool = False, providers: bool = True, state_root: Path | None = None) -> None:
        self.config = load_config()
        self.state_root = state_root or Path(__file__).resolve().parents[1] / ".state"
        self.state_root.mkdir(parents=True, exist_ok=True)
        self.receiver = LatestUdpReceiver(48637)
        self.providers = ProviderRuntime() if providers else None
        self.publisher = None if offline else SupabasePublisher()
        self.explainer = OllamaExplanationCache()
        self.engines = {
            key: MarketEngine(key, self.config, self.state_root)
            for key in ("SPY_1DTE", "SPY_0DTE", "QQQ_1DTE", "QQQ_0DTE")
        }
        started = time.monotonic()
        self.metrics = {key: StabilityMetrics(started) for key in self.engines}
        self.last_publish = 0.0
        self.last_log = 0.0
        self.last_hash: dict[str, str] = {}
        self.seeded_context: set[str] = set()

    def start(self) -> None:
        self.receiver.start()
        if self.providers:
            self.providers.start()

    def stop(self) -> None:
        self.receiver.stop()
        if self.providers:
            self.providers.stop()

    def _seed_zones(self, market_key: str, expiration: str | None, context: Any, now: datetime, spot: float) -> None:
        if not expiration:
            return
        symbol = self.engines[market_key].symbol
        result = context.values.get(f"quant:{symbol}:gex")
        if isinstance(result, ProviderResult) and result.status in {"LIVE", "DEGRADED"}:
            version = f"{market_key}:{expiration}:{result.provider_event_time or result.local_receive_time}"
            if version not in self.seeded_context:
                for level in exposure_concentrations(result, symbol, {expiration}, limit=8):
                    self.engines[market_key].add_structural_level(
                        price=level["strike"], timestamp=now.timestamp(), source_type="QUANT_GEX",
                        timeframe="DAILY", role="NEUTRAL", atr_reference=max(level["strike"] * 0.01, 0.01),
                        options_confluence=level["prominence"], qualified_reaction=False,
                    )
                self.seeded_context.add(version)
        oi_result = context.values.get(f"quant:{symbol}:oi")
        if isinstance(oi_result, ProviderResult) and oi_result.status in {"LIVE", "DEGRADED"}:
            oi_version = f"{market_key}:oi:{oi_result.provider_event_time or oi_result.local_receive_time}"
            if oi_version not in self.seeded_context:
                for level in open_interest_concentrations(oi_result, spot, limit=8):
                    self.engines[market_key].add_structural_level(
                        price=level["strike"], timestamp=now.timestamp(), source_type="QUANT_OI",
                        timeframe="DAILY", role="NEUTRAL", atr_reference=max(spot * 0.01, 0.01),
                        options_confluence=level["prominence"], qualified_reaction=False,
                    )
                self.seeded_context.add(oi_version)

    @staticmethod
    def _context_ages(context: Any, symbol: str, now_utc: datetime) -> dict[str, float | None]:
        def measured(key: str) -> float | None:
            item = context.values.get(key)
            if not isinstance(item, ProviderResult):
                return None
            # Some Quant REST snapshots do not expose an event timestamp. Keep
            # the receipt clock distinct, and use it only as snapshot age.
            value = item.provider_event_time or item.local_receive_time
            age = age_seconds(value, now_utc)
            return age if age != float("inf") else None
        return {
            "quantdata_gex_age": measured(f"quant:{symbol}:gex"),
            "quantdata_skew_age": measured(f"quant:{symbol}:skew"),
            "quantdata_oi_age": measured(f"quant:{symbol}:oi"),
            "greeks_age": measured(f"quant:{symbol}:term"),
        }

    def cycle(self, *, market_open_override: bool | None = None) -> list[dict[str, Any]]:
        now_utc = datetime.now(timezone.utc)
        now_mono = time.monotonic()
        futures = self.receiver.snapshot()
        context = self.providers.snapshot() if self.providers else type("Context", (), {"values": {}})()
        cash_result = context.values.get("webull:cash")
        cash_map = cash_snapshot_map(cash_result if isinstance(cash_result, WebullResult) else None)
        today = now_utc.astimezone(NEW_YORK).date().isoformat()
        signals: list[dict[str, Any]] = []
        for market_key, engine in self.engines.items():
            symbol, dte = engine.symbol, engine.market["dte"]
            term = context.values.get(f"quant:{symbol}:term")
            expiration = dte_expirations(term.data if isinstance(term, ProviderResult) else None, today).get(dte)
            contracts = context.values.get(f"webull:{symbol}:{dte}DTE:contracts")
            quotes = context.values.get(f"webull:{symbol}:{dte}DTE:quotes")
            cash = cash_map.get(symbol, {})
            candidates = build_candidates(
                symbol,
                expiration or "",
                contracts if isinstance(contracts, WebullResult) else None,
                quotes if isinstance(quotes, WebullResult) else None,
                term if isinstance(term, ProviderResult) else None,
                float(cash.get("price") or 0.0),
            ) if expiration else []
            depth_result = context.values.get(f"webull:{symbol}:depth")
            depth = depth_snapshot(depth_result if isinstance(depth_result, WebullResult) else None)
            quant_flow = quant_flow_snapshot(context, symbol)
            quant_status = term.status if isinstance(term, ProviderResult) else "UNAVAILABLE"
            option_status = quotes.status if isinstance(quotes, WebullResult) else "UNAVAILABLE"
            cash_status = cash_result.status if isinstance(cash_result, WebullResult) else "UNAVAILABLE"
            webull_status = "LIVE" if cash_status == "LIVE" and option_status == "LIVE" else "DEGRADED" if "LIVE" in {cash_status, option_status} else "UNAVAILABLE"
            self._seed_zones(market_key, expiration, context, now_utc, float(cash.get("price") or 0.0))
            signal = engine.evaluate(
                now_monotonic=now_mono,
                now_utc=now_utc,
                futures_payload=futures.get(engine.future_symbol),
                cash_payload=cash,
                cash_depth=depth,
                option_candidates=candidates,
                expiration=expiration,
                quant_flow=quant_flow,
                quant_status=quant_status,
                webull_status=webull_status,
                context_ages=self._context_ages(context, symbol, now_utc),
                market_open_override=market_open_override,
            )
            explanation = self.explainer.get(signal)
            if explanation:
                signal["explanation"] = explanation
            self.explainer.submit(signal)
            self.metrics[market_key].observe(signal, now_mono)
            signal["shadow_metrics"] = self.metrics[market_key].snapshot(now_mono)
            signals.append(signal)
        return signals

    def publish(self, signals: list[dict[str, Any]]) -> None:
        if not self.publisher:
            return
        rows = [{
            "market_key": signal["market_key"],
            "symbol": signal["symbol"],
            "dte": signal["dte"],
            "state": signal["state"],
            "display_state": signal["display_state"],
            "direction": signal["direction"],
            "setup_type": signal["setup_type"],
            "setup_quality": signal["setup_quality"],
            "primary_reason": signal["primary_reason"],
            "ready_executable": signal["ready_executable"],
            "payload": signal,
            "as_of": signal["as_of"],
            "updated_at": utc_iso(),
        } for signal in signals]
        started = time.perf_counter()
        write_ms = self.publisher.upsert("options_signal_v2_live", rows, "market_key")
        elapsed = (time.perf_counter() - started) * 1000.0
        for signal in signals:
            signal["latency"]["supabase_publish_ms"] = write_ms
            signal["latency"]["publish_cycle_ms"] = elapsed
            signal["timestamp_lineage"]["database_ack_time"] = utc_iso()

        flow_rows = []
        for symbol, payload in self.receiver.snapshot().items():
            flow_rows.append({
                "symbol": symbol,
                "contract": payload.get("contract") or "UNKNOWN",
                "provider_event_time": payload.get("provider_event_time") or utc_iso(),
                "sequence": int(payload.get("sequence") or 0),
                "payload": sanitize_json(payload),
                "updated_at": utc_iso(),
            })
        self.publisher.upsert("futures_orderflow_v2_live", flow_rows, "symbol")
        health_rows = []
        for provider in ("WEBULL", "QUANTDATA", "NINJATRADER"):
            related = [signal for signal in signals if provider != "NINJATRADER" or signal.get("futures_flow_evidence") is not None]
            if provider == "WEBULL":
                statuses = [signal.get("webull_status") for signal in related]
            elif provider == "QUANTDATA":
                statuses = [signal.get("quantdata_status") for signal in related]
            else:
                statuses = []
                for signal in related:
                    age = signal.get("data_health", {}).get("futures_age")
                    statuses.append(
                        "LIVE"
                        if isinstance(age, (int, float)) and age <= self.config["freshness_seconds"]["futures"]
                        else "STALE"
                    )
            status = "LIVE" if statuses and all(value == "LIVE" for value in statuses) else "DEGRADED" if any(value == "LIVE" for value in statuses) else "UNAVAILABLE"
            health_rows.append({
                "provider": provider,
                "status": status,
                "payload": {"market_statuses": statuses, "as_of": utc_iso()},
                "updated_at": utc_iso(),
            })
        self.publisher.upsert("options_v2_provider_health", health_rows, "provider")

    def shadow_log(self, signals: list[dict[str, Any]], force: bool = False) -> None:
        now = time.monotonic()
        rows: list[dict[str, Any]] = []
        path = self.state_root / "v2_shadow.jsonl"
        for signal in signals:
            digest = stable_hash({key: signal.get(key) for key in ("state", "direction", "setup_type", "primary_reason", "option")})
            changed = digest != self.last_hash.get(signal["market_key"])
            if not force and not changed and now - self.last_log < 60.0:
                continue
            self.last_hash[signal["market_key"]] = digest
            row = {
                "market_key": signal["market_key"],
                "v1_state": None,
                "v2_state": signal["state"],
                "v2_display_state": signal["display_state"],
                "direction": signal["direction"],
                "setup_type": signal["setup_type"],
                "reason_codes": signal["reason_codes"],
                "selected_contract": (signal.get("option") or {}).get("symbol"),
                "webull_status": signal["webull_status"],
                "quantdata_status": signal["quantdata_status"],
                "path_clearance": signal["path_clearance"],
                "shadow_metrics": signal["shadow_metrics"],
                "as_of": signal["as_of"],
            }
            rows.append(row)
        if rows:
            with path.open("a", encoding="utf-8") as handle:
                for row in rows:
                    handle.write(json.dumps(row, separators=(",", ":"), allow_nan=False) + "\n")
            if self.publisher:
                self.publisher.insert("options_v2_shadow_log", rows)
            self.last_log = now

    def run(self, once: bool = False) -> None:
        self.start()
        try:
            if once and self.providers:
                time.sleep(12.0)
            while True:
                signals = self.cycle()
                if time.monotonic() - self.last_publish >= 0.5:
                    self.publish(signals)
                    self.last_publish = time.monotonic()
                self.shadow_log(signals, force=once)
                if once:
                    print(json.dumps({
                        "status": "PASS",
                        "markets": [{
                            "market_key": row["market_key"],
                            "display_state": row["display_state"],
                            "primary_reason": row["primary_reason"],
                            "webull_status": row["webull_status"],
                            "quantdata_status": row["quantdata_status"],
                        } for row in signals],
                    }, indent=2))
                    return
                time.sleep(0.10)
        finally:
            self.stop()


def self_test() -> int:
    config = load_config()
    engine = MarketEngine("SPY_1DTE", config)
    now = datetime(2026, 9, 8, 15, 0, tzinfo=timezone.utc)
    payload = {
        "symbol": "ES", "contract": config["futures"]["es_contract"],
        "provider_event_time": now.isoformat(), "local_receive_time": now.isoformat(),
        "feature_complete_time": now.isoformat(), "futures_flow_evidence": 0.90,
        "flow_persistence": 0.85, "flow_active_fraction": 0.9, "flow_sign_duration": 3.0,
        "aggression": 0.8, "book": 0.65, "absorption": 0.3,
        "bid_replenishment": 0.6, "ask_replenishment": 0.1, "last": 6500.0,
        "rollover_status": "CONFIGURED_EXPLICIT",
    }
    cash = {"price": 770.0, "bid": 769.99, "ask": 770.01, "bid_size": 100, "ask_size": 100,
            "provider_event_time": now.isoformat(), "local_receive_time": now.isoformat()}
    result = None
    for index in range(20):
        result = engine.evaluate(
            now_monotonic=index * 0.1, now_utc=now, futures_payload=payload, cash_payload=cash,
            cash_depth={}, option_candidates=[], expiration="2026-09-09", quant_status="LIVE",
            webull_status="DEGRADED", market_open_override=True,
        )
    assert result and result["state"] in {"ARMING_CALL", "CALL_READY"}
    assert result["setup_quality_is_probability"] is False
    print(json.dumps({"status": "PASS", "state": result["state"], "decision_us": result["latency"]["decision_compute_us"]}, indent=2))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true", help="do not publish to Supabase")
    parser.add_argument("--offline-providers", action="store_true", help="do not call Webull or Quant Data")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    V2Service(offline=args.offline, providers=not args.offline_providers).run(once=args.once)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
