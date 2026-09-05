#!/usr/bin/env python3
"""Measure deterministic compute latency without network or wall-clock decisions."""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.v2.cash import CashMicrostructure
from backend.v2.direction import directional_core
from backend.v2.engine import MarketEngine
from backend.v2.models import Candidate, Evidence
from backend.v2.pricing import SECONDS_PER_YEAR, ScenarioInput, bsm_greeks, scenario_grid


def measured(call, iterations: int) -> dict[str, float]:
    samples = []
    for _ in range(iterations):
        started = time.perf_counter_ns()
        call()
        samples.append((time.perf_counter_ns() - started) / 1000.0)
    ordered = sorted(samples)
    return {
        "iterations": iterations,
        "median_us": statistics.median(ordered),
        "p95_us": ordered[min(len(ordered) - 1, int(len(ordered) * .95))],
        "max_us": max(ordered),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    cash = CashMicrostructure("SPY")
    for index in range(700):
        cash.add_price(index * .1, 770.0 + index * .001)
    cash_call = lambda: cash.evidence(
        bids=[(769.99 - index * .01, 100 + index) for index in range(5)],
        asks=[(770.01 + index * .01, 90 + index) for index in range(5)],
        bid=769.99, ask=770.01, bid_size=100, ask_size=90, l2_valid=True,
    )
    direction_call = lambda: directional_core(Evidence(.5, .3, .4, .8), {"futures_weight": .5, "cash_weight": .2, "structure_weight": .3})
    scenario_input = ScenarioInput("CALL", 770.0, 766.0, 105300.0, .20, 8.0, 8.1, .04, .012, .30, 1.25, .03, 1e-6, .01)
    scenario_call = lambda: scenario_grid(scenario_input, [0, 5, 15, 30, 60, 120], [-.25, -.10, 0, .10, .25], 1.5)

    engine = MarketEngine("SPY_1DTE")
    now = datetime(2026, 9, 8, 15, 0, tzinfo=timezone.utc)
    delta, gamma = bsm_greeks("CALL", 770.0, 766.0, 105300 / SECONDS_PER_YEAR, .04, .012, .20)
    candidate = Candidate("SPY", "2026-09-09", "CALL", 766.0, "SPY260909C00766000", 8.0, 8.1, 8.05, 20, 20, 5000, 25000, delta, gamma, .20, now.isoformat(), now.isoformat(), 770.0)
    futures = {"contract": "ES 09-26", "provider_event_time": now.isoformat(), "local_receive_time": now.isoformat(), "futures_flow_evidence": .9, "flow_persistence": .85, "flow_active_fraction": .9, "flow_sign_duration": 3.0, "aggression": .85, "book": .75, "execution_response": .8, "absorption": .3, "bid_replenishment": .7, "ask_replenishment": .05, "last": 6500}
    cash_payload = {"price": 770.0, "bid": 769.99, "ask": 770.01, "bid_size": 100, "ask_size": 100, "provider_event_time": now.isoformat(), "local_receive_time": now.isoformat()}
    counter = 0
    def engine_call():
        nonlocal counter
        counter += 1
        return engine.evaluate(now_monotonic=counter * .1, now_utc=now, futures_payload=futures, cash_payload=cash_payload, cash_depth={}, option_candidates=[candidate], expiration="2026-09-09", quant_status="LIVE", webull_status="LIVE", market_open_override=True)

    report = {
        "units": "microseconds measured with perf_counter_ns on this PC",
        "cash_feature_compute": measured(cash_call, 10000),
        "direction_compute": measured(direction_call, 100000),
        "scenario_compute": measured(scenario_call, 1000),
        "full_decision_with_one_candidate": measured(engine_call, 1000),
        "network_calls_excluded": True,
    }
    payload = json.dumps(report, indent=2, sort_keys=True, allow_nan=False)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(payload + "\n", encoding="utf-8")
    print(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
