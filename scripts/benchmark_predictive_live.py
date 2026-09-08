"""Accelerated frozen-vector replay plus local latency/backlog measurements."""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import pandas as pd


FILES = {
    "SPY_OPTIONS_ONLY": "SPY_OPTIONS_ONLY__frozen.parquet",
    "SPY_OPTIONS_PLUS_ES": "SPY_FIXED_OPTIONS_ES__frozen.parquet",
    "QQQ_OPTIONS_ONLY": "QQQ_OPTIONS_ONLY__platt.parquet",
    "QQQ_OPTIONS_PLUS_NQ": "QQQ_FIXED_OPTIONS_NQ__platt.parquet",
}


def percentiles(values: list[float]) -> dict[str, float]:
    return {name: float(np.percentile(values, q)) for name,q in (("p50",50),("p95",95),("p99",99),("max",100))}


def main() -> int:
    parser=argparse.ArgumentParser();parser.add_argument("--research-root",type=Path,required=True);parser.add_argument("--live-root",type=Path,required=True);parser.add_argument("--repo-root",type=Path,required=True);parser.add_argument("--rows",type=int,default=80)
    args=parser.parse_args();research=args.research_root.resolve();repo=args.repo_root.resolve();live=args.live_root.resolve();sys.path.insert(0,str(repo/"backend"))
    from predictive_live.artifacts import FrozenModelFleet
    from predictive_live.forward_store import AsyncForwardRecorder, AsyncPublishQueue
    fleet=FrozenModelFleet(live/"models/manifests/artifact_registry.json");prediction_root=research/"evaluation/final_holdout/predictions"
    results={};total=0;maximum_error=0.0;published=[]
    def fake_publish(table,payload):
        time.sleep(.001);published.append((table,payload.get("model_id")))
    publisher=AsyncPublishQueue(fake_publish,max_queue=2000)
    cache: dict[tuple[str,str,str], pd.DataFrame] = {}
    audit_root=repo/"audit/production_precommit";audit_root.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="predictive-live-replay-",dir=audit_root) as temporary:
        recorder=AsyncForwardRecorder(Path(temporary),max_queue=5000)
        for model_id,filename in FILES.items():
            predictions=pd.read_parquet(prediction_root/filename).iloc[:args.rows]
            latencies=[];errors=[]
            for sample in predictions.itertuples(index=False):
                day=str(sample.session_date);symbol=model_id[:3]
                base_key=(symbol,day,"base")
                if base_key not in cache: cache[base_key]=pd.read_parquet(research/"datasets/final_holdout/canonical_60s_v1"/symbol/day[:7]/f"{day}.parquet")
                base=cache[base_key]
                vector=base.loc[base.candidate_id.eq(sample.candidate_id)].iloc[0].to_dict()
                if "PLUS_ES" in model_id or "PLUS_NQ" in model_id:
                    future_key=(symbol,day,"futures")
                    if future_key not in cache: cache[future_key]=pd.read_parquet(research/"datasets/final_holdout/futures_candidate_v1"/symbol/day[:7]/f"{day}.parquet")
                    overlay=cache[future_key]
                    vector.update(overlay.loc[overlay.candidate_id.eq(sample.candidate_id)].iloc[0].to_dict())
                started=time.perf_counter_ns();actual=fleet.predict(model_id,vector);latencies.append((time.perf_counter_ns()-started)/1e6)
                error=abs(actual-float(sample.probability));errors.append(error);maximum_error=max(maximum_error,error)
                payload={"model_id":model_id,"candidate_id":str(sample.candidate_id),"probability":actual,"feature_hash":"replay"}
                recorder.submit("model_events",payload);publisher.submit("predictive_model_state_live",payload);total+=1
            results[model_id]={"rows":len(latencies),"inference_ms":percentiles(latencies),"maximum_prediction_error":max(errors)}
        recorder.queue.join();publisher.queue.join();health=recorder.health();publisher_health={"queued":publisher.queue.qsize(),"dropped":publisher.dropped,"errors":publisher.errors,"published":len(published)};recorder.close();publisher.close()
    # Measure actual bounded incremental option-state snapshot + frozen model
    # inference, rather than reporting model-only latency as the full hot path.
    sys.path.insert(0,str(repo/"scripts"))
    from validate_predictive_live_parity import read_context,to_event
    from predictive_live.features import IncrementalOptionFeatures,OptionPrint
    hot_path={}
    for symbol in ("SPY","QQQ"):
        day="2026-06-30";candidate_frame=pd.read_parquet(research/"features/candidates_raw/cadence_60s"/symbol/day[:7]/f"{day}.parquet")
        candidate=candidate_frame.iloc[min(180,len(candidate_frame)//2)].to_dict();identifier=candidate["candidate_id"]
        canonical=pd.read_parquet(research/"datasets/modeling/canonical_60s_v2_quant"/symbol/day[:7]/f"{day}.parquet")
        authoritative=canonical.loc[canonical.candidate_id.eq(identifier)].iloc[0];candidate["actual_tte_minutes_rth"]=authoritative["actual_tte_minutes_rth"]
        stamp=int(candidate["trade_time_ms"]);history=read_context(research/"datasets/raw_quantdata_additions/order_flow_unconsolidated_1dte/context"/symbol/day,stamp-30*60*1000,stamp)
        engine=IncrementalOptionFeatures()
        for row in history: row["symbol"]=symbol;engine.ingest(to_event(row,OptionPrint))
        payload_row=dict(candidate);payload_row["tradeTime"]=stamp;event=to_event(payload_row,OptionPrint)
        open_ms=int(candidate["cadence_bucket_start_ms"])-int(candidate["cadence_bucket"])*60_000;model_id=f"{symbol}_OPTIONS_ONLY";times=[]
        for _ in range(80):
            started=time.perf_counter_ns();vector=engine.snapshot(event,cadence_seconds=60,session_open_ms=open_ms);vector["actual_tte_minutes_rth"]=candidate["actual_tte_minutes_rth"];fleet.predict(model_id,vector);times.append((time.perf_counter_ns()-started)/1e6)
        hot_path[symbol]={"rows":len(times),"feature_plus_inference_ms":percentiles(times),"retained_option_events":len(engine.events)}
    status=maximum_error<=1e-12 and not health["dropped"] and not publisher_health["dropped"] and all(row["feature_plus_inference_ms"]["p95"]<=25 for row in hot_path.values())
    payload={"status":"PASS" if status else "FAIL","replay_kind":"accelerated historical frozen-vector replay; not live-market latency","rows":total,"models":results,"incremental_hot_path":hot_path,"performance_goal":{"feature_plus_inference_p95_ms":25,"feature_plus_inference_p99_ms":50},"maximum_prediction_error":maximum_error,"forward_logger":health,"publisher_queue":publisher_health,"feature_adapter_evidence":["parity_results.json","futures_parity_results.json"],"no_fit":True}
    output=repo/"audit/production_precommit/replay_latency_results.json";output.write_text(json.dumps(payload,indent=2)+"\n",encoding="utf-8");print(json.dumps(payload,indent=2));return 0 if payload["status"]=="PASS" else 2


if __name__=="__main__":raise SystemExit(main())
