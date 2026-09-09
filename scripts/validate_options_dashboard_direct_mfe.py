"""Validate corrected live features and all 18 frozen Direct-MFE outputs.

Only approved development data through 2026-06-30 is read.  The locked
2026-08-17..2026-09-04 reserve is checked but never opened.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd
import scipy.sparse as sp
import xgboost as xgb


CLASSIFIER_SHA = "3d537d227ebd2198c99d230dff11b108f18e079570f759f07b2975ceada3296f"
DAY = "2026-06-30"
ARCHITECTURE = {
    "SPY_OPTIONS_ONLY": ("SPY", None),
    "SPY_OPTIONS_PLUS_ES": ("SPY", "ES"),
    "QQQ_OPTIONS_ONLY": ("QQQ", None),
    "QQQ_OPTIONS_PLUS_NQ": ("QQQ", "NQ"),
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_context(path: Path, lower: int, upper: int) -> list[dict[str, Any]]:
    rows: dict[str, dict[str, Any]] = {}
    for page in sorted(path.glob("page_*.json.gz")):
        with gzip.open(page, "rt", encoding="utf-8") as handle:
            for row in json.load(handle).get("data", []):
                identity = str(row.get("id") or "")
                if identity and lower <= int(row.get("tradeTime") or 0) < upper:
                    rows.setdefault(identity, row)
    return sorted(rows.values(), key=lambda row: (int(row["tradeTime"]), str(row["id"])))


def live_shaped(row: dict[str, Any], symbol: str) -> dict[str, Any]:
    output = dict(row)
    output["ticker"] = symbol
    output["tradeTime"] = int(output.get("tradeTime") or output.get("trade_time_ms"))
    output["greeks"] = output.get("greeks") or {
        name: output.get(f"greek_{name}") for name in
        ("delta","gamma","theta","vega","rho","charm","color","speed","vanna",
         "vomma","veta","omega","sigma","ultima","zomma")
    }
    output["moneyness"] = output.get("moneyness") or {
        "degree": output.get("moneyness_degree"),
        "degreeInPercent": output.get("moneyness_percent"),
        "moneyType": output.get("money_type"),
    }
    return output


def equal(left: Any, right: Any) -> tuple[bool, float]:
    if pd.isna(left) and pd.isna(right):
        return True, 0.0
    try:
        a, b = float(left), float(right)
        delta = abs(a - b)
        return bool(np.isclose(a, b, rtol=1e-9, atol=1e-9, equal_nan=True)), delta
    except (TypeError, ValueError):
        return str(left) == str(right), 0.0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", required=True, type=Path)
    parser.add_argument("--study-root", required=True, type=Path)
    parser.add_argument("--live-root", required=True, type=Path)
    parser.add_argument("--repo-root", required=True, type=Path)
    args = parser.parse_args()
    source, study, live, repo = (value.resolve() for value in
                                 (args.source_root, args.study_root, args.live_root, args.repo_root))
    sys.path.insert(0, str(repo / "backend"))
    sys.path.insert(0, str(study / "src"))
    from predictive_live.artifacts import FrozenModelFleet
    from predictive_live.direct_mfe import (HORIZON_MINUTES, SharedCalibrator,
        TARGET_PCTS, SURFACE_KEYS)
    from predictive_live.features import IncrementalOptionFeatures
    from predictive_live.providers.event_adapter import option_print_from_quant
    from train_direct_mfe_models import project_surface as research_project_surface

    registry_path = live / "models/manifests/artifact_registry_direct_mfe_v2.json"
    registry = json.loads(registry_path.read_text(encoding="utf-8"))
    lock = registry["locked_holdout"]
    if lock["status"] != "LOCKED_UNACCESSED" or lock["outcomes_inspected"] is not False:
        raise PermissionError("Locked corrected holdout guard failed")
    if sha256(source / "src/trade_classification.py") != CLASSIFIER_SHA:
        raise RuntimeError("Research classifier changed")
    if sha256(repo / "backend/predictive_live/trade_classification.py") != CLASSIFIER_SHA:
        raise RuntimeError("Live classifier changed")

    fleet = FrozenModelFleet(registry_path)
    option_parity: list[dict[str, Any]] = []
    vectors: dict[str, dict[str, Any]] = {}
    for symbol in ("SPY", "QQQ"):
        candidates = pd.read_parquet(source / f"features/candidates_raw/cadence_60s/{symbol}/2026-06/{DAY}.parquet")
        candidate = candidates.iloc[min(180, len(candidates) // 2)].to_dict()
        candidate_id = str(candidate["candidate_id"])
        expected = pd.read_parquet(source / f"datasets/modeling/canonical_60s_tradeclass_v2_quant/{symbol}/2026-06/{DAY}.parquet")
        expected_row = expected.loc[expected.candidate_id.eq(candidate_id)].iloc[0].to_dict()
        t = int(candidate["trade_time_ms"])
        history = read_context(source / f"datasets/raw_quantdata_additions/order_flow_unconsolidated_1dte/context/{symbol}/{DAY}",
                               t - 30 * 60 * 1000, t)
        engine = IncrementalOptionFeatures()
        rejected: list[str] = []
        for raw in history:
            try:
                engine.ingest(option_print_from_quant(live_shaped(raw, symbol)))
            except ValueError as error:
                rejected.append(str(error))
        event = option_print_from_quant(live_shaped(candidate, symbol))
        session_open = int(candidate["cadence_bucket_start_ms"]) - int(candidate["cadence_bucket"]) * 60_000
        actual = engine.snapshot(event, cadence_seconds=60, session_open_ms=session_open)
        features = fleet.features_for(f"{symbol}_OPTIONS_ONLY")
        mismatches, maximum = [], 0.0
        for name in features:
            ok, difference = equal(actual.get(name), expected_row.get(name))
            maximum = max(maximum, difference)
            if not ok:
                mismatches.append({"feature": name, "live": actual.get(name), "research": expected_row.get(name)})
        option_parity.append({"symbol": symbol, "session_date": DAY, "candidate_id": candidate_id,
            "context_events_replayed": len(history) - len(rejected), "context_events_rejected": len(rejected),
            "features_checked": len(features), "mismatch_count": len(mismatches),
            "maximum_absolute_difference": maximum, "mismatches": mismatches[:20], "pass": not mismatches})
        vectors[symbol] = expected_row

    inference_parity: list[dict[str, Any]] = []
    registry_rows = {row["model_id"]: row for row in registry["models"]}
    for model_id, (symbol, future) in ARCHITECTURE.items():
        vector = dict(vectors[symbol])
        if future:
            overlay = pd.read_parquet(source / f"features/futures_candidate_v1/{symbol}/2026-06/{DAY}.parquet")
            overlay_row = overlay.loc[overlay.candidate_id.eq(vector["candidate_id"])].iloc[0].to_dict()
            vector.update(overlay_row)
        production = fleet.predict_surface(model_id, vector)
        item = registry_rows[model_id]
        folder = live / Path(item["model_path"]).parent
        with gzip.open(folder / "preprocessor.joblib.gz", "rb") as handle:
            preprocessor = joblib.load(handle)
        setattr(sys.modules["__main__"], "SharedCalibrator", SharedCalibrator)
        with gzip.open(folder / "calibrator.joblib.gz", "rb") as handle:
            calibrator = joblib.load(handle)
        model = xgb.Booster(); model.load_model(folder / "model.json")
        features = tuple((folder / "features.txt").read_text(encoding="utf-8").splitlines())
        frame = pd.DataFrame([{name: vector[name] for name in features}], columns=features)
        base = sp.csr_matrix(preprocessor.transform(frame), dtype=np.float32)
        blocks = [sp.hstack((base, sp.csr_matrix([[target/30, horizon/30]], dtype=np.float32)), format="csr")
                  for horizon in HORIZON_MINUTES for target in TARGET_PCTS]
        names = [str(value) for value in preprocessor.get_feature_names_out()] + ["query_target_pct_scaled", "query_horizon_scaled"]
        manual_uncalibrated = np.asarray(model.predict(xgb.DMatrix(sp.vstack(blocks), feature_names=names)), dtype=float)
        manual_raw = np.asarray(calibrator.predict(manual_uncalibrated), dtype=float)
        manual_display = research_project_surface(manual_raw)
        prod_uncal = np.asarray([production.uncalibrated_probability_surface[key] for key in SURFACE_KEYS])
        prod_raw = np.asarray([production.raw_probability_surface[key] for key in SURFACE_KEYS])
        prod_display = np.asarray([production.display_probability_surface[key] for key in SURFACE_KEYS])
        errors = {"uncalibrated": float(np.max(np.abs(prod_uncal-manual_uncalibrated))),
                  "raw_calibrated": float(np.max(np.abs(prod_raw-manual_raw))),
                  "display_projection": float(np.max(np.abs(prod_display-manual_display)))}
        inference_parity.append({"model_id": model_id, "session_date": DAY,
            "candidate_id": str(vector["candidate_id"]), "cells_checked": 18, **errors,
            "pass": max(errors.values()) <= 1e-12})

    rows = option_parity + inference_parity
    payload = {"status": "PASS" if all(row["pass"] for row in rows) else "FAIL",
        "scope": "Approved corrected development data through 2026-06-30 only",
        "option_feature_parity": option_parity, "direct_mfe_18_cell_inference_parity": inference_parity,
        "classifier_sha256": CLASSIFIER_SHA, "locked_holdout": lock,
        "no_fit_or_recalibration": True}
    output = repo / "audit/options_dashboard_precommit/direct_mfe_parity.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, indent=2, default=str) + "\n", encoding="utf-8")
    print(json.dumps(payload, indent=2, default=str))
    return 0 if payload["status"] == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
