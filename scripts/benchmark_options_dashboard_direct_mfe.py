"""Benchmark the complete local Direct-MFE decision path for all four models."""

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


def percentiles(values: list[float]) -> dict[str, float]:
    return {name: float(np.percentile(values, percentile)) for name, percentile in
            (("p50", 50), ("p95", 95), ("p99", 99), ("max", 100))}


class OpenCalendar:
    VERSION = "LOCAL_REPLAY_ALWAYS_ACTIONABLE"
    def actionable_y30(self, _stamp: int): return True, "OK", None
    def market_state(self, _stamp: datetime): return {"state":"OPEN", "calendar_version":self.VERSION}


def main() -> int:
    parser=argparse.ArgumentParser()
    parser.add_argument("--repo-root",required=True,type=Path)
    parser.add_argument("--live-root",required=True,type=Path)
    parser.add_argument("--rows",type=int,default=80)
    args=parser.parse_args();repo=args.repo_root.resolve();live=args.live_root.resolve()
    sys.path.insert(0,str(repo/"backend"))
    from predictive_live.artifacts import FrozenModelFleet
    from predictive_live.cadence import FrozenCandidateCadence, PreparedCadenceCandidate
    from predictive_live.features import LiveFeatureEngine, OptionPrint
    from predictive_live.forward_store import AsyncForwardRecorder, AsyncPublishQueue
    from predictive_live.service import MODEL_FUTURES, PredictiveLiveService

    fleet=FrozenModelFleet(live/"models/manifests/artifact_registry_direct_mfe_v2.json")
    audit=repo/"audit/options_dashboard_precommit";audit.mkdir(parents=True,exist_ok=True)
    base_ms=int(datetime.now(timezone.utc).timestamp()*1000)-2_000
    features=LiveFeatureEngine()
    for symbol in ("SPY","QQQ"):
        for index in range(1_800):
            stamp=base_ms-1_800_000+index*1_000
            side="CALL" if index%2==0 else "PUT"
            event=OptionPrint(symbol,stamp,f"{symbol}_HIST_{index%24}",side,"ASK" if index%3 else "BID",
                100.0+index%7,index%11+1,.65 if side=="CALL" else -.65,650.0+index*.001,
                trade_type="AUTO",provider_id=f"warm-{symbol}-{index}",fields={
                    "bidPrice":1.00,"askPrice":1.02,"optionPrice":1.01,"impliedVolatility":.20,
                    "strikePrice":650.0,"expiration":"2026-09-10","actual_tte_minutes_rth":1_800.0,
                    "greeks":{"delta":.65 if side=="CALL" else -.65,"gamma":.05,"theta":-.08,
                        "vega":.12,"rho":.01,"vanna":.02,"charm":-.01,"vomma":.03,"veta":.01,
                        "speed":.001,"zomma":.002,"color":.001,"ultima":.001,"omega":3.0,"sigma":.2},
                    "moneyness":{"degree":1.0,"degreeInPercent":.15,"moneyType":"IN_THE_MONEY"},
                    "trade_side_code":"ASK" if index%3 else "BID","trade_class":"SIMPLE_DIRECTIONAL",
                    "trade_classifier_version":"QUANT_TRADETYPE_COMPLEX_TIED_V1","is_simple_directional":True,
                    "is_complex":False,"is_tied":False,"is_ambiguous":False,"is_excluded_bad_trade":False})
            features.record_candidate_event(event)
    for instrument in ("ES","NQ"):
        for second in range(base_ms//1000-130,base_ms//1000+1):
            price=(5_500 if instrument=="ES" else 20_000)+(second%17)*.25
            features.futures[instrument].ingest_second_summary(second=second,last_open=price,last_high=price+.25,
                last_low=price-.25,last_close=price,bid=price-.25,ask=price+.25,volume=12,
                trade_count=4,large_trade_count=1)

    with tempfile.TemporaryDirectory(prefix="options-dashboard-bench-",dir=audit) as temp:
        recorder=AsyncForwardRecorder(Path(temp),max_queue=20_000)
        publisher=AsyncPublishQueue(lambda _table,_row:None,max_queue=2_000)
        config=json.loads((live/"config/predictive_live_v1.json").read_text(encoding="utf-8"))
        service=PredictiveLiveService(fleet,None,features,recorder,publisher,config=config,live_root=live,calendar=OpenCalendar())
        service.option_warm={"SPY":True,"QQQ":True}
        now=datetime.now(timezone.utc).isoformat()
        for provider in ("QUANT_DATA","WEBULL","NINJATRADER_ES","NINJATRADER_NQ"):
            service.update_provider_health(provider,status="LIVE",age_ms=0,event_time=now,receipt_time=now)
        for symbol in ("SPY","QQQ"):
            service.update_structure_state(symbol,{"source":"TRUSTED_DETERMINISTIC_V2_READ_ONLY","as_of":now,
                "structure_bias":"BULLISH","transition":False,"accepted_below":False,"accepted_above":False,
                "call_invalidation_level":645.0,"put_invalidation_level":655.0})
        results={}
        for model_id in fleet.model_ids:
            symbol=model_id[:3]; future=MODEL_FUTURES[model_id]; elapsed=[]; decisions=0; surface_failures=0
            contract=f"{symbol}_DIRECT_MFE_BENCH_CALL"
            for index in range(args.rows):
                stamp=base_ms+index
                candidate=OptionPrint(symbol,stamp,contract,"CALL","ASK",102.0,2,.65,650.0,
                    trade_type="AUTO",provider_id=f"bench-{model_id}-{index}",fields={
                        "bidPrice":1.00,"askPrice":1.02,"optionPrice":1.01,"impliedVolatility":.20,
                        "strikePrice":650.0,"expiration":"2026-09-10","actual_tte_minutes_rth":1_800.0,
                        "greeks":{"delta":.65,"gamma":.05,"theta":-.08,"vega":.12,"rho":.01,
                            "vanna":.02,"charm":-.01,"vomma":.03,"veta":.01,"speed":.001,
                            "zomma":.002,"color":.001,"ultima":.001,"omega":3.0,"sigma":.2},
                        "moneyness":{"degree":1.0,"degreeInPercent":.15,"moneyType":"IN_THE_MONEY"},
                        "trade_side_code":"ASK","trade_class":"SIMPLE_DIRECTIONAL",
                        "trade_classifier_version":"QUANT_TRADETYPE_COMPLEX_TIED_V1","is_simple_directional":True,
                        "is_complex":False,"is_tied":False,"is_ambiguous":False,"is_excluded_bad_trade":False})
                service.on_webull_quote(contract,{"bid":1.00,"ask":1.02,"quote_time":datetime.now(timezone.utc).isoformat()})
                started=time.perf_counter_ns()
                vector=features.build(candidate,cadence_seconds=60,session_open_ms=stamp-3_600_000,
                    futures_source=future,allowlist=fleet.features_for(model_id))
                prepared=PreparedCadenceCandidate(candidate,stamp-3_600_000,60,stamp,{model_id:vector})
                cadence=FrozenCandidateCadence();complete=cadence.observe(prepared)+cadence.flush_due(stamp+60_000)
                structure={"source":"TRUSTED_DETERMINISTIC_V2_READ_ONLY","as_of":datetime.now(timezone.utc).isoformat(),
                    "structure_bias":"BULLISH","transition":False,"accepted_below":False,"accepted_above":False,
                    "call_invalidation_level":645.0,"put_invalidation_level":655.0}
                output=[row for item in complete for row in service.process_cadence_candidate(item,structure)]
                elapsed.append((time.perf_counter_ns()-started)/1e6)
                decisions+=len(output)
                if output:
                    row=output[0]
                    surface_failures += int(len(row.display_probability_surface)!=18 or row.grade_probability!=row.display_probability_surface["p30_30"])
            results[model_id]={"rows":args.rows,"decisions":decisions,"surface_contract_failures":surface_failures,
                "full_local_decision_ms":percentiles(elapsed)}
        recorder.queue.join();publisher.wait_idle(10);recorder_health=recorder.health();publisher_health=publisher.health()
        recorder.close();publisher.close()

    ack={};done=threading.Event()
    def slow_publish(table:str,payload:dict)->None:
        time.sleep((50+(int(payload.get("sequence",0))%3)*50)/1000)
        if table=="predictive_model_state_live":ack["stamp"]=time.perf_counter();done.set()
    transport=AsyncPublishQueue(slow_publish,max_queue=500)
    for revision in range(3):
        for index in range(100):transport.submit("predictive_option_ladder_live",{"contract_key":f"ROW-{index}","sequence":revision*100+index})
    started=time.perf_counter();transport.submit("predictive_model_state_live",{"model_id":"SPY_OPTIONS_ONLY","sequence":1})
    high_done=done.wait(2);high_ack=(ack.get("stamp",time.perf_counter())-started)*1000
    drained=transport.wait_idle(20);transport_health=transport.health();transport.close()
    local_ok=all(row["decisions"]==args.rows and row["surface_contract_failures"]==0 and
                 row["full_local_decision_ms"]["p95"]<=25 and row["full_local_decision_ms"]["p99"]<=50
                 for row in results.values())
    publisher_ok=high_done and high_ack<500 and drained and not transport_health["dropped"] and not transport_health["errors"]
    payload={"status":"PASS" if local_ok and publisher_ok else "FAIL",
        "replay_kind":"accelerated synthetic live-shaped full local runtime replay; not live-market latency",
        "local_path":"incremental option/futures snapshot -> 60s candidate finalization -> 18-cell frozen inference -> monotone projection -> selection -> grade -> three Aim For values -> sticky invalidation -> publish enqueue",
        "models":results,"goals_ms":{"p95":25,"p99":50},"forward_logger":recorder_health,
        "local_publisher":publisher_health,"simulated_network_publisher":{"network_latency_ms":[50,150],
            "high_priority_model_ack_ms":high_ack,"high_priority_completed":high_done,"queue_drained":drained,**transport_health},
        "no_fit_or_artifact_mutation":True,"zero_dte_collection":False}
    output=audit/"direct_mfe_runtime_benchmark.json";output.write_text(json.dumps(payload,indent=2)+"\n",encoding="utf-8")
    print(json.dumps(payload,indent=2));return 0 if payload["status"]=="PASS" else 2


if __name__=="__main__":raise SystemExit(main())
