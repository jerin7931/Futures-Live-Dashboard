"""Inference and incremental option-feature parity against approved history."""

from __future__ import annotations

import argparse
import gzip
import json
import math
import sys
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


PREDICTION_FILES = {
    "SPY_OPTIONS_ONLY": "SPY_OPTIONS_ONLY__frozen.parquet",
    "SPY_OPTIONS_PLUS_ES": "SPY_FIXED_OPTIONS_ES__frozen.parquet",
    "QQQ_OPTIONS_ONLY": "QQQ_OPTIONS_ONLY__platt.parquet",
    "QQQ_OPTIONS_PLUS_NQ": "QQQ_FIXED_OPTIONS_NQ__platt.parquet",
}
BAD_TRADE_TYPES = {"OUT_OF_SEQ", "OPEN_OUT_OF_SEQ", "SOLD_LAST", "CANCEL", "CANCEL_LAST", "CANCEL_OPEN", "CANCEL_ONLY"}


def read_context(path: Path, lower_ms: int, upper_ms: int) -> list[dict[str, Any]]:
    by_id: dict[str, dict[str, Any]] = {}
    anonymous: list[dict[str, Any]] = []
    for page in sorted(path.glob("page_*.json.gz")):
        with gzip.open(page, "rt", encoding="utf-8") as handle:
            rows = json.load(handle).get("data", [])
        for row in rows:
            stamp = row.get("tradeTime")
            if not isinstance(stamp, (int, float)) or str(row.get("tradeType", "")).upper() in BAD_TRADE_TYPES:
                continue
            identity = row.get("id")
            if isinstance(identity, str):
                by_id.setdefault(identity, row)
            else:
                anonymous.append(row)
    rows = [row for row in [*by_id.values(), *anonymous] if lower_ms <= int(row["tradeTime"]) < upper_ms]
    rows.sort(key=lambda row: (int(row["tradeTime"]), str(row.get("id", ""))))
    return rows


def to_event(row: dict[str, Any], OptionPrint: type) -> Any:
    greeks = row.get("greeks") or {}
    delta = greeks.get("delta", row.get("greek_delta"))
    return OptionPrint(
        symbol=str(row.get("symbol", "SPY")), event_time_ms=int(row["tradeTime"]),
        osi=str(row.get("osi", "")), contract_type=str(row.get("contractType", "")),
        trade_side=str(row.get("tradeSideCode", "UNKNOWN")), premium=float(row.get("premium") or 0),
        size=float(row.get("size") or 0), delta=float(delta) if delta is not None else None,
        stock_price=float(row["stockPrice"]) if row.get("stockPrice") is not None else None,
        is_complex=bool(row.get("isComplex")), is_tied=bool(row.get("isTied")),
        trade_type=str(row.get("tradeType") or "UNKNOWN"), fields=row,
    )


def equal_value(actual: Any, expected: Any) -> tuple[bool, float]:
    if pd.isna(actual) and pd.isna(expected):
        return True, 0.0
    try:
        a, b = float(actual), float(expected)
        difference = abs(a - b)
        return bool(np.isclose(a, b, rtol=1e-10, atol=1e-10, equal_nan=True)), difference
    except (TypeError, ValueError):
        return str(actual) == str(expected), 0.0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--research-root", type=Path, required=True)
    parser.add_argument("--live-root", type=Path, required=True)
    parser.add_argument("--repo-root", type=Path, required=True)
    args = parser.parse_args()
    research, live, repo = args.research_root.resolve(), args.live_root.resolve(), args.repo_root.resolve()
    sys.path.insert(0, str(repo / "backend"))
    from predictive_live.artifacts import FrozenModelFleet
    from predictive_live.features import IncrementalOptionFeatures, OptionPrint

    fleet = FrozenModelFleet(live / "models" / "manifests" / "artifact_registry.json")
    prediction_root = research / "evaluation" / "final_holdout" / "predictions"
    inference_results = []
    for model_id, filename in PREDICTION_FILES.items():
        symbol = model_id[:3]
        source = pd.read_parquet(prediction_root / filename)
        sample = source.iloc[len(source) // 2]
        day = str(sample["session_date"])
        base = pd.read_parquet(research / "datasets" / "final_holdout" / "canonical_60s_v1" / symbol / day[:7] / f"{day}.parquet")
        row = base.loc[base.candidate_id.eq(sample.candidate_id)].iloc[0]
        frame = row.to_dict()
        if model_id.endswith("PLUS_ES") or model_id.endswith("PLUS_NQ"):
            overlay = pd.read_parquet(research / "datasets" / "final_holdout" / "futures_candidate_v1" / symbol / day[:7] / f"{day}.parquet")
            frame.update(overlay.loc[overlay.candidate_id.eq(sample.candidate_id)].iloc[0].to_dict())
        actual = fleet.predict(model_id, frame)
        expected = float(sample["probability"])
        inference_results.append({
            "model_id": model_id, "candidate_id": str(sample.candidate_id), "session_date": day,
            "expected_probability": expected, "live_loader_probability": actual,
            "absolute_error": abs(actual - expected), "pass": abs(actual - expected) <= 1e-12,
        })

    # Historical event-sequence parity for the option adapter. SPY and QQQ share
    # exactly the same 224-feature event/tape contract, so one representative
    # event per symbol exercises the complete family.
    feature_results = []
    for symbol in ("SPY", "QQQ"):
        day = "2026-06-30"
        candidate_path = research / "features" / "candidates_raw" / "cadence_60s" / symbol / day[:7] / f"{day}.parquet"
        candidates = pd.read_parquet(candidate_path)
        candidate_row = candidates.iloc[min(180, len(candidates) // 2)].to_dict()
        candidate_id = candidate_row["candidate_id"]
        expected_path = research / "features" / "engineered" / "cadence_60s" / symbol / day[:7] / f"{day}.parquet"
        expected = pd.read_parquet(expected_path).loc[lambda x: x.candidate_id.eq(candidate_id)].iloc[0].to_dict()
        canonical = pd.read_parquet(research / "datasets" / "modeling" / "canonical_60s_v2_quant" / symbol / day[:7] / f"{day}.parquet")
        canonical_row = canonical.loc[canonical.candidate_id.eq(candidate_id)].iloc[0]
        candidate_row["actual_tte_minutes_rth"] = canonical_row["actual_tte_minutes_rth"]
        t = int(candidate_row["trade_time_ms"])
        context_dir = research / "datasets" / "raw_quantdata_additions" / "order_flow_unconsolidated_1dte" / "context" / symbol / day
        history = read_context(context_dir, t - 30 * 60 * 1000, t)
        engine = IncrementalOptionFeatures()
        for row in history:
            row["symbol"] = symbol
            engine.ingest(to_event(row, OptionPrint))
        candidate_payload = dict(candidate_row)
        candidate_payload["tradeTime"] = t
        event = to_event(candidate_payload, OptionPrint)
        open_ms = int(candidate_row["cadence_bucket_start_ms"]) - int(candidate_row["cadence_bucket"]) * 60_000
        actual = engine.snapshot(event, cadence_seconds=60, session_open_ms=open_ms)
        actual["actual_tte_minutes_rth"] = candidate_row["actual_tte_minutes_rth"]
        features = fleet.features_for(f"{symbol}_OPTIONS_ONLY")
        mismatches, maximum_difference = [], 0.0
        for name in features:
            ok, difference = equal_value(actual.get(name), expected.get(name) if name != "actual_tte_minutes_rth" else canonical_row[name])
            maximum_difference = max(maximum_difference, difference)
            if not ok:
                mismatches.append({"feature": name, "actual": actual.get(name), "expected": expected.get(name) if name != "actual_tte_minutes_rth" else canonical_row[name]})
        feature_results.append({
            "symbol": symbol, "candidate_id": candidate_id, "session_date": day,
            "features_checked": len(features), "mismatch_count": len(mismatches),
            "maximum_absolute_difference": maximum_difference, "mismatches": mismatches[:20],
            "pass": not mismatches,
        })

    payload = {
        "status": "PASS" if all(row["pass"] for row in inference_results + feature_results) else "FAIL",
        "inference_parity": inference_results, "option_feature_parity": feature_results,
        "scope": "Frozen final-holdout predictions and representative pre-holdout historical option-event sequences",
        "note": "No fitting, tuning, calibration fitting, or artifact mutation was performed.",
    }
    output = repo / "audit" / "production_precommit" / "parity_results.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, indent=2, default=str) + "\n", encoding="utf-8")
    print(json.dumps(payload, indent=2, default=str))
    return 0 if payload["status"] == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
