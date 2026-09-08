"""Full four-model local-decision and priority-publisher replay benchmark."""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd


FILES = {
    "SPY_OPTIONS_ONLY": "SPY_OPTIONS_ONLY__frozen.parquet",
    "SPY_OPTIONS_PLUS_ES": "SPY_FIXED_OPTIONS_ES__frozen.parquet",
    "QQQ_OPTIONS_ONLY": "QQQ_OPTIONS_ONLY__platt.parquet",
    "QQQ_OPTIONS_PLUS_NQ": "QQQ_FIXED_OPTIONS_NQ__platt.parquet",
}


def pct(values: list[float]) -> dict[str, float]:
    return {name: float(np.percentile(values, value)) for name, value in
            (("p50", 50), ("p95", 95), ("p99", 99), ("max", 100))}


class BenchmarkCalendar:
    VERSION = "BENCHMARK_FIXED_OPEN_CALENDAR"

    @staticmethod
    def actionable_y30(_event_ms: int):
        return True, "OK", None

    @staticmethod
    def market_state(_timestamp: datetime):
        return {"state": "OPEN", "calendar_version": "BENCHMARK_FIXED_OPEN_CALENDAR"}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--research-root", type=Path, required=True)
    parser.add_argument("--live-root", type=Path, required=True)
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--rows", type=int, default=40)
    parser.add_argument("--audit-dir-name", default="production_precommit_v2")
    args = parser.parse_args()
    research, live, repo = args.research_root.resolve(), args.live_root.resolve(), args.repo_root.resolve()
    sys.path.insert(0, str(repo / "backend"))

    from predictive_live.artifacts import FrozenModelFleet
    from predictive_live.cadence import FrozenCandidateCadence
    from predictive_live.features import LiveFeatureEngine
    from predictive_live.forward_store import AsyncForwardRecorder, AsyncPublishQueue
    from predictive_live.mapping import TargetLadderMapping
    from predictive_live.providers.event_adapter import option_print_from_quant
    from predictive_live.service import PredictiveLiveService

    fleet = FrozenModelFleet(live / "models/manifests/artifact_registry.json")
    mapping = TargetLadderMapping(live / "mappings/target_ladder_production_v1.json")
    predictions = research / "evaluation/final_holdout/predictions"
    canonical_root = research / "datasets/final_holdout/canonical_60s_v1"
    futures_root = research / "datasets/final_holdout/futures_candidate_v1"
    cache: dict[tuple[str, str, str], pd.DataFrame] = {}
    audit = repo / "audit" / args.audit_dir_name
    audit.mkdir(parents=True, exist_ok=True)
    results: dict[str, dict] = {}

    with tempfile.TemporaryDirectory(prefix="full-runtime-v2-", dir=audit) as temporary:
        recorder = AsyncForwardRecorder(Path(temporary), max_queue=20_000)
        publisher = AsyncPublishQueue(lambda _table, _payload: None, max_queue=2_000)
        service = PredictiveLiveService(fleet, mapping, LiveFeatureEngine(), recorder, publisher,
                                        config=json.loads((live / "config/predictive_live_v1.json").read_text()),
                                        live_root=live, calendar=BenchmarkCalendar())
        service.update_provider_health("QUANT_DATA", status="LIVE", age_ms=0,
                                       event_time=datetime.now(timezone.utc).isoformat())
        service.update_provider_health("WEBULL", status="LIVE", age_ms=0,
                                       event_time=datetime.now(timezone.utc).isoformat())
        for instrument in ("ES", "NQ"):
            service.update_provider_health(f"NINJATRADER_{instrument}", status="LIVE", age_ms=0,
                                           event_time=datetime.now(timezone.utc).isoformat())
        for symbol in ("SPY", "QQQ"):
            stamp = datetime.now(timezone.utc).isoformat()
            service.update_structure_state(symbol, {
                "source": "TRUSTED_DETERMINISTIC_V2_READ_ONLY", "as_of": stamp, "age_ms": 0,
            })

        for model_id, filename in FILES.items():
            symbol = model_id[:3]
            source = pd.read_parquet(predictions / filename).iloc[:args.rows]
            elapsed, selected, duplicates = [], [], 0
            for index, sample in enumerate(source.itertuples(index=False)):
                day = str(sample.session_date)
                key = (symbol, day, "base")
                if key not in cache:
                    cache[key] = pd.read_parquet(canonical_root / symbol / day[:7] / f"{day}.parquet")
                base = cache[key]
                vector = base.loc[base.candidate_id.eq(sample.candidate_id)].iloc[0].to_dict()
                if "PLUS_ES" in model_id or "PLUS_NQ" in model_id:
                    key = (symbol, day, "futures")
                    if key not in cache:
                        cache[key] = pd.read_parquet(futures_root / symbol / day[:7] / f"{day}.parquet")
                    overlay = cache[key]
                    vector.update(overlay.loc[overlay.candidate_id.eq(sample.candidate_id)].iloc[0].to_dict())

                now = datetime.now(timezone.utc)
                stamp = int(now.timestamp() * 1000)
                contract = f"{symbol}260909{'C' if index % 2 == 0 else 'P'}{650000 + index:08d}"
                provider = {
                    "id": f"benchmark-{model_id}-{index}", "ticker": symbol, "tradeTime": stamp,
                    "expirationDate": "2026-09-09", "dte": 1.25,
                    "osi": contract, "contractType": "CALL" if index % 2 == 0 else "PUT",
                    "tradeSideCode": "A", "tradeType": "AUTO", "isCancelled": False,
                    "isComplex": False, "isTied": False, "premium": 100.0, "size": 1,
                    "stockPrice": 650.0, "strikePrice": 650.0,
                    "bidPrice": 1.00, "askPrice": 1.02,
                    "greeks": {"delta": .65 if index % 2 == 0 else -.65},
                }
                started = time.perf_counter_ns()
                event = option_print_from_quant(provider)
                quote_time = datetime.now(timezone.utc).isoformat()
                service.on_webull_quote(contract, {"bid": 1.00, "ask": 1.02, "quote_time": quote_time})
                service.candidate_pool[model_id].clear()
                cadence = FrozenCandidateCadence()
                prepared = cadence.make(event, stamp - 30_000, {model_id: vector})
                complete = cadence.observe(prepared) + cadence.flush_due(stamp + 60_000)
                structure = {"source": "TRUSTED_DETERMINISTIC_V2_READ_ONLY",
                             "as_of": datetime.now(timezone.utc).isoformat(), "age_ms": 0,
                             "structure_bias": "BULLISH" if event.contract_type == "CALL" else "BEARISH",
                             "accepted_below": False, "accepted_above": False,
                             "call_invalidation_level": 645.0, "put_invalidation_level": 655.0}
                decisions = [decision for item in complete for decision in service.process_cadence_candidate(item, structure)]
                elapsed.append((time.perf_counter_ns() - started) / 1e6)
                if len(decisions) != 1:
                    duplicates += abs(len(decisions) - 1)
                else:
                    selected.append(decisions[0].candidate_contract)
            results[model_id] = {
                "rows": len(elapsed), "full_local_decision_ms": pct(elapsed),
                "decision_count": len(selected), "duplicate_or_missing_decisions": duplicates,
                "selected_contracts_unique": len(set(selected)),
            }
        recorder.queue.join(); publisher.wait_idle(10)
        recorder_health = recorder.health(); publisher_health = publisher.health()
        recorder.close(); publisher.close()

    acknowledgements: dict[str, float] = {}
    high_done = threading.Event()
    def slow_publish(table: str, payload: dict) -> None:
        time.sleep((50 + (int(payload.get("sequence", 0)) % 3) * 50) / 1000)
        if table == "predictive_model_state_live":
            acknowledgements["model_ack"] = time.perf_counter(); high_done.set()
    transport = AsyncPublishQueue(slow_publish, max_queue=500)
    for revision in range(3):
        for index in range(100):
            transport.submit("predictive_option_ladder_live",
                             {"contract_key": f"ROW-{index}", "sequence": revision * 100 + index})
    enqueued = time.perf_counter()
    transport.submit("predictive_model_state_live", {"model_id": "SPY_OPTIONS_ONLY", "sequence": 1})
    high_completed = high_done.wait(2.0)
    high_ack_ms = (acknowledgements.get("model_ack", time.perf_counter()) - enqueued) * 1000
    drained = transport.wait_idle(20.0)
    transport_health = transport.health(); transport.close()

    local_ok = all(row["duplicate_or_missing_decisions"] == 0 and
                   row["full_local_decision_ms"]["p95"] <= 25 and
                   row["full_local_decision_ms"]["p99"] <= 50 for row in results.values())
    publisher_ok = high_completed and high_ack_ms < 500 and drained and not transport_health["dropped"] and not transport_health["errors"]
    status = local_ok and publisher_ok and not recorder_health["dropped"] and not recorder_health["errors"]
    payload = {
        "status": "PASS" if status else "FAIL",
        "replay_kind": "accelerated frozen-vector full local runtime replay; not live-market latency",
        "local_decision_contract": "provider validation -> 60s candidate completion -> feature vector -> frozen inference -> deterministic selection -> grade -> target ladder -> Aim For -> invalidation -> publish enqueue",
        "models": results,
        "goals_ms": {"p95": 25, "p99": 50},
        "forward_logger": recorder_health,
        "local_publisher": publisher_health,
        "simulated_network_publisher": {
            "network_latency_range_ms": [50, 150], "ladder_unique_rows": 100,
            "ladder_revisions_submitted": 3, "high_priority_model_ack_ms": high_ack_ms,
            "high_priority_completed": high_completed, "queue_drained": drained,
            **transport_health,
        },
        "no_fit_or_artifact_mutation": True,
    }
    output = audit / "full_runtime_latency_and_publisher_benchmark.json"
    output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(payload, indent=2))
    return 0 if status else 2


if __name__ == "__main__":
    raise SystemExit(main())
