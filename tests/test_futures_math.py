from __future__ import annotations

import math

from backend.v2.futures import DecayedFlow, normalized_payload
from backend.v2.math_utils import clamp, harmonic_mean, safe_ratio


def args(buy: float, sell: float) -> dict:
    return dict(
        now=1.0, dt=0.1, buy_volume=buy, sell_volume=sell,
        bids=[(100.0, 10.0)], asks=[(100.25, 10.0)],
        bid=100.0, ask=100.25, bid_size=10.0, ask_size=10.0,
        large_buy_volume=buy, large_sell_volume=sell,
        normalized_price_response=0.2 if buy >= sell else -0.2,
        bid_replenishment=0.3, ask_replenishment=0.3, activity=1.0,
    )


def test_nan_signed_feature_fails_neutral() -> None:
    assert clamp(float("nan"), -1.0, 1.0) == 0.0
    assert clamp(float("nan"), 0.0, 1.0) == 0.0


def test_zero_denominators_no_nan() -> None:
    assert safe_ratio(0.0, 0.0) == 0.0
    result = DecayedFlow().update(**args(0.0, 0.0))
    for key, value in result.items():
        if key != "microprice":
            assert math.isfinite(value), key


def test_all_features_are_bounded() -> None:
    result = DecayedFlow().update(**args(1000.0, 1.0))
    for key in ("f_fast", "f_slow", "aggression", "depth_imbalance", "microprice_edge", "book",
                "large_trade_direction", "absorption", "normalized_price_response", "execution_response", "futures_flow_evidence"):
        assert -1.0 <= result[key] <= 1.0
    for key in ("bid_replenishment", "ask_replenishment", "flow_persistence", "flow_active_fraction"):
        assert 0.0 <= result[key] <= 1.0


def test_decayed_numerator_and_denominator_are_separate() -> None:
    flow = DecayedFlow()
    flow.update(**args(100.0, 0.0))
    before = (flow.n_fast, flow.d_fast)
    flow.update(**{**args(0.0, 0.0), "now": 1.1})
    assert flow.n_fast < before[0]
    assert flow.d_fast < before[1]
    assert math.isclose(flow.n_fast / flow.d_fast, before[0] / before[1], rel_tol=1e-12)


def test_stronger_same_direction_aggression_not_lower() -> None:
    weak = DecayedFlow().update(**args(60.0, 40.0))["aggression"]
    strong = DecayedFlow().update(**args(90.0, 10.0))["aggression"]
    assert strong >= weak


def test_call_put_mirror_is_symmetric() -> None:
    bullish = DecayedFlow().update(**args(90.0, 10.0))
    bearish = DecayedFlow().update(**args(10.0, 90.0))
    assert math.isclose(bullish["aggression"], -bearish["aggression"], abs_tol=1e-12)
    assert math.isclose(bullish["large_trade_direction"], -bearish["large_trade_direction"], abs_tol=1e-12)


def test_normalizer_removes_nan_inf() -> None:
    result = normalized_payload({"aggression": float("inf"), "flow_persistence": float("nan")})
    assert result["aggression"] == 0.0
    assert result["flow_persistence"] == 0.0


def test_harmonic_mean_is_non_compensatory() -> None:
    assert harmonic_mean([1.0, 1.0, 0.0]) == 0.0
