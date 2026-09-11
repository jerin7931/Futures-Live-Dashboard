from __future__ import annotations

import json
import inspect
import math
import re
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import numpy as np

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "backend"))

from predictive_live.artifacts import ArtifactIntegrityError, FrozenModelFleet
from predictive_live.cadence import FrozenCandidateCadence, PreparedCadenceCandidate
from predictive_live.calendar import ExchangeSessionCalendar
from predictive_live.features import IncrementalFuturesFeatures, IncrementalOptionFeatures, OptionPrint
from predictive_live.forward_store import AsyncForwardRecorder, AsyncPublishQueue
from predictive_live.gex import GexSessionState
from predictive_live.mapping import TargetLadderMapping
from predictive_live.policies import InvalidationMachine, ThesisState, aim_for, choose_contract, gamma_regime, grade_for_probability, market_condition, rounded_aim_percent
from predictive_live.providers.contracts import (BAD_TRADE_TYPES, candidate_delta_band,
    eligible_contract, quant_candidate_eligible, quant_context_eligible, quote_valid)
from predictive_live.providers.event_adapter import option_print_from_quant
from predictive_live.providers.quantdata_live import PROJECTION, QuantDataLiveClient
from predictive_live.providers.ninjatrader_live import PredictiveLevel1Receiver
from predictive_live.providers.webull_live import PredictiveWebullMarketData
from predictive_live.provider_health import PROVIDER_HEALTH_IDS
from predictive_live.runtime import PredictiveProviderRuntime, startup_option_history_ready
from predictive_live.service import ModelDecision, PredictiveLiveService
from predictive_live.structure_adapter import V2StructureAdapter
from predictive_live.supabase_publish import PredictiveCurrentStatePublisher
from predictive_live.trade_classification import DOCUMENTED_TRADE_TYPES, classify_trade_type
from v2.providers.webull import WebullResult
from predictive_live.direct_mfe import (DirectMfePrediction, SURFACE_CONTRACT,
    SURFACE_KEYS, aim_for_by_horizon, project_surface, rounded_aim_for_by_horizon,
    surface_dict, validate_surface)


LIVE = Path.home() / "Documents" / "TradyticsPredictiveLive"
REGISTRY = LIVE / "models" / "manifests" / "artifact_registry_direct_mfe_v2.json"


def test_four_frozen_artifacts_verify_and_load_once():
    fleet = FrozenModelFleet(REGISTRY)
    assert set(fleet.model_ids) == fleet.REQUIRED_MODELS
    assert fleet.health()["status"] == "VERIFIED"
    assert all(item["prediction_count"] == 0 for item in fleet.health()["models"].values())


def test_all_four_frozen_models_emit_valid_direct_mfe_surfaces_once_loaded():
    fleet = FrozenModelFleet(REGISTRY)
    for model_id in fleet.model_ids:
        prediction = fleet.predict_surface(model_id, {name: 0 for name in fleet.features_for(model_id)})
        assert set(prediction.uncalibrated_probability_surface) == set(SURFACE_KEYS)
        assert set(prediction.raw_probability_surface) == set(SURFACE_KEYS)
        validate_surface(prediction.display_probability_surface, monotone=True)
        assert prediction.grade_probability == prediction.display_probability_surface["p30_30"]
        assert set(prediction.display_aim_for_percent_by_horizon) == {"10", "20", "30"}
    assert all(item["prediction_count"] == 1 for item in fleet.health()["models"].values())


def test_direct_mfe_registry_is_exact_and_locked_reserve_is_unaccessed():
    registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
    expected = {
        "SPY_OPTIONS_ONLY": "e0a81ddb547958121ea29fb309577a15b5af0b629205b22c5939ef3a5d65ebc1",
        "SPY_OPTIONS_PLUS_ES": "688ad9e3e5893223a807be0c56e483cb7e17a8fa448d8ae5ac525897d764ea10",
        "QQQ_OPTIONS_ONLY": "6d3a2c06ed5db76470c4d35323f5d47e9f33a50e2775a659c47a2242a7acc103",
        "QQQ_OPTIONS_PLUS_NQ": "832666b15ab41065caffba721d5fd36ddb33eac438aed5caebcd98f11abf55a6",
    }
    assert registry["contract"] == "DIRECT_MFE_MODELS_FROZEN_V2"
    assert registry["surface_contract"] == SURFACE_CONTRACT
    assert {row["model_id"]: row["model_sha256"] for row in registry["models"]} == expected
    lock = registry["locked_holdout"]
    assert lock == {"start":"2026-08-17", "end":"2026-09-04", "status":"LOCKED_UNACCESSED",
                    "feature_access_allowed":False, "target_access_allowed":False,
                    "outcomes_inspected":False}


def test_artifact_hash_mismatch_fails_closed(tmp_path):
    payload = json.loads(REGISTRY.read_text(encoding="utf-8"))
    payload["models"][0]["model_sha256"] = "0" * 64
    path = tmp_path / "registry.json"; path.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(ArtifactIntegrityError, match="hash mismatch"):
        FrozenModelFleet(path)


def test_production_path_has_no_training_or_search_calls():
    sources = "\n".join(path.read_text(encoding="utf-8") for path in (REPO / "backend" / "predictive_live").rglob("*.py"))
    forbidden = [r"\.partial_fit\s*\(", r"\.fit\s*\(", r"\boptuna\b", r"hyperparameter.search"]
    assert not any(re.search(pattern, sources, re.I) for pattern in forbidden)


def test_production_path_has_no_order_placement_import_or_call():
    sources = "\n".join(path.read_text(encoding="utf-8") for path in (REPO / "backend" / "predictive_live").rglob("*.py"))
    source_lower = sources.lower()
    assert "tradeclient" not in source_lower
    assert "place_order" not in source_lower
    assert "submit_order" not in source_lower


@pytest.mark.parametrize("probability,expected", [(.249999,"B"),(.25,"A"),(.15,"B"),(.1499,"C"),(.10,"C"),(.0999,None)])
def test_grade_boundaries(probability, expected):
    assert grade_for_probability(probability) == expected


def test_direct_surface_projection_and_three_horizon_aim_for_contract():
    raw = [.60,.64,.50,.42,.35,.31, .58,.55,.52,.44,.36,.32, .70,.61,.54,.46,.38,.34]
    display = surface_dict(project_surface(raw))
    validate_surface(display, monotone=True)
    assert set(display) == set(SURFACE_KEYS)
    aims = aim_for_by_horizon(display)
    rounded = rounded_aim_for_by_horizon(display)
    assert set(aims) == set(rounded) == {"10","20","30"}
    assert all(0 <= value <= .30 for value in aims.values())
    assert rounded == {key: round(value * 100) for key, value in aims.items()}


def test_direct_surface_raw_values_are_not_mutated_by_display_projection():
    raw = np.asarray([.40,.45,.30,.22,.18,.12, .38,.42,.34,.25,.20,.15,
                      .50,.44,.37,.29,.23,.17], dtype=float)
    preserved = raw.copy()
    display = project_surface(raw)
    assert np.array_equal(raw, preserved)
    assert np.max(np.abs(display - raw)) > 0
    validate_surface(surface_dict(display), monotone=True)


def test_grade_strength_is_direct_display_p30_30_not_legacy_lookup():
    source = inspect.getsource(PredictiveLiveService.process_cadence_candidate)
    assert "prediction.grade_probability" in source
    assert "mapping.lookup" not in source
    assert grade_for_probability(.25) == "A" and grade_for_probability(.15) == "B"


def test_call_put_invalidation_symmetry_and_persistence():
    for direction, bad_structure in (("CALL","BEARISH"),("PUT","BULLISH")):
        machine=InvalidationMachine(direction,.15)
        assert machine.update(current_probability=.09,opposite_probability=.16,structure_bias=bad_structure)==ThesisState.WARNING
        assert machine.update(current_probability=.09,opposite_probability=.16,structure_bias=bad_structure)==ThesisState.INVALIDATED
        assert machine.reason=="MODEL_REVERSAL_CONFIRMED"


def test_wick_is_not_structural_invalidation_and_data_failure_is_not_reversal():
    machine=InvalidationMachine("CALL",.10)
    assert machine.update(current_probability=.2,opposite_probability=.01,structure_bias="BULLISH",accepted_structure_break=True,wick_only=True)==ThesisState.LIVE
    assert machine.update(current_probability=.2,opposite_probability=.01,structure_bias="BULLISH",data_valid=False)==ThesisState.LIVE
    assert machine.reason is None


def test_accepted_structural_break_invalidates():
    machine=InvalidationMachine("PUT",.10)
    assert machine.update(current_probability=.2,opposite_probability=.01,structure_bias="BEARISH",accepted_structure_break=True)==ThesisState.INVALIDATED
    assert machine.reason=="STRUCTURE_ACCEPTED_ABOVE_RESISTANCE"


def test_gamma_balance_and_market_condition_are_deterministic():
    assert gamma_regime({100:2,101:-1}) == gamma_regime({100:2,101:-1})
    assert -.999 <= gamma_regime({100:2,101:-1})["gamma_balance"] <= 1
    first=market_condition({"directional_flow":1,"net_drift":1,"skew_change":-1},{"above_vwap":True,"support_holding":True})
    assert first["label"]=="BULLISH" and "positive call-side flow" in first["reasons"]


def test_gex_baseline_fixed_and_next_session_resets():
    state=GexSessionState()
    first=state.update(timestamp=datetime(2026,9,8,13,31,tzinfo=timezone.utc),signed_by_strike={100:10},scope="FULL_CHAIN")
    second=state.update(timestamp=datetime(2026,9,8,14,0,tzinfo=timezone.utc),signed_by_strike={100:14},scope="FULL_CHAIN")
    assert first["baseline_time"]==second["baseline_time"] and second["delta_from_rth_open"][100]==4
    next_day=state.update(timestamp=datetime(2026,9,9,13,31,tzinfo=timezone.utc),signed_by_strike={100:9},scope="FULL_CHAIN")
    assert next_day["delta_from_rth_open"][100]==0


def test_quote_and_contract_fail_closed():
    now=datetime.now(timezone.utc)
    assert quote_valid({"bid":1,"ask":.9,"quote_time":now.isoformat()},now=now)[0] is False
    assert quote_valid({"bid":1,"ask":1.1,"quote_time":(now-timedelta(seconds=6)).isoformat()},now=now)[0] is False
    assert eligible_contract({"delta":.65,"dte":1})==(True,"OK")
    assert eligible_contract({"delta":.72,"dte":1})[0] is False


@pytest.mark.parametrize("delta,eligible", [(.489,False),(.49,True),(.55,True),(.60,True),(.70,True),(.701,False),(-.49,True),(-.70,True)])
def test_production_candidate_delta_boundaries(delta, eligible):
    row=_quant_row(f"boundary-{delta}",1788888600000,delta=delta)
    assert quant_candidate_eligible(row)[0] is eligible
    assert eligible_contract({"delta":delta,"dte":1})[0] is eligible


def test_expanded_candidate_does_not_contaminate_frozen_context_tape():
    low=_quant_row("low",1788888600000,delta=.52)
    context=_quant_row("context",1788888601000,delta=.56)
    high=_quant_row("high",1788888602000,delta=.72)
    assert quant_candidate_eligible(low)[0] and not quant_context_eligible(low)[0]
    assert quant_candidate_eligible(context)[0] and quant_context_eligible(context)[0]
    assert not quant_candidate_eligible(high)[0] and quant_context_eligible(high)[0]
    assert option_print_from_quant(low,candidate=True).delta==pytest.approx(.52)
    assert candidate_delta_band(.52)=="EXTENDED_49_55"
    assert candidate_delta_band(.57)=="EXTENDED_55_60"
    assert candidate_delta_band(.65)=="ORIGINAL_60_70"


@pytest.mark.parametrize("wrapped", [False, True])
def test_webull_option_ladder_accepts_current_list_and_legacy_wrapped_shapes(wrapped):
    stamp = int(datetime.now(timezone.utc).timestamp() * 1000)
    contract = {
        "symbol": "SPY260910C00760000", "underlying_symbol": "SPY",
        "expiration_date": "2026-09-10", "strike_price": "760",
        "option_type": "CALL",
    }
    quote = {
        "symbol": contract["symbol"], "strike_price": "760", "bid": "2.10",
        "ask": "2.12", "bid_size": "11", "ask_size": "9", "price": "2.11",
        "deal_amount": "1200", "open_interest": "3400", "delta": "0.65",
        "gamma": "0.02", "imp_vol": "0.24", "quote_time": stamp,
    }
    shape = lambda rows: {"data": rows} if wrapped else rows

    class FakeClient:
        def option_contracts(self, *_args):
            return WebullResult(shape([contract]), None, "", 0.0, "LIVE")

        def option_snapshots(self, _symbols):
            return WebullResult(shape([quote]), None, "", 0.0, "LIVE")

    adapter = PredictiveWebullMarketData.__new__(PredictiveWebullMarketData)
    adapter.client = FakeClient()
    rows = adapter.option_ladder(symbol="SPY", expiration="2026-09-10",
        low_strike=740, high_strike=780, quant_surface=None, spot=762)
    assert len(rows) == 1
    assert rows[0]["contract_key"] == contract["symbol"]
    assert rows[0]["eligible"] is True
    assert rows[0]["bid"] == 2.10 and rows[0]["ask"] == 2.12


def test_futures_stale_contract_and_second_ordering():
    engine=IncrementalFuturesFeatures("ES")
    engine.ingest_second_summary(second=100,last_close=5000,bid=4999.75,ask=5000.0,volume=5,trade_count=1)
    with pytest.raises(Exception, match="Non-increasing"):
        engine.ingest_second_summary(second=100,last_close=5001)


def test_completed_empty_futures_bucket_does_not_refresh_market_age():
    engine=IncrementalFuturesFeatures("ES")
    engine.ingest_second_summary(second=100,last_close=5000,bid=4999.75,ask=5000.0,
                                 trade_seen=True,quote_seen=True)
    assert engine.last_event_ms==100_000
    engine.ingest_second_summary(second=101,bid=4999.75,ask=5000.0,
                                 trade_seen=False,quote_seen=False)
    assert engine.last_event_ms==100_000


def test_ninjatrader_receiver_accepts_sequence_reset_only_for_new_sender_session():
    consumed=[]
    receiver=PredictiveLevel1Receiver(consumed.append)

    def packet(session, sequence):
        return json.dumps({"type":"predictive_level1_second_v1","instrument":"ES",
            "contract":"ES 12-26","sender_session_id":session,"sequence":sequence,
            "second":1789050000,"provider_event_second":1789050000}).encode()

    assert receiver.consume_datagram(packet("sender-a",100)) is True
    assert receiver.consume_datagram(packet("sender-a",100)) is False
    assert receiver.consume_datagram(packet("sender-a",99)) is False
    assert receiver.consume_datagram(packet("sender-b",1)) is True
    assert receiver.consume_datagram(packet("sender-b",1)) is False
    assert receiver.consume_datagram(packet("sender-a",101)) is False
    assert [(row["sender_session_id"],row["sequence"]) for row in consumed]==[("sender-a",100),("sender-b",1)]


def test_ninjatrader_addon_uses_rollover_resolver_and_restart_session_id():
    source=(REPO/"ninjatrader"/"TradyticsPredictiveLevel1Feed.cs").read_text(encoding="utf-8")
    assert 'ResolveFrontQuarterContract("ES", "TRADYTICS_ES_CONTRACT")' in source
    assert 'ResolveFrontQuarterContract("NQ", "TRADYTICS_NQ_CONTRACT")' in source
    assert 'Guid.NewGuid().ToString("N")' in source
    assert r'\"sender_session_id\"' in source
    assert '"ES 09-26"' not in source and '"NQ 09-26"' not in source


def test_non_candidate_quant_print_without_delta_is_excluded_from_context():
    row={"tradeTime":1788888600000,"expirationDate":"2026-09-09","greeks":{},"tradeSideCode":"A",
         "tradeType":"REGULAR","dte":1,"ticker":"SPY","osi":"SPY260909C00650000",
         "contractType":"CALL","premium":100,"size":1,"stockPrice":650}
    assert quant_context_eligible(row)==(False,"CONTEXT_DELTA_UNRESOLVABLE")
    with pytest.raises(ValueError,match="CONTEXT_DELTA_UNRESOLVABLE"):
        option_print_from_quant(row)


def test_forward_data_append_only_daily_and_secret_filter(tmp_path):
    recorder=AsyncForwardRecorder(tmp_path)
    recorder.submit("model_events",{"event":1,"api_key":"must-not-appear"})
    recorder.submit("model_events",{"event":2,"authorization":"must-not-appear"})
    recorder.queue.join(); recorder.close()
    files=list((tmp_path/"model_events").rglob("events.jsonl")); assert len(files)==1
    text=files[0].read_text(encoding="utf-8"); assert len(text.splitlines())==2
    assert "must-not-appear" not in text and "api_key" not in text.lower()


def _quant_row(identity: str, stamp: int, *, dte=1, delta=.65, complex_=False,
               tied=False, trade_type="AUTO", side="ASK", contract="CALL"):
    expiration={0:"2026-09-08",1:"2026-09-09",2:"2026-09-10"}.get(dte,"2026-09-09")
    return {"id":identity,"tradeTime":stamp,"expirationDate":expiration,
            "greeks":{"delta":delta,"gamma":.01,"vanna":.02,"charm":-.01},
            "tradeSideCode":side,"tradeType":trade_type,"dte":dte,"ticker":"SPY",
            "osi":f"SPY260909{contract[0]}00650000","contractType":contract,
            "premium":100.0,"size":1,"stockPrice":650.0,"bidPrice":1.0,"askPrice":1.02,
            "strikePrice":650.0,"isCancelled":False,"isComplex":complex_,"isTied":tied}


def test_exact_live_quant_context_universe_and_flow_parity():
    base=1788888600000
    mixed=[
        _quant_row("zero",base,dte=0),_quant_row("two",base+1,dte=2),
        _quant_row("d40",base+2,delta=.40),_quant_row("simple",base+3,delta=.65),
        _quant_row("d85",base+4,delta=.85),
        _quant_row("complex",base+5,trade_type="MULTI_AUTO_COB"),
        _quant_row("tied",base+6,trade_type="TIED_MULTI_AUTO_COB"),
        _quant_row("cancel",base+7,trade_type="CANCEL"),
    ]
    assert set(BAD_TRADE_TYPES)=={"OUT_OF_SEQ","OPEN_OUT_OF_SEQ","SOLD_LAST","CANCEL","CANCEL_LAST","CANCEL_OPEN","CANCEL_ONLY"}
    accepted=[row for row in mixed if quant_context_eligible(row)[0]]
    assert [row["id"] for row in accepted]==["simple","complex","tied"]
    engine=IncrementalOptionFeatures()
    for row in accepted:
        engine.ingest(option_print_from_quant(row))
    candidate=option_print_from_quant(_quant_row("candidate",base+2000))
    vector=engine.snapshot(candidate,cadence_seconds=60,session_open_ms=base-60000)
    assert vector["simple_directional_flow_call_buy_count_5s"]==1
    assert vector["complex_tied_flow_total_count_5s"]==2
    assert vector["entry_is_complex"]==0 and vector["entry_is_tied"]==0
    assert "GREEKS" not in PROJECTION
    assert {"DELTA","GAMMA","THETA","VEGA","VANNA","CHARM"} <= set(PROJECTION)
    assert {"IS_COMPLEX","IS_TIED","IS_CANCELLED"}.isdisjoint(PROJECTION)


def test_trade_type_classifier_covers_official_taxonomy_and_fails_unknown_closed():
    assert len(DOCUMENTED_TRADE_TYPES) == 33
    for trade_type in DOCUMENTED_TRADE_TYPES:
        result = classify_trade_type(trade_type)
        assert result["is_ambiguous"] is False
        assert sum((result["is_simple_directional"], result["is_complex"],
                    result["is_excluded_bad_trade"], result["is_extended_hours"])) >= 1
    tied = classify_trade_type("TIED_M2S_AUCT")
    assert tied["is_tied"] and tied["is_complex"] and not tied["is_simple_directional"]
    unknown = classify_trade_type("UNDOCUMENTED_FUTURE_CODE")
    assert unknown["trade_class"] == "AMBIGUOUS_NON_DIRECTIONAL"
    assert unknown["is_ambiguous"] and not unknown["is_simple_directional"]


def test_same_millisecond_other_print_never_enters_candidate_context():
    base=1788888600000;engine=IncrementalOptionFeatures()
    other=option_print_from_quant(_quant_row("other",base))
    candidate=option_print_from_quant(_quant_row("candidate",base))
    engine.ingest(other)
    vector=engine.snapshot(candidate,cadence_seconds=60,session_open_ms=base-60_000)
    assert vector["simple_directional_flow_call_buy_count_1s"]==0


@pytest.mark.parametrize("count",[500,1000,1001,2505])
def test_quant_cursor_walk_consumes_every_event_exactly_once(tmp_path,count):
    base=1788888600000
    source=[_quant_row(f"id-{index:05d}",base+index//3) for index in range(count)]
    descending=sorted(source,key=lambda row:(row["tradeTime"],row["id"]),reverse=True)
    calls=[]
    def post(_path,payload):
        start=int(payload.get("searchAfter",[0])[0]);size=int(payload["size"])
        page=descending[start:start+size];next_value=[start+size] if start+size<len(descending) else None
        calls.append((start,len(page)));return {"data":page,"nextSearchAfter":next_value},{}
    state=tmp_path/"watermark.json"
    client=QuantDataLiveClient("dummy",state_path=state,post_override=post,max_pages=10)
    rows=client.poll_option_prints("SPY",session_date="2026-09-08")
    assert len(rows)==count and len({row["id"] for row in rows})==count
    assert rows==sorted(rows,key=lambda row:(row["tradeTime"],row["id"]))
    client.acknowledge_many("SPY","2026-09-08",rows)
    assert client.poll_option_prints("SPY",session_date="2026-09-08")==[]
    restarted=QuantDataLiveClient("dummy",state_path=state,post_override=post,max_pages=10)
    assert restarted.poll_option_prints("SPY",session_date="2026-09-08")==[]


def test_quant_backfill_replays_acknowledged_history_for_restart_warmup(tmp_path):
    base=1788888600000; source=[_quant_row(f"id-{i}",base+i*1000) for i in range(180)]
    descending=list(reversed(source))
    def post(_path,payload):
        start=int(payload.get("searchAfter",[0])[0]);size=min(50,int(payload["size"]));page=descending[start:start+size]
        return {"data":page,"nextSearchAfter":[start+size] if start+size<len(descending) else None},{}
    state=tmp_path/"watermark.json";first=QuantDataLiveClient("dummy",state_path=state,post_override=post)
    first.acknowledge_many("SPY","2026-09-08",source)
    second=QuantDataLiveClient("dummy",state_path=state,post_override=post)
    warm=second.backfill_option_prints("SPY",since_ms=base+60_000,session_date="2026-09-08",page_size=50)
    assert [row["id"] for row in warm]==[row["id"] for row in source[60:]]


def test_quant_watermark_never_stops_inside_same_millisecond_tie(tmp_path):
    stamp=1788888600000
    source=[_quant_row(f"id-{i:04d}",stamp) for i in range(1500)]
    descending=sorted(source,key=lambda row:(row["tradeTime"],row["id"]),reverse=True)
    def post(_path,payload):
        start=int(payload.get("searchAfter",[0])[0]);size=int(payload["size"]);page=descending[start:start+size]
        return {"data":page,"nextSearchAfter":[start+size] if start+size<len(descending) else None},{}
    state=tmp_path/"watermark.json";client=QuantDataLiveClient("dummy",state_path=state,post_override=post)
    client.acknowledge("SPY","2026-09-08",descending[0])
    fresh=client.poll_option_prints("SPY",session_date="2026-09-08")
    assert len(fresh)==1499 and {row["id"] for row in fresh}=={row["id"] for row in source[:-1]}
    assert client.last_poll_diagnostics["SPY"]["pages"]==2


def _event(identity,stamp,osi):
    return OptionPrint("SPY",stamp,osi,"CALL","ASK",100,1,.65,650,
                       fields={"dte":1,"expiration":"2026-09-09","strikePrice":650,"bidPrice":1,"askPrice":1.02},
                       provider_id=identity)


def test_frozen_60s_candidate_constructor_latest_per_symbol_bucket_and_snapshot():
    cadence=FrozenCandidateCadence();open_ms=1788888600000
    first=cadence.make(_event("a",open_ms+1000,"A"),open_ms,{"m":{"x":1}})
    later=cadence.make(_event("b",open_ms+59000,"B"),open_ms,{"m":{"x":2}})
    assert cadence.observe(first)==[] and cadence.observe(later)==[]
    next_one=cadence.make(_event("c",open_ms+61000,"C"),open_ms,{"m":{"x":3}})
    completed=cadence.observe(next_one)
    assert len(completed)==1 and completed[0].event.osi=="B" and completed[0].snapshots["m"]["x"]==2
    assert cadence.flush_due(open_ms+122000)[0].event.osi=="C"


def test_contract_selection_is_order_invariant_and_competes_call_put():
    rows=[
        {"contract":"B","model_probability":.2,"relative_spread":.03,"delta":.64,"dte":1,"quote_valid":True,"direction":"CALL"},
        {"contract":"A","model_probability":.2,"relative_spread":.02,"delta":.61,"dte":1,"quote_valid":True,"direction":"PUT"},
        {"contract":"C","model_probability":.18,"relative_spread":.01,"delta":.65,"dte":1,"quote_valid":True,"direction":"CALL"},
    ]
    assert choose_contract(rows)["contract"]=="A"
    assert choose_contract(list(reversed(rows)))["contract"]=="A"


def test_contract_selection_uses_volume_then_delta_then_identifier_for_near_tied_scores():
    base={"relative_spread":.02,"dte":1,"quote_valid":True,"direction":"CALL"}
    rows=[
        {**base,"contract":"LOWVOL","model_probability":.20001,"current_session_volume":100,"delta":.65},
        {**base,"contract":"HIGHVOL","model_probability":.20004,"current_session_volume":200,"delta":.60},
    ]
    assert choose_contract(rows)["contract"]=="HIGHVOL"
    rows[0]["model_probability"]=.201
    assert choose_contract(rows)["contract"]=="LOWVOL"


def test_contract_selection_preserves_spread_before_volume_tie_break():
    base={"dte":1,"quote_valid":True,"direction":"CALL","model_probability":.20}
    rows=[
        {**base,"contract":"TIGHT","relative_spread":.01,"current_session_volume":100,"delta":.60},
        {**base,"contract":"WIDE","relative_spread":.02,"current_session_volume":20_000,"delta":.65},
    ]
    assert choose_contract(rows)["contract"]=="TIGHT"


def test_0dte_exposure_request_is_explicitly_filtered():
    captured=[]
    def post(path,payload):
        captured.append((path,payload));return {"data":{}},{}
    client=QuantDataLiveClient("dummy",post_override=post)
    client.exposure_by_strike("SPY",expiration_dates=["2026-09-09"])
    assert captured[0][1]["filter"]=={"ticker":"SPY","expirationDates":["2026-09-09"]}


def test_gex_scope_change_cannot_reuse_full_chain_baseline():
    state=GexSessionState()
    stamp=datetime(2026,9,9,13,31,tzinfo=timezone.utc)
    state.update(timestamp=stamp,signed_by_strike={100:10},scope="FULL_CHAIN")
    changed=state.update(timestamp=stamp+timedelta(minutes=1),signed_by_strike={100:4},scope="0DTE")
    assert changed["scope"]=="0DTE" and changed["delta_from_rth_open"][100]==0


def test_exchange_calendar_holiday_early_close_and_y30_gate():
    calendar=ExchangeSessionCalendar()
    assert calendar.session(datetime(2026,11,26).date()) is None
    early=calendar.session(datetime(2026,11,27).date());assert early and early.early_close
    assert early.close_utc.hour==18  # 13:00 ET in EST
    assert calendar.actionable_y30(int((early.close_utc-timedelta(minutes=30)).timestamp()*1000))[0]
    assert not calendar.actionable_y30(int((early.close_utc-timedelta(minutes=29,seconds=59)).timestamp()*1000))[0]


def test_startup_warmup_blocks_until_frozen_120s_history_can_exist():
    calendar=ExchangeSessionCalendar();session=calendar.session(datetime(2026,9,8).date())
    assert session is not None
    assert not startup_option_history_ready(session.open_utc+timedelta(seconds=119),session)
    assert startup_option_history_ready(session.open_utc+timedelta(seconds=120),session)
    source=inspect.getsource(PredictiveProviderRuntime._consume_print)
    assert "candidate_ok and not warmup" in source


def test_quant_poll_acknowledges_but_does_not_ingest_before_warmup():
    now_ms=int(time.time()*1000)
    rows_by_symbol={"SPY":[{"id":"spy","tradeTime":now_ms-10}],
                    "QQQ":[{"id":"qqq","tradeTime":now_ms-5}]}
    acknowledged=[];health=[];consumed=[]
    quant=type("Quant",(),{
        "last_successful_request_time":{"SPY":"receipt","QQQ":"receipt"},
        "last_real_provider_event_time":{"SPY":now_ms-10,"QQQ":now_ms-5},
        "poll_option_prints":lambda _self,symbol,session_date:rows_by_symbol[symbol],
        "acknowledge_many":lambda _self,symbol,session_date,rows:acknowledged.append((symbol,list(rows))),
    })()
    service=type("Service",(),{
        "staleness":{"quant_option_event":90},
        "update_provider_health":lambda _self,*args,**kwargs:health.append((args,kwargs)),
    })()
    session=type("Session",(),{"session_date":"2026-09-11"})()
    runtime=object.__new__(PredictiveProviderRuntime)
    runtime.quant=quant;runtime.service=service;runtime.warmup_complete=False
    runtime.calendar=type("Calendar",(),{"for_timestamp":lambda _self,_now:session})()
    runtime._consume_print=lambda row:consumed.append(row)

    runtime._poll_quant()

    assert consumed==[]
    assert acknowledged==[("SPY",rows_by_symbol["SPY"]),("QQQ",rows_by_symbol["QQQ"])]
    assert all(item[1]["status"]=="LIVE" for item in health)

    runtime.warmup_complete=True;acknowledged.clear();health.clear()
    runtime._poll_quant()
    assert consumed==[rows_by_symbol["SPY"][0],rows_by_symbol["QQQ"][0]]


def test_warmup_rebuild_resets_partial_or_newer_option_state_before_replay():
    operations=[]
    class OptionState:
        def __init__(self,symbol):self.symbol=symbol;self.dirty=True;self.reset_count=0
        def reset(self):
            self.dirty=False;self.reset_count+=1;operations.append((self.symbol,"reset"))
    states={symbol:OptionState(symbol) for symbol in ("SPY","QQQ")}
    service=type("Service",(),{})()
    service.features=type("Features",(),{"options":states})()
    service.set_option_warmup=lambda symbol,ready,detail="":operations.append((symbol,"ready",ready))
    now=datetime.now(timezone.utc)
    session=type("Session",(),{"open_utc":now-timedelta(hours=1),
                               "session_date":now.date().isoformat()})()
    rows={symbol:[{"symbol":symbol,"sequence":1},{"symbol":symbol,"sequence":2}]
          for symbol in ("SPY","QQQ")}
    acknowledged=[]
    quant=type("Quant",(),{
        "backfill_option_prints":lambda _self,symbol,since_ms,session_date:list(rows[symbol]),
        "acknowledge_many":lambda _self,symbol,session_date,values:acknowledged.append((symbol,list(values))),
    })()
    runtime=object.__new__(PredictiveProviderRuntime)
    runtime.service=service;runtime.quant=quant;runtime.warmup_complete=False
    runtime.calendar=type("Calendar",(),{"for_timestamp":lambda _self,_now:session})()
    def consume(row,warmup=False):
        state=states[row["symbol"]]
        assert state.dirty is False
        assert warmup is True
        operations.append((row["symbol"],"consume",row["sequence"]))
    runtime._consume_print=consume

    runtime._warmup()

    assert runtime.warmup_complete is True
    assert all(state.reset_count==1 for state in states.values())
    assert [symbol for symbol,_values in acknowledged]==["SPY","QQQ"]
    for symbol in ("SPY","QQQ"):
        assert operations.index((symbol,"reset")) < operations.index((symbol,"consume",1))


def test_model_warmup_state_does_not_overwrite_quant_transport_health():
    service=object.__new__(PredictiveLiveService)
    service.option_warm={"SPY":True,"QQQ":True}
    health_updates=[]
    service.update_provider_health=lambda *args,**kwargs:health_updates.append((args,kwargs))
    service.set_option_warmup("SPY",False,"MODEL_WARMUP_BACKFILL")
    assert service.option_warm["SPY"] is False
    assert health_updates==[]


def test_invalidated_is_terminal_until_new_episode_machine():
    machine=InvalidationMachine("CALL",.10,setup_episode_id="episode-1")
    machine.update(current_probability=.09,opposite_probability=.16,structure_bias="BEARISH")
    assert machine.update(current_probability=.09,opposite_probability=.16,structure_bias="BEARISH")==ThesisState.INVALIDATED
    assert machine.update(current_probability=.30,opposite_probability=0,structure_bias="BULLISH")==ThesisState.INVALIDATED
    assert machine.update(current_probability=.30,opposite_probability=0,structure_bias="BULLISH",data_valid=True)==ThesisState.INVALIDATED
    rearmed=InvalidationMachine("CALL",.25,setup_episode_id="episode-2")
    assert rearmed.state==ThesisState.LIVE and rearmed.setup_episode_id!=machine.setup_episode_id


def test_gex_baseline_restores_and_unmatched_strikes_are_not_zero(tmp_path):
    path=tmp_path/"baseline.json";stamp=datetime(2026,9,8,13,31,tzinfo=timezone.utc)
    first=GexSessionState(path);first.update(timestamp=stamp,signed_by_strike={100:10,101:20},scope="FULL_CHAIN")
    restored=GexSessionState(path);result=restored.update(timestamp=stamp+timedelta(hours=2),signed_by_strike={100:14,102:7},scope="FULL_CHAIN")
    assert result["delta_from_rth_open"]=={100.0:4.0}
    assert result["unmatched_current_strikes"]==[102.0] and result["unmatched_baseline_strikes"]==[101.0]


def test_forward_recorder_normalizes_nonfinite_without_loss(tmp_path):
    recorder=AsyncForwardRecorder(tmp_path);recorder.submit("model_events",{"nan":math.nan,"pos":math.inf,"neg":-math.inf,"nested":[math.nan]})
    recorder.queue.join();recorder.close();row=json.loads(next((tmp_path/"model_events").rglob("events.jsonl")).read_text())
    assert row["nan"] is None and row["pos"] is None and row["neg"] is None and row["nested"]==[None]


def test_priority_publisher_model_state_bypasses_ladder_flood():
    released=threading.Event();published=[]
    def publish(channel,payload):
        if channel=="predictive_option_ladder_live" and not released.is_set():
            released.wait(.3)
        time.sleep(.002);published.append((channel,payload.get("version")))
    queue_=AsyncPublishQueue(publish,max_queue=500)
    for i in range(100):queue_.submit("predictive_option_ladder_live",{"contract_key":f"C{i}","version":i})
    queue_.submit("predictive_model_state_live",{"model_id":"SPY_OPTIONS_ONLY","version":1})
    queue_.submit("predictive_model_state_live",{"model_id":"SPY_OPTIONS_ONLY","version":2})
    released.set();assert queue_.wait_idle(3);queue_.close()
    model_positions=[i for i,item in enumerate(published) if item[0]=="predictive_model_state_live"]
    assert model_positions and model_positions[0]<=1 and published[model_positions[0]][1]==2


def test_ladder_current_state_is_published_as_one_coalesced_batch(monkeypatch):
    captured = []

    class Response:
        def __enter__(self): return self
        def __exit__(self, *_args): return False
        def read(self): return b""

    def fake_open(request, timeout):
        captured.append(json.loads(request.data)); return Response()

    monkeypatch.setattr("urllib.request.urlopen", fake_open)
    publisher = object.__new__(PredictiveCurrentStatePublisher)
    publisher.url = "https://example.invalid"; publisher.key = "backend-only"
    batch = [
        {"contract_key":"A","symbol":"SPY","expiration":"2026-09-10","strike":760,
         "contract_type":"CALL","quote_time":"2026-09-09T17:00:00+00:00"},
        {"contract_key":"B","symbol":"SPY","expiration":"2026-09-10","strike":765,
         "contract_type":"PUT","quote_time":"2026-09-09T17:00:00+00:00"},
    ]
    publisher("predictive_option_ladder_live", {"_batch": batch})
    assert len(captured) == 1 and isinstance(captured[0], list)
    assert [row["contract_key"] for row in captured[0]] == ["A", "B"]
    assert all(row["active"] is True and row["payload"]["symbol"] == "SPY"
               for row in captured[0])


def test_ladder_batch_queue_coalesces_by_symbol():
    published = []
    queue_ = AsyncPublishQueue(lambda channel, payload: published.append((channel, payload)))
    queue_.submit("predictive_option_ladder_live", {"_batch":[
        {"contract_key":"A","symbol":"SPY"}, {"contract_key":"B","symbol":"SPY"}]})
    queue_.submit("predictive_option_ladder_live", {"_batch":[
        {"contract_key":"C","symbol":"SPY"}, {"contract_key":"D","symbol":"SPY"}]})
    assert queue_.wait_idle(2); queue_.close()
    assert published[-1][1]["_batch"][0]["contract_key"] == "C"


def test_single_contract_quote_patch_cannot_replace_pending_full_ladder_batch():
    full = {"_batch":[{"contract_key":"A","symbol":"SPY"},
                       {"contract_key":"B","symbol":"SPY"}]}
    patch = {"_batch":[{"contract_key":"A","symbol":"SPY"}]}
    assert AsyncPublishQueue._key("predictive_option_ladder_live", full).endswith("batch:SPY")
    assert AsyncPublishQueue._key("predictive_option_ladder_live", patch).endswith("contract:A")


def test_disabled_publisher_never_reports_live_transport():
    queue_=AsyncPublishQueue(None);assert queue_.health()["status"]=="DISABLED";queue_.close()


def test_publisher_health_recovers_after_same_channel_success_and_keeps_audit_history():
    attempts = 0

    def transient_publish(_channel, _payload):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise TimeoutError("synthetic transient failure")

    queue_ = AsyncPublishQueue(transient_publish)
    channel = "predictive_provider_health_live"
    queue_.submit(channel, {"provider":"SUPABASE","version":1})
    queue_.queue.join()
    failed = queue_.health()
    assert failed["status"] == "ERROR"
    assert channel in failed["active_errors"]
    assert failed["last_error_at"] is not None

    queue_.submit(channel, {"provider":"SUPABASE","version":2})
    queue_.queue.join()
    recovered = queue_.health()
    queue_.close()
    assert recovered["status"] == "LIVE"
    assert recovered["active_errors"] == {}
    assert recovered["successful_publishes"] == 1
    assert recovered["last_success_at"] is not None
    assert recovered["errors"]  # retained as lifetime audit evidence


def test_success_on_other_channel_does_not_mask_unresolved_publish_failure():
    failed_channel = "predictive_model_state_live"

    def channel_failure(channel, _payload):
        if channel == failed_channel:
            raise ConnectionError("synthetic channel failure")

    queue_ = AsyncPublishQueue(channel_failure)
    queue_.submit(failed_channel, {"model_id":"SPY_OPTIONS_ONLY"})
    queue_.queue.join()
    queue_.submit("predictive_provider_health_live", {"provider":"SUPABASE"})
    queue_.queue.join()
    health = queue_.health()
    queue_.close()
    assert health["status"] == "ERROR"
    assert set(health["active_errors"]) == {failed_channel}


def test_v2_structure_adapter_uses_real_payload_without_reimplementation():
    payload={"cash_price":650,"etf_vwap":649,"directional_core":.4,"state":"CALL_READY",
             "display_state":"CALL READY","as_of":datetime.now(timezone.utc).isoformat(),
             "support_zone":{"current_role":"SUPPORT","lower_bound":648,"upper_bound":649,"center":648.5,"accepted_state":"NEUTRAL"},
             "active_path_zones":[]}
    result=V2StructureAdapter(lambda _symbol:{"payload":payload}).snapshot("SPY")
    assert result["source"]=="TRUSTED_DETERMINISTIC_V2_READ_ONLY"
    assert result["above_vwap"] is True and result["call_invalidation_level"]==648


def test_v2_structure_acceptance_is_bound_to_the_selected_side_zone():
    payload={"cash_price":650,"etf_vwap":649,"directional_core":.4,"state":"CALL_READY",
        "as_of":datetime.now(timezone.utc).isoformat(),
        "support_zone":{"current_role":"SUPPORT","lower_bound":648,"center":648.5,"accepted_state":"NEUTRAL"},
        "active_path_zones":[{"current_role":"RESISTANCE","center":652,"upper_bound":653,
                              "accepted_state":"ACCEPTED_BELOW"}]}
    result=V2StructureAdapter(lambda _symbol:{"payload":payload}).snapshot("SPY")
    assert result["accepted_below"] is False


def test_gex_poll_passes_provider_spot_as_the_gamma_fallback():
    source = inspect.getsource(PredictiveProviderRuntime._poll_gex_context)
    assert "spot=provider_spot" in source
    assert "self.latest_spot.get(symbol, provider_spot)" not in source


class _Sink:
    def __init__(self):self.rows=[]
    def submit(self,*args):self.rows.append(args)


def _bare_service():
    service=object.__new__(PredictiveLiveService)
    service.active_expiration={};service.ladder_cache={};service.contract_context_cache={}
    service.gex={"SPY":GexSessionState(),"QQQ":GexSessionState()}
    service.recorder=_Sink();service.publisher=_Sink();service.decisions={}
    service.selected_contracts={};service.latest_side_evidence={};service.best_sides={}
    return service


def _decision(**changes):
    surface={f"p{target}_{horizon}":value for horizon,value in ((10,.22),(20,.26),(30,.30))
             for target in (5,10,15,20,25,30)}
    values={
        "model_id":"SPY_OPTIONS_ONLY","model_version":"test","symbol":"SPY","state":"INVALIDATED",
        "guidance_state":"LIVE","thesis_state":"INVALIDATED","setup_episode_id":"episode-1",
        "direction":"CALL","grade":"A","probability":.30,"grade_probability":.30,
        "surface_contract":SURFACE_CONTRACT,"uncalibrated_probability_surface":dict(surface),
        "raw_probability_surface":dict(surface),"display_probability_surface":dict(surface),
        "raw_aim_for_by_horizon":{"10":.066,"20":.078,"30":.09},
        "aim_for_percent_by_horizon":None,
        "selected_contract_probability_at_selection":.30,"selected_contract_event_time":datetime.now(timezone.utc).isoformat(),
        "latest_same_side_probability":.30,"latest_same_side_event_time":datetime.now(timezone.utc).isoformat(),
        "latest_same_side_age_ms":0,"latest_same_side_fresh":True,
        "latest_opposite_side_probability":.16,"latest_opposite_side_event_time":datetime.now(timezone.utc).isoformat(),
        "latest_opposite_side_age_ms":0,"latest_opposite_side_fresh":True,
        "probability_language":"P(proxy +30% event within 30m)","aim_for_percent":None,
        "target_premium":None,"ladder":{"0.05":.8,"0.1":.6,"0.15":.5,"0.2":.4,"0.25":.35,"0.3":.3},
        "ladder_language":"Historical proxy","candidate_contract":"C","expiration":"2026-09-09",
        "strike":650.0,"delta":.65,"bid":1.0,"ask":1.02,"relative_spread":.02,
        "model_event_time":datetime.now(timezone.utc).isoformat(),"model_age_ms":0,
        "latest_quote_time":datetime.now(timezone.utc).isoformat(),"quote_age_ms":0,
        "invalid_if":"Invalid if accepted below support","invalidation_reason":"MODEL_REVERSAL_CONFIRMED",
        "feature_hash":"hash","latency_ms":{},"score_band":">=25%","mapping_effective_n":100.0,
    }
    values.update(changes);return ModelDecision(**values)


def test_ladder_fast_quote_patch_preserves_slow_context_and_expiration_rolls():
    service=_bare_service()
    service.contract_context_cache["OLD"]={"vanna":.2,"charm":-.1,"theta":-.3,"greek_context_time":datetime.now(timezone.utc).isoformat()}
    service.update_option_ladder([{"contract_key":"OLD","symbol":"SPY","expiration":"2026-09-09","strike":650,"bid":1,"ask":1.1}])
    service.patch_option_quote("OLD",{"bid":1.02,"ask":1.08,"quote_time":datetime.now(timezone.utc).isoformat()})
    assert service.ladder_cache["OLD"]["vanna"]==.2 and service.ladder_cache["OLD"]["charm"]==-.1
    service.update_option_ladder([{"contract_key":"NEW","symbol":"SPY","expiration":"2026-09-10","strike":651,"bid":1,"ask":1.1}])
    assert service.ladder_cache["OLD"]["active"] is False and service.ladder_cache["NEW"]["active"] is True


def test_selected_and_opposite_contracts_are_pinned_first():
    service=_bare_service();service.selected_contracts={"M":{"contract":"S"}}
    service.latest_side_evidence={"M":{"CALL":{"contract":"LC"},"PUT":{"contract":"LP"}}}
    service.best_sides={"M":{"CALL":{"contract":"C"},"PUT":{"contract":"P"}}}
    service.candidate_pool={"M":{"H":{"contract":"H","model_probability":.2}}}
    service.decisions={"M":type("D",(),{"candidate_contract":"S"})()}
    assert service.get_pinned_contracts()[:6]==["S","LC","LP","C","P","H"]


def test_valid_webull_quote_cannot_revive_invalidated_setup_episode():
    service=_bare_service();service.staleness={"webull_quote":5,"quant_option_event":90};service.provider_health={
        "QUANT_DATA":{"status":"LIVE"},"WEBULL":{"status":"LIVE"},
        "V2_STRUCTURE_SPY":{"status":"LIVE"}}
    service.quotes={};service.decisions={"SPY_OPTIONS_ONLY":_decision()}
    service.on_webull_quote("C",{"bid":1.01,"ask":1.02,"quote_time":datetime.now(timezone.utc).isoformat()})
    row=service.decisions["SPY_OPTIONS_ONLY"]
    assert row.thesis_state=="INVALIDATED" and row.state=="INVALIDATED"
    assert row.setup_episode_id=="episode-1" and row.aim_for_percent is None and row.direction=="CALL"


def test_stale_same_side_model_evidence_does_not_flip_between_blocked_and_stale():
    service=_bare_service();service.staleness={"webull_quote":5,"quant_option_event":90,
        "ninjatrader_futures":3,"quant_context":180,"v2_structure":5}
    now=datetime.now(timezone.utc);fresh=now.isoformat();old=(now-timedelta(seconds=95)).isoformat()
    service.provider_health={"QUANT_DATA":{"status":"LIVE"},"WEBULL":{"status":"LIVE"},
        "V2_STRUCTURE_SPY":{"status":"LIVE"}}
    service.provider_clocks={name:{"last_real_provider_event_time":fresh,"last_successful_request_time":fresh}
        for name in ("QUANT_DATA","WEBULL","V2_STRUCTURE_SPY")}
    service.quotes={};service.decisions={"SPY_OPTIONS_ONLY":_decision(
        state="LIVE",guidance_state="LIVE",thesis_state="LIVE",invalidation_reason=None,
        latest_same_side_event_time=old,model_event_time=old,latest_same_side_fresh=False,
        aim_for_percent=9,aim_for_percent_by_horizon={"10":5,"20":7,"30":9})}
    service.on_webull_quote("C",{"bid":1.01,"ask":1.02,"quote_time":fresh})
    row=service.decisions["SPY_OPTIONS_ONLY"]
    assert row.guidance_state==row.state=="STALE"
    assert row.invalidation_reason=="LATEST_SAME_SIDE_MODEL_EVIDENCE_STALE_OR_UNAVAILABLE"
    service.sweep_freshness(now+timedelta(milliseconds=100))
    assert row.guidance_state==row.state=="STALE"
    assert row.invalidation_reason=="LATEST_SAME_SIDE_MODEL_EVIDENCE_STALE_OR_UNAVAILABLE"


class _FrozenProbabilityFleet:
    versions={"SPY_OPTIONS_ONLY":"test-frozen"}
    def predict_surface(self, _model_id, vector):
        probability=float(vector["test_probability"])
        surface={f"p{target}_{horizon}":max(probability + (30-target)*.003 - (30-horizon)*.002, .001)
                 for horizon in (10,20,30) for target in (5,10,15,20,25,30)}
        display=surface_dict(project_surface(surface[key] for key in SURFACE_KEYS))
        return DirectMfePrediction(
            uncalibrated_probability_surface=dict(surface), raw_probability_surface=dict(surface),
            display_probability_surface=display,
            raw_aim_for_by_horizon=aim_for_by_horizon(surface, require_monotone=False),
            display_aim_for_percent_by_horizon=rounded_aim_for_by_horizon(display))


class _FixedLadder:
    ladder={.05:.80,.10:.65,.15:.52,.20:.42,.25:.35,.30:.28}
    def lookup(self, _model_id, _probability): return dict(self.ladder)
    def metadata(self, _model_id, probability):
        return {"score_band":f"test-{probability:.3f}","effective_n":100.0}


class _AlwaysActionableCalendar:
    VERSION="TEST_RTH"
    def actionable_y30(self, _event_time_ms): return True,"OK",object()


def _thesis_service(tmp_path):
    config=json.loads((REPO/"config/predictive_live/predictive_live_v1.example.json").read_text())
    service=PredictiveLiveService(_FrozenProbabilityFleet(),_FixedLadder(),None,_Sink(),_Sink(),
        config=config,live_root=tmp_path,calendar=_AlwaysActionableCalendar())
    now=datetime.now(timezone.utc);stamp=now.isoformat()
    for provider in ("QUANT_DATA","WEBULL"):
        service.update_provider_health(provider,status="LIVE",age_ms=0,event_time=stamp,receipt_time=stamp)
    structure={"source":"TRUSTED_DETERMINISTIC_V2_READ_ONLY","as_of":stamp,"age_ms":0,
        "structure_bias":"BULLISH","transition":False,"accepted_below":False,"accepted_above":False,
        "call_invalidation_level":650.0,"put_invalidation_level":655.0}
    service.update_structure_state("SPY",structure)
    return service,structure,int(now.timestamp()*1000)-5_000


def _emit_thesis_event(service, structure, event_time_ms, side, probability, contract=None, delta=.65):
    contract=contract or f"SPY_{side}_{event_time_ms}"
    quote_time=datetime.now(timezone.utc).isoformat()
    service.on_webull_quote(contract,{"bid":1.00,"ask":1.02,"quote_time":quote_time})
    event=OptionPrint("SPY",event_time_ms,contract,side,"ASK",102.0,1.0,delta,650.0,
        fields={"expiration":"2026-09-09","strikePrice":650.0},provider_id=str(event_time_ms))
    prepared=PreparedCadenceCandidate(event,0,event_time_ms//60_000,0,
        {"SPY_OPTIONS_ONLY":{"test_probability":probability,"contract_spread_rel":.0198}})
    rows=service.process_cadence_candidate(prepared,structure)
    assert len(rows)==1
    return rows[0]


def test_delta_052_candidate_receives_full_direct_mfe_decision_path(tmp_path):
    service,structure,base=_thesis_service(tmp_path)
    service.ladder_cache["CALL_052"]={"contract_key":"CALL_052","symbol":"SPY",
        "expiration":"2026-09-09","strike":650.0,"volume":1234}
    row=_emit_thesis_event(service,structure,base,"CALL",.28,"CALL_052",delta=.52)
    assert row.candidate_delta_band=="EXTENDED_49_55"
    assert row.grade=="A" and len(row.display_probability_surface)==18
    assert row.aim_for_percent_by_horizon is not None
    assert row.candidate_contract=="CALL_052"
    assert row.current_session_volume==1234
    assert "CURRENT_SESSION_VOLUME" in row.contract_selection_reason


def test_active_call_direction_is_sticky_when_stronger_put_arrives(tmp_path):
    service,structure,base=_thesis_service(tmp_path)
    first=_emit_thesis_event(service,structure,base,"CALL",.28,"CALL_A")
    switched=_emit_thesis_event(service,{**structure,"structure_bias":"BEARISH"},base+1_000,"PUT",.35,"PUT_A")
    assert first.direction==switched.direction=="CALL"
    assert switched.setup_episode_id==first.setup_episode_id
    assert switched.candidate_contract=="CALL_A"
    assert switched.latest_same_side_probability==pytest.approx(.28)
    assert switched.latest_opposite_side_probability==pytest.approx(.35)


def test_latest_same_side_evidence_drives_thesis_not_sticky_selection_score(tmp_path):
    service,structure,base=_thesis_service(tmp_path)
    first=_emit_thesis_event(service,structure,base,"CALL",.28,"CALL_A")
    current=_emit_thesis_event(service,structure,base+1_000,"CALL",.11,"CALL_A")
    assert current.setup_episode_id==first.setup_episode_id and current.candidate_contract=="CALL_A"
    assert current.selected_contract_probability_at_selection==pytest.approx(.28)
    assert current.probability==pytest.approx(.11)
    assert current.latest_same_side_probability==pytest.approx(.11)
    assert current.thesis_state=="WARNING"


def test_entry_ask_is_sticky_per_selected_contract_and_return_uses_current_bid(tmp_path):
    service,structure,base=_thesis_service(tmp_path)
    first=_emit_thesis_event(service,structure,base,"CALL",.28,"CALL_A")
    assert first.option_entry_price==pytest.approx(1.02)
    assert first.current_option_return==pytest.approx(1.00/1.02-1)
    entry_time=first.option_entry_time

    fresh=datetime.now(timezone.utc).isoformat()
    service.on_webull_quote("CALL_A",{"bid":1.12,"ask":1.14,"quote_time":fresh})
    marked=service.decisions["SPY_OPTIONS_ONLY"]
    assert marked.option_entry_price==pytest.approx(1.02)
    assert marked.option_entry_time==entry_time
    assert marked.current_option_return==pytest.approx(1.12/1.02-1)

    same=_emit_thesis_event(service,structure,base+1_000,"CALL",.30,"CALL_A")
    assert same.option_entry_price==pytest.approx(1.02)
    assert same.option_entry_time==entry_time


def test_entry_ask_resets_when_selected_contract_changes(tmp_path):
    service,structure,base=_thesis_service(tmp_path)
    first=_emit_thesis_event(service,structure,base,"CALL",.18,"CALL_A")
    service.on_webull_quote("CALL_B",{"bid":1.48,"ask":1.50,
        "quote_time":datetime.now(timezone.utc).isoformat()})
    event=OptionPrint("SPY",base+1_000,"CALL_B","CALL","ASK",150.0,1.0,.65,650.0,
        fields={"expiration":"2026-09-09","strikePrice":651.0},provider_id=str(base+1_000))
    prepared=PreparedCadenceCandidate(event,0,(base+1_000)//60_000,0,
        {"SPY_OPTIONS_ONLY":{"test_probability":.30,"contract_spread_rel":.0134}})
    changed=service.process_cadence_candidate(prepared,structure)[0]
    assert first.option_entry_price==pytest.approx(1.02)
    assert changed.candidate_contract=="CALL_B"
    assert changed.option_entry_price==pytest.approx(1.50)
    assert changed.current_option_return==pytest.approx(1.48/1.50-1)


def test_ungraded_candidate_does_not_create_a_setup_entry(tmp_path):
    service,structure,base=_thesis_service(tmp_path)
    row=_emit_thesis_event(service,structure,base,"CALL",.08,"CALL_UNGRADED")
    assert row.setup_episode_id is None and row.grade is None
    assert row.option_entry_price is None and row.option_entry_time is None
    assert row.current_option_return is None


def test_call_invalidates_before_new_put_episode_can_rearm(tmp_path):
    service,structure,base=_thesis_service(tmp_path)
    first=_emit_thesis_event(service,structure,base,"CALL",.28,"CALL_A")
    bearish={**structure,"structure_bias":"BEARISH"}
    opposite=_emit_thesis_event(service,bearish,base+1_000,"PUT",.20,"PUT_A")
    weak1=_emit_thesis_event(service,bearish,base+2_000,"CALL",.09,"CALL_A")
    invalid=_emit_thesis_event(service,bearish,base+3_000,"CALL",.08,"CALL_A")
    assert opposite.direction==weak1.direction==invalid.direction=="CALL"
    assert invalid.setup_episode_id==first.setup_episode_id
    assert invalid.thesis_state=="INVALIDATED" and invalid.invalidation_reason=="MODEL_REVERSAL_CONFIRMED"
    rearmed=_emit_thesis_event(service,bearish,base+4_000,"PUT",.22,"PUT_A")
    assert rearmed.direction=="PUT" and rearmed.thesis_state=="LIVE"
    assert rearmed.setup_episode_id!=first.setup_episode_id


def test_put_to_call_lifecycle_is_exactly_symmetric(tmp_path):
    service,structure,base=_thesis_service(tmp_path)
    bearish={**structure,"structure_bias":"BEARISH"}
    first=_emit_thesis_event(service,bearish,base,"PUT",.28,"PUT_A")
    opposite=_emit_thesis_event(service,{**structure,"structure_bias":"BULLISH"},base+1_000,"CALL",.20,"CALL_A")
    weak1=_emit_thesis_event(service,{**structure,"structure_bias":"BULLISH"},base+2_000,"PUT",.09,"PUT_A")
    invalid=_emit_thesis_event(service,{**structure,"structure_bias":"BULLISH"},base+3_000,"PUT",.08,"PUT_A")
    assert opposite.direction==weak1.direction==invalid.direction=="PUT"
    assert invalid.setup_episode_id==first.setup_episode_id and invalid.thesis_state=="INVALIDATED"
    rearmed=_emit_thesis_event(service,structure,base+4_000,"CALL",.22,"CALL_A")
    assert rearmed.direction=="CALL" and rearmed.setup_episode_id!=first.setup_episode_id


def test_aged_opposite_evidence_cannot_trigger_reversal(tmp_path):
    service,structure,base=_thesis_service(tmp_path)
    first=_emit_thesis_event(service,structure,base,"CALL",.28,"CALL_A")
    stale_event=first.latest_opposite_side_event_time
    old_ms=base-100_000
    _emit_thesis_event(service,{**structure,"structure_bias":"BEARISH"},old_ms,"PUT",.30,"PUT_OLD")
    # The chronologically older record is retained only as auditable, stale evidence.
    row1=_emit_thesis_event(service,{**structure,"structure_bias":"BEARISH"},base+1_000,"CALL",.09,"CALL_A")
    row2=_emit_thesis_event(service,{**structure,"structure_bias":"BEARISH"},base+2_000,"CALL",.08,"CALL_A")
    assert stale_event is None
    assert row2.latest_opposite_side_probability==pytest.approx(.30)
    assert row2.latest_opposite_side_fresh is False
    assert row1.thesis_state==row2.thesis_state=="WARNING"


def test_structure_freshness_sweep_blocks_and_recovers_without_candidate(tmp_path):
    service,structure,base=_thesis_service(tmp_path)
    decision=_emit_thesis_event(service,structure,base,"CALL",.28,"CALL_A")
    now=datetime.now(timezone.utc);future=now+timedelta(seconds=6)
    future_stamp=future.isoformat()
    for provider in ("QUANT_DATA","WEBULL"):
        service.provider_clocks[provider]["last_real_provider_event_time"]=future_stamp
    service.quotes["CALL_A"]["quote_time"]=future_stamp
    decision.latest_quote_time=future_stamp
    service.provider_clocks["V2_STRUCTURE_SPY"]["last_real_provider_event_time"]=now.isoformat()
    service.sweep_freshness(future)
    assert service.provider_health["V2_STRUCTURE_SPY"]["status"]=="STALE"
    assert decision.guidance_state=="STALE" and decision.aim_for_percent is None
    fresh={**structure,"as_of":future_stamp,"age_ms":0}
    service.update_structure_state("SPY",fresh)
    service.sweep_freshness(future+timedelta(milliseconds=100))
    assert decision.guidance_state=="LIVE" and decision.state=="LIVE"
    assert decision.aim_for_percent is not None


def test_fresh_structure_does_not_revive_invalidated_thesis(tmp_path):
    service,structure,base=_thesis_service(tmp_path)
    decision=_emit_thesis_event(service,structure,base,"CALL",.28,"CALL_A")
    machine=service.invalidations["SPY_OPTIONS_ONLY"]
    machine.state=ThesisState.INVALIDATED;machine.reason="MODEL_REVERSAL_CONFIRMED"
    decision.thesis_state="INVALIDATED";decision.state="INVALIDATED";decision.aim_for_percent=None
    now=datetime.now(timezone.utc);stamp=now.isoformat()
    service.update_structure_state("SPY",{**structure,"as_of":stamp,"age_ms":0})
    service.sweep_freshness(now)
    assert decision.thesis_state=="INVALIDATED" and decision.state=="INVALIDATED"
    assert decision.guidance_state=="BLOCKED" and decision.aim_for_percent is None


def test_freshness_sweep_advances_age_without_new_provider_event():
    service=_bare_service();service.staleness={"quant_option_event":1,"webull_quote":1,
        "ninjatrader_futures":1,"quant_context":1}
    old=(datetime.now(timezone.utc)-timedelta(seconds=2)).isoformat()
    service.provider_clocks={"QUANT_DATA":{"last_real_provider_event_time":old}}
    service.provider_health={"QUANT_DATA":{"status":"LIVE","age_ms":0}}
    service.decisions={};service.sweep_freshness(datetime.now(timezone.utc))
    assert service.provider_health["QUANT_DATA"]["status"]=="STALE"
    assert service.provider_health["QUANT_DATA"]["age_ms"]>=2000


def test_provider_exception_containment_allows_subsequent_work():
    health=[]
    runtime=object.__new__(PredictiveProviderRuntime)
    runtime.service=type("S",(),{"update_provider_health":lambda _self,*args,**kwargs:health.append((args,kwargs))})()
    for exc in (TimeoutError("timeout"),RuntimeError("HTTP"),ValueError("malformed")):
        runtime._safe("injected",lambda exc=exc:(_ for _ in ()).throw(exc),"WEBULL")
    marker=[];runtime._safe("next_provider",lambda:marker.append("alive"),"WEBULL")
    assert marker==["alive"] and len(health)==3


def test_runtime_market_context_and_invalidation_are_wired_to_real_state():
    context_source=inspect.getsource(PredictiveProviderRuntime._refresh_market_context)
    decision_source=inspect.getsource(PredictiveLiveService._decision_from_record)
    assert "context_summary" in context_source and "option_context_extra" in context_source
    assert "_structure_for" in inspect.getsource(PredictiveProviderRuntime._score_completed)
    assert "machine.update" in decision_source and "self._evidence" in decision_source
    assert "update_structure_state" in inspect.getsource(PredictiveProviderRuntime._poll_structure)
    assert 'option_context = {}' not in inspect.getsource(PredictiveProviderRuntime)


def test_web_uses_backend_calendar_ages_in_real_time_and_0dte_gex_only():
    html=(REPO/"predictive/index.html").read_text(encoding="utf-8")
    js=(REPO/"predictive/predictive.js").read_text(encoding="utf-8")
    assert "FRONT_EXPIRATIONS" not in html and "0DTE · provider exposure" in html
    assert "backendSession" in js and "currentAge" in js
    assert "weekday:" not in js and "minutes>=570" not in js
    assert all(name in html for name in ("Vanna","Charm","GEX"))


def test_options_dashboard_card_exposes_contract_quote_grade_and_direct_surface():
    html=(REPO/"predictive/index.html").read_text(encoding="utf-8")
    js=(REPO/"predictive/predictive.js").read_text(encoding="utf-8")
    assert "<title>Options Dashboard</title>" in html
    assert "OPTIONS DASHBOARD" in html
    assert all(token in js for token in (
        "ENTRY ASK", "CURRENT RETURN", "MODEL STRENGTH", "SETUP GRADE",
        "signal-detail-surface", "display_probability_surface",
        "aim_for_percent_by_horizon", "INVALID IF",
    ))
    assert all(token in js for token in ("[10,20,30]", "surfaceHorizons"))
    assert "display_probability_surface" in js and "aim_for_percent_by_horizon" in js
    assert "TargetLadder" not in js


def test_production_config_has_no_0dte_collection_and_uses_direct_contract():
    config=json.loads((REPO/"config/predictive_live/predictive_live_v1.example.json").read_text())
    assert config["model_contract"] == "DIRECT_MFE_MODELS_FROZEN_V2"
    assert config["surface_contract"] == SURFACE_CONTRACT
    assert config["artifact_registry"].endswith("artifact_registry_direct_mfe_v2.json")
    assert "0dte" not in json.dumps(config).lower()


def test_config_is_single_staleness_and_exact_context_source_of_truth():
    config=json.loads((REPO/"config/predictive_live/predictive_live_v1.example.json").read_text())
    context=config["quant_context_universe"]
    assert context["actual_dte"]==1 and "nearest listed exchange session" in context["actual_dte_definition"]
    assert context["minimum_abs_delta"]==.55 and context["maximum_abs_delta"]==.75
    assert context["trade_classifier"]=="QUANT_TRADETYPE_COMPLEX_TIED_V1"
    assert context["trade_classifier_sha256"]=="3d537d227ebd2198c99d230dff11b108f18e079570f759f07b2975ceada3296f"
    assert context["classification_source"]=="TRADE_TYPE"
    assert context["unknown_trade_type_policy"]=="AMBIGUOUS_NON_DIRECTIONAL"
    assert set(context["bad_trade_types"])==set(BAD_TRADE_TYPES)
    assert config["staleness_seconds"]=={"quant_option_event":90,"webull_quote":5,"ninjatrader_futures":3,"quant_context":180,"v2_structure":5}


def test_quant_live_request_is_server_narrowed_to_exact_context_universe():
    payload = QuantDataLiveClient._base_payload("SPY", "2026-09-09", 1000)
    assert payload["filter"] == {
        "ticker": "SPY",
        "expirationDates": ["2026-09-10"],
    }
    expression = payload["filterExpression"]
    assert expression["conjunction"] == "OR"
    bounds = [
        [(item["operation"], item["value"]) for item in branch["filters"]]
        for branch in expression["filters"]
    ]
    assert bounds == [
        [(">=", 0.49), ("<=", 0.75)],
        [(">=", -0.75), ("<=", -0.49)],
    ]


def test_proposed_migration_carries_separate_guidance_thesis_episode_and_active_ladder():
    sql=next((REPO/"supabase/migrations").glob("*predictive_live_v1_current_state.sql")).read_text()
    assert "guidance_state text" in sql and "thesis_state text" in sql and "setup_episode_id text" in sql
    assert "active boolean not null default true" in sql


def test_provider_health_contract_aligns_backend_frontend_and_migration():
    expected = {
        "QUANT_DATA", "QUANT_CONTEXT", "WEBULL", "NINJATRADER_ES", "NINJATRADER_NQ",
        "V2_STRUCTURE_SPY", "V2_STRUCTURE_QQQ", "SUPABASE", "MODEL_ARTIFACTS",
    }
    contract = json.loads((REPO / "config/predictive_live/provider_health_contract_v1.json").read_text())
    js = (REPO / "predictive/predictive.js").read_text(encoding="utf-8")
    frontend_match = re.search(r"const providerHealthIds\s*=\s*(\[[^;]+\]);", js)
    sql = next((REPO / "supabase/migrations").glob("*predictive_live_v1_current_state.sql")).read_text()
    migration_match = re.search(
        r"provider text primary key check \(provider in \((.*?)\)\)", sql, re.DOTALL
    )
    assert frontend_match and migration_match
    frontend = set(json.loads(frontend_match.group(1)))
    migration = set(re.findall(r"'([^']+)'", migration_match.group(1)))
    assert set(contract["provider_ids"]) == set(PROVIDER_HEALTH_IDS) == frontend == migration == expected


def test_provider_health_publisher_maps_context_and_structure_rows(monkeypatch):
    captured = []

    class Response:
        def __enter__(self): return self
        def __exit__(self, *_args): return False
        def read(self): return b""

    def fake_open(request, timeout):
        captured.append(json.loads(request.data)); return Response()

    monkeypatch.setattr("urllib.request.urlopen", fake_open)
    publisher = object.__new__(PredictiveCurrentStatePublisher)
    publisher.url = "https://example.invalid"; publisher.key = "backend-only"
    for provider in ("QUANT_CONTEXT", "V2_STRUCTURE_SPY", "V2_STRUCTURE_QQQ"):
        payload = {"provider": provider, "status": "LIVE", "age_ms": 25,
                   "detail": "contract test", "as_of": "2026-09-08T14:00:00+00:00"}
        publisher("predictive_provider_health_live", payload)
    assert [row["provider"] for row in captured] == [
        "QUANT_CONTEXT", "V2_STRUCTURE_SPY", "V2_STRUCTURE_QQQ"
    ]
    assert all(set(row) == {"provider", "status", "age_ms", "payload", "as_of", "updated_at"}
               for row in captured)
    assert all(row["payload"]["detail"] == "contract test" for row in captured)


def test_feature_and_prediction_parity_results_pass():
    option=json.loads((REPO/"audit/production_precommit/parity_results.json").read_text())
    futures=json.loads((REPO/"audit/production_precommit/futures_parity_results.json").read_text())
    assert option["status"]=="PASS" and futures["status"]=="PASS"
    assert all(row["mismatch_count"]==0 for row in option["option_feature_parity"]+futures["futures_feature_parity"])


def test_web_layout_and_realtime_contract():
    html=(REPO/"predictive/index.html").read_text(encoding="utf-8")
    js=(REPO/"predictive/predictive.js").read_text(encoding="utf-8")
    css=(REPO/"predictive/predictive.css").read_text(encoding="utf-8")
    signal_backend=(REPO/"backend/predictive_live/signal_episodes.py").read_text(encoding="utf-8")
    assert "model-grid" in html and "gex-grid" in html and "Option ladder" in html
    assert all(model in js for model in FrozenModelFleet.REQUIRED_MODELS)
    assert "V2_STRUCTURE_SPY" in js and "V2_STRUCTURE_QQQ" in js
    assert js.count('postgres_changes')==1 and "payload.new" in js
    assert "@media(max-width:430px)" in css and "grid-template-columns:1fr 1fr" in css
    assert "INVALID IF" in js and "DATA AGE" not in html  # invalidation is expanded per signal; ages stay in the card footer
    assert all(token in js for token in ("ENTRY ASK", "CURRENT RETURN", "entry_ask", "current_return"))
    assert "bid_value / entry_value - 1.0" in signal_backend


def test_web_0dte_horizontal_gex_and_combined_ladder_filters_are_explicit():
    html=(REPO/"predictive/index.html").read_text(encoding="utf-8")
    js=(REPO/"predictive/predictive.js").read_text(encoding="utf-8")
    assert 'scope: "0DTE"' in js
    assert "horizontal bars by descending strike" in js
    assert "GEX / 1% move" in js and "RTH baseline unavailable" in js
    assert all(token in html for token in (
        'id="deltaPreset"', 'id="deltaMin"', 'id="deltaMax"',
        'data-grade="A"', 'data-grade="UNGRADED"', 'id="ladderSort"',
        'id="selectedHiddenNotice"', 'id="resetLadderFilters"'))
    assert "ladderMatches" in js and "selectedHidden" in js


def test_proposed_migration_is_owner_only_and_not_applied_marker():
    path=next((REPO/"supabase/migrations").glob("*predictive_live_v1_current_state.sql"))
    sql=path.read_text(encoding="utf-8")
    assert sql.count("enable row level security")==5 and sql.count("updated_at timestamptz")==5
    assert "dashboard_readers" in sql and "grant select" in sql
    assert "service_role" not in (REPO/"predictive/predictive-config.js").read_text(encoding="utf-8").lower()


def test_supabase_publisher_wraps_variable_payloads_in_fixed_table_shapes(monkeypatch):
    captured=[]
    class Response:
        def __enter__(self): return self
        def __exit__(self,*_args): return False
        def read(self): return b""
    def fake_open(request,timeout):
        captured.append(json.loads(request.data)); return Response()
    monkeypatch.setattr("urllib.request.urlopen",fake_open)
    publisher=object.__new__(PredictiveCurrentStatePublisher);publisher.url="https://example.invalid";publisher.key="backend-only"
    publisher("predictive_market_context_live",{"symbol":"SPY","gamma_regime":"POSITIVE GAMMA","market_condition":"BULLISH","reasons":["support"],"as_of":"2026-09-08T14:00:00+00:00"})
    publisher("predictive_gex_surface_live",{"symbol":"SPY","surface_kind":"CURRENT","scope":"FULL_CHAIN","points":[],"as_of":"2026-09-08T14:00:00+00:00"})
    assert set(captured[0])=={"symbol","gamma_regime","market_condition","payload","as_of","updated_at"}
    assert set(captured[1])=={"symbol","surface_kind","scope","payload","as_of","updated_at"}
