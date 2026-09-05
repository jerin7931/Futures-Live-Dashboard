from __future__ import annotations

from datetime import datetime, timezone

from backend.v2.engine import MarketEngine
from backend.v2.models import Candidate, QuoteState
from backend.v2.options import QuoteHysteresis
from backend.v2.pricing import SECONDS_PER_YEAR, bsm_greeks
from backend.v2.providers.quantdata import ProviderResult, option_flow_evidence
from backend.v2.providers.runtime import build_candidates, cash_snapshot_map
from backend.v2.providers.webull import WebullResult


def webull_result(data):
    return WebullResult(data, "2026-09-08T15:00:00+00:00", "2026-09-08T15:00:00+00:00", 1.0, "LIVE")


def test_cash_snapshot_prefers_regular_price_and_keeps_volume():
    mapped = cash_snapshot_map(webull_result([{
        "symbol": "SPY", "price": "770", "extend_hour_last_price": "771",
        "volume": "12345", "bid": "769.99", "ask": "770.01",
        "quote_time": 1788879600000,
    }]))
    assert mapped["SPY"]["price"] == 770.0
    assert mapped["SPY"]["day_volume"] == 12345.0


def test_quant_side_codes_follow_ask_bid_semantics():
    rows = [
        {"tradeTime": 1000000, "contractType": "CALL", "tradeSideCode": "AA", "size": 10, "greeks": {"delta": .6}},
        {"tradeTime": 1000000, "contractType": "PUT", "tradeSideCode": "B", "size": 10, "greeks": {"delta": -.6}},
    ]
    assert option_flow_evidence(rows)["evidence"] == 1.0
    mirrored = [{**row, "tradeSideCode": "BB" if row["contractType"] == "CALL" else "A"} for row in rows]
    assert option_flow_evidence(mirrored)["evidence"] == -1.0


def test_quote_hysteresis_keeps_one_wide_snapshot_degraded_not_invalid():
    state = QuoteHysteresis().update(now=0.0, hard_invalid=False, wide=True, degraded_seconds=1.0, invalid_seconds=2.0)
    assert state == QuoteState.DEGRADED


def test_candidate_builder_ignores_quotes_outside_contract_set():
    contracts = webull_result([{"symbol": "SPY260909C00765000", "strike_price": "765", "option_type": "CALL"}])
    quotes = webull_result([
        {"symbol": "SPY260909C00765000", "strike_price": "765", "bid": "6", "ask": "6.1", "delta": ".65", "gamma": ".02", "imp_vol": ".2", "quote_time": 1788879600000},
        {"symbol": "QQQ260909C00500000", "strike_price": "500", "bid": "6", "ask": "6.1", "delta": ".65", "gamma": ".02", "imp_vol": ".2", "quote_time": 1788879600000},
    ])
    assert [row.option_symbol for row in build_candidates("SPY", "2026-09-09", contracts, quotes, None, 770.0)] == ["SPY260909C00765000"]


def test_candidate_builder_ages_quant_greeks_from_receipt_when_event_time_missing():
    contracts = webull_result([{"symbol": "SPY260909C00765000", "strike_price": "765", "option_type": "CALL"}])
    quotes = webull_result([{"symbol": "SPY260909C00765000", "strike_price": "765", "bid": "6", "ask": "6.1", "gamma": ".02", "quote_time": 1788879600000}])
    surface = ProviderResult(
        data={"data": {"2026-09-09": {"765": {"CALL": {"delta": .65, "iv": .20}}}}},
        provider_event_time=None,
        local_receive_time="2026-09-08T14:59:30+00:00",
        latency_ms=5.0,
        status="LIVE",
    )
    built = build_candidates("SPY", "2026-09-09", contracts, quotes, surface, 770.0)
    assert built[0].greeks_time == surface.local_receive_time


def test_full_engine_reaches_executable_ready_with_current_quote():
    engine = MarketEngine("SPY_1DTE")
    now = datetime(2026, 9, 8, 15, 0, tzinfo=timezone.utc)
    seconds = (datetime(2026, 9, 9, 20, 15, tzinfo=timezone.utc) - now).total_seconds()
    strike = 766.0
    delta, gamma = bsm_greeks("CALL", 770.0, strike, seconds / SECONDS_PER_YEAR, .04, .012, .20)
    assert .60 <= delta <= .70
    candidate = Candidate(
        symbol="SPY", expiration="2026-09-09", option_type="CALL", strike=strike,
        option_symbol="SPY260909C00766000", bid=8.00, ask=8.10, last=8.05,
        bid_size=20, ask_size=20, volume=5000, open_interest=25000,
        delta=delta, gamma=gamma, iv=.20, quote_time=now.isoformat(),
        greeks_time=now.isoformat(), spot_at_greeks=770.0,
    )
    futures = {
        "contract": "ES 09-26", "provider_event_time": now.isoformat(), "local_receive_time": now.isoformat(),
        "futures_flow_evidence": .90, "flow_persistence": .85, "flow_active_fraction": .90,
        "flow_sign_duration": 3.0, "aggression": .85, "book": .75, "execution_response": .80,
        "absorption": .30, "bid_replenishment": .70, "ask_replenishment": .05, "last": 6500,
    }
    cash = {"price": 770.0, "bid": 769.99, "ask": 770.01, "bid_size": 100, "ask_size": 100,
            "provider_event_time": now.isoformat(), "local_receive_time": now.isoformat()}
    result = None
    for index in range(20):
        result = engine.evaluate(
            now_monotonic=index * .1, now_utc=now, futures_payload=futures, cash_payload=cash,
            cash_depth={}, option_candidates=[candidate], expiration="2026-09-09",
            quant_status="LIVE", webull_status="LIVE", market_open_override=True,
        )
    assert result is not None
    assert result["state"] == "CALL_READY"
    assert result["display_state"] == "READY EXECUTABLE"
    assert result["option"]["entry_basis"] == "CURRENT_WEBULL_ASK"
    assert result["option"]["target_option_price"] == 10.53
    assert result["setup_quality_is_probability"] is False
