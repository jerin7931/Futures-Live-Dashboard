#!/usr/bin/env python3
"""Deterministic stability/sensitivity validation; never optimizes for P&L."""
from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.v2.config import load_config, with_overrides
from backend.v2.math_utils import clamp
from backend.v2.metrics import StabilityMetrics
from backend.v2.models import Evidence
from backend.v2.state_machine import DirectionStateMachine


SYNTHETIC = [
    (0.0, .70), (.5, .70), (1.0, .70), (1.5, .70),
    (2.0, .25), (2.2, .05), (2.4, -.10), (2.6, .30), (3.0, .65), (4.0, .65),
]


def replay(points: list[tuple[float, float]], config: dict[str, Any]) -> dict[str, Any]:
    machine = DirectionStateMachine(config["markets"]["SPY_1DTE"], config["direction"])
    metrics = StabilityMetrics(points[0][0] if points else 0.0)
    state_counts: Counter[str] = Counter()
    transitions: list[dict[str, Any]] = []
    for stamp, score in points:
        persistence = .85 if abs(score) >= .15 else .0
        evidence = Evidence(score, score, score, persistence, 1.0 if persistence else 0.0, 2.0 if persistence else 0.0)
        result = machine.step(now=stamp, core=score, evidence=evidence, setup_type="CONTINUATION")
        signal = {"state": result.state.value, "direction": result.direction, "primary_reason": result.primary_reason, "option": None}
        metrics.observe(signal, stamp)
        state_counts[result.display_state] += 1
        transitions.append({"time": stamp, "state": result.state.value, "display": result.display_state, "direction": result.direction, "reason": result.primary_reason})
    return {"metrics": metrics.snapshot(points[-1][0] if points else 0.0), "state_counts": dict(sorted(state_counts.items())), "transitions": transitions}


def recorded_points(path: Path) -> list[tuple[float, float]]:
    points: list[tuple[float, float]] = []
    with path.open(newline="", encoding="utf-8-sig") as handle:
        rows = csv.DictReader(handle)
        for row in rows:
            try:
                stamp = float(row["time"])
                delta_pct = float(row["FP_Delta_Pct"])
                buy = float(row.get("FP_Buy_Imbalance_Count") or 0.0)
                sell = float(row.get("FP_Sell_Imbalance_Count") or 0.0)
                response = float(row.get("FP_POC_Delta_Pct") or 0.0)
            except (KeyError, TypeError, ValueError):
                continue
            aggression = clamp(delta_pct / 35.0, -1.0, 1.0)
            book = clamp((buy - sell) / max(buy + sell, 1.0), -1.0, 1.0)
            execution = clamp(response / 35.0, -1.0, 1.0)
            score = sorted((aggression, book, execution))[1]
            points.append((stamp, score))
    if points:
        base = points[0][0]
        points = [(stamp - base, score) for stamp, score in points]
    return points


def sensitivity(config: dict[str, Any]) -> dict[str, Any]:
    paths = (
        "markets.SPY_1DTE.enter_threshold", "markets.SPY_1DTE.hold_threshold",
        "markets.SPY_1DTE.flip_threshold", "markets.SPY_1DTE.entry_persistence_seconds",
        "markets.SPY_1DTE.flip_persistence_seconds", "markets.SPY_1DTE.switch_margin",
        "structure.path_abstain_threshold", "direction.conflict_strength",
    )
    output: dict[str, Any] = {}
    for path in paths:
        node: Any = config
        for part in path.split("."):
            node = node[part]
        output[path] = {
            "baseline": node,
            "minus_20pct": replay(SYNTHETIC, with_overrides(config, {path: node * .8}))["state_counts"],
            "plus_20pct": replay(SYNTHETIC, with_overrides(config, {path: node * 1.2}))["state_counts"],
        }
    return output


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--recorded-csv", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    config = load_config()
    report: dict[str, Any] = {
        "purpose": "deterministic brittleness and stability analysis; no P&L and no parameter optimization",
        "synthetic_anti_flip": replay(SYNTHETIC, config),
        "sensitivity_plus_minus_20pct": sensitivity(config),
    }
    if args.recorded_csv and args.recorded_csv.is_file():
        points = recorded_points(args.recorded_csv)
        report["recorded_legacy_orderflow"] = {
            "source": str(args.recorded_csv),
            "limitation": "One-minute legacy footprint bars mapped deterministically into V2 pillars; validates state stability only, not 100-ms feature parity.",
            "rows": len(points),
            **replay(points, config),
        }
    payload = json.dumps(report, indent=2, sort_keys=True, allow_nan=False)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(payload + "\n", encoding="utf-8")
    print(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
