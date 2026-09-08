"""Integration evidence for lossless Quant ingestion and frozen cadence parity."""

from __future__ import annotations

import argparse
import gzip
import json
import sys
import tempfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path


def load_real_rows(folder: Path, limit: int) -> list[dict]:
    rows: dict[str, dict] = {}
    for path in sorted(folder.glob("page_*.json.gz")):
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            for row in json.load(handle).get("data", []):
                if row.get("id"):
                    rows.setdefault(str(row["id"]), row)
        if len(rows) >= limit:
            break
    return sorted(rows.values(), key=lambda row:(int(row["tradeTime"]),str(row["id"])))[:limit]


def main() -> int:
    parser=argparse.ArgumentParser();parser.add_argument("--research-root",type=Path,required=True);parser.add_argument("--repo-root",type=Path,required=True)
    args=parser.parse_args();research=args.research_root.resolve();repo=args.repo_root.resolve();sys.path.insert(0,str(repo/"backend"))
    from predictive_live.cadence import FrozenCandidateCadence
    from predictive_live.features import IncrementalOptionFeatures
    from predictive_live.providers.contracts import quant_candidate_eligible,quant_context_eligible
    from predictive_live.providers.event_adapter import option_print_from_quant
    from predictive_live.providers.quantdata_live import QuantDataLiveClient

    source=load_real_rows(research/"datasets/raw_quantdata_additions/order_flow_unconsolidated_1dte/context/SPY/2026-06-30",2505)
    if len(source)<2505:raise RuntimeError("Insufficient real replay rows")
    descending=sorted(source,key=lambda row:(int(row["tradeTime"]),str(row["id"])),reverse=True)
    pages=[]
    def post(_path,payload):
        start=int(payload.get("searchAfter",[0])[0]);size=int(payload["size"]);page=descending[start:start+size]
        cursor=[start+size] if start+size<len(descending) else None;pages.append({"start":start,"rows":len(page)})
        return {"data":page,"nextSearchAfter":cursor},{}
    audit=repo/"audit/production_precommit_v2";audit.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="quant-watermark-v2-",dir=audit) as temporary:
        state=Path(temporary)/"watermark.json";client=QuantDataLiveClient("dummy",state_path=state,post_override=post,max_pages=10)
        polled=client.poll_option_prints("SPY",session_date="2026-06-30")
        initial_page_count=client.last_poll_diagnostics["SPY"]["pages"]
        client.acknowledge_many("SPY","2026-06-30",polled)
        duplicate_poll=client.poll_option_prints("SPY",session_date="2026-06-30")
        restarted=QuantDataLiveClient("dummy",state_path=state,post_override=post,max_pages=10)
        restart_poll=restarted.poll_option_prints("SPY",session_date="2026-06-30")

        # The legacy archive predates explicit isComplex/isTied capture (both
        # fields are null), so it is valid pagination evidence but must fail
        # closed for live feature context.  Exercise the frozen context/cadence
        # contract with an explicitly classified live-schema replay derived
        # from the same market rows; no values or outcomes are used for fitting.
        live_schema=[]
        for index,row in enumerate(polled):
            replay=dict(row)
            replay["isComplex"] = bool(index % 17 == 0)
            replay["isTied"] = bool(index % 29 == 0)
            replay["isCancelled"] = False
            live_schema.append(replay)
        engine=IncrementalOptionFeatures();cadence=FrozenCandidateCadence();completed=[]
        open_ms=int(datetime(2026,6,30,13,30,tzinfo=timezone.utc).timestamp()*1000)
        reference={};context_rejections=Counter();candidate_count=0;context_count=0
        for row in live_schema:
            okay,reason=quant_context_eligible(row)
            if not okay:context_rejections[reason]+=1;continue
            context_count+=1
            event=option_print_from_quant(row);candidate,_=quant_candidate_eligible(row)
            if candidate and open_ms<=event.event_time_ms<=open_ms+6*60*60*1000:
                vector=engine.snapshot(event,cadence_seconds=60,session_open_ms=open_ms)
                prepared=cadence.make(event,open_ms,{"audit":vector});completed.extend(cadence.observe(prepared))
                bucket=(event.event_time_ms-open_ms)//60000
                prior=reference.get(bucket)
                if prior is None or (event.event_time_ms,event.provider_id)>=(prior.event_time_ms,prior.provider_id):reference[bucket]=event
                candidate_count+=1
            engine.ingest(event)
        completed.extend(cadence.flush_due(max(row["tradeTime"] for row in polled)+60000))
        expected=[event.provider_id for _bucket,event in sorted(reference.items())]
        actual=[item.event.provider_id for item in completed]
        payload={
            "status":"PASS" if len(polled)==2505 and not duplicate_poll and not restart_poll and actual==expected else "FAIL",
            "source":"real archived SPY unconsolidated 1DTE context tape, 2026-06-30",
            "classification_replay":"real market rows with explicit synthetic live-schema complex/tied booleans; legacy archive null flags remain fail-closed",
            "legacy_null_flag_rows":sum(row.get("isComplex") is None or row.get("isTied") is None for row in polled),
            "rows_presented":len(source),"rows_consumed_once":len(polled),"unique_ids":len({row["id"] for row in polled}),
            "pages_walked_initial":pages[:initial_page_count],"initial_page_count":initial_page_count,
            "duplicates_on_second_poll":len(duplicate_poll),"duplicates_after_restart":len(restart_poll),
            "eligible_context_rows":context_count,
            "context_rejections":dict(context_rejections),"eligible_candidate_events":candidate_count,
            "cadence_candidates_expected":len(expected),"cadence_candidates_actual":len(actual),
            "cadence_identity_match":actual==expected,"candidate_policy":"latest eligible event per symbol fixed 60-second bucket",
            "bounded_option_queue_rows":len(engine.events),"watermark_persisted":state.is_file(),
            "same_millisecond_stable_tie_key":"tradeTime + provider id",
        }
    output=audit/"runtime_contract_validation.json";output.write_text(json.dumps(payload,indent=2)+"\n",encoding="utf-8")
    print(json.dumps(payload,indent=2));return 0 if payload["status"]=="PASS" else 2


if __name__=="__main__":raise SystemExit(main())
