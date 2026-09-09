"""Replay representative ES/NQ historical ticks through the live adapter."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd


def raw_path(root: Path, instrument: str, kind: str, day: str) -> Path:
    path = root / instrument / f"{instrument}_09-26" / day[:7] / f"{instrument}_09-26__tick_{kind}__exchange_day_{day}.csv.gz"
    if not path.is_file():
        raise FileNotFoundError(path)
    return path


def finite_or(value: object, default: float = 0.0) -> float:
    return float(value) if value is not None and pd.notna(value) else default


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--research-root", type=Path, required=True)
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--futures-root", type=Path, required=True)
    parser.add_argument("--audit-dir-name", default="production_precommit")
    args = parser.parse_args()
    research, repo, raw_root = args.research_root.resolve(), args.repo_root.resolve(), args.futures_root.resolve()
    sys.path.insert(0, str(repo / "backend"))
    sys.path.insert(0, str(research / "src"))
    from predictive_live.features import FUTURES_WINDOWS, IncrementalFuturesFeatures
    from build_es_candidate_features import read_stream as read_es_stream
    from build_nq_candidate_features import read_stream as read_nq_stream

    results = []
    day = "2026-06-30"
    for symbol, instrument in (("SPY", "ES"), ("QQQ", "NQ")):
        overlay_path = research / "features" / "futures_candidate_v1" / symbol / day[:7] / f"{day}.parquet"
        overlay = pd.read_parquet(overlay_path)
        expected = overlay.iloc[len(overlay) // 2]
        candidate_id = str(expected["candidate_id"])
        canonical_path = research / "datasets" / "modeling" / "canonical_60s_v2_quant" / symbol / day[:7] / f"{day}.parquet"
        canonical = pd.read_parquet(canonical_path)
        row = canonical.loc[canonical.candidate_id.eq(candidate_id)].iloc[0]
        candidate_ct = pd.Timestamp(row["trade_time_ms"], unit="ms", tz="UTC").tz_convert("America/Chicago").tz_localize(None)
        normalizer = read_es_stream if instrument == "ES" else read_nq_stream
        streams = {kind: normalizer(raw_path(raw_root, instrument, kind, day), day, kind, "15:00:00")[0]
                   for kind in ("last", "bid", "ask")}
        replay = (streams["last"].merge(streams["bid"], on="second", how="outer")
                  .merge(streams["ask"], on="second", how="outer").sort_values("second"))
        replay = replay.loc[replay["second"] < candidate_ct]
        engine = IncrementalFuturesFeatures(instrument)
        for event in replay.itertuples(index=False):
            engine.ingest_second_summary(
                second=int(pd.Timestamp(event.second).value // 1_000_000_000),
                last_open=getattr(event, "last_open", None), last_high=getattr(event, "last_high", None),
                last_low=getattr(event, "last_low", None), last_close=getattr(event, "last_close", None),
                bid=getattr(event, "bid", None), ask=getattr(event, "ask", None),
                volume=finite_or(getattr(event, "trade_volume_1s", 0)),
                trade_count=int(finite_or(getattr(event, "trade_count_1s", 0))),
                large_trade_count=int(finite_or(getattr(event, "large_trade_count_1s", 0))),
            )
        candidate_ms = int(candidate_ct.value // 1_000_000)
        etf = {window: float(row[f"underlying_event_return_{window}s"]) for window in FUTURES_WINDOWS}
        actual = engine.snapshot(candidate_time_ms=candidate_ms, is_call=bool(row["is_call"]), etf_returns=etf)
        names = [name for name in overlay.columns if name.startswith(instrument.lower() + "_") or name.startswith("candidate_aligned_" + instrument.lower() + "_")]
        mismatches, maximum = [], 0.0
        for name in names:
            left, right = actual.get(name), expected[name]
            if pd.isna(left) and pd.isna(right):
                continue
            difference = abs(float(left) - float(right))
            maximum = max(maximum, difference)
            if not np.isclose(float(left), float(right), rtol=1e-10, atol=1e-10, equal_nan=True):
                mismatches.append({"feature": name, "actual": left, "expected": right, "absolute_difference": difference})
        results.append({
            "symbol": symbol, "instrument": instrument, "candidate_id": candidate_id,
            "session_date": day, "normalized_seconds_replayed": len(replay), "features_checked": len(names),
            "mismatch_count": len(mismatches), "maximum_absolute_difference": maximum,
            "mismatches": mismatches[:20], "pass": not mismatches,
        })
    payload = {"status": "PASS" if all(row["pass"] for row in results) else "FAIL", "futures_feature_parity": results,
               "scope": "Representative historical Level-1 Last/Bid/Ask replay after the immutable ES/NQ source-specific duplicate and timestamp-collision normalizers"}
    output = repo / "audit" / args.audit_dir_name / "futures_parity_results.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, indent=2, default=str) + "\n", encoding="utf-8")
    print(json.dumps(payload, indent=2, default=str))
    return 0 if payload["status"] == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
