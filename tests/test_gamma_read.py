from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "backend"))

from predictive_live.gamma_read import ALLOWED_REGIMES, CONTRACT, build_gamma_read
from predictive_live.gex import GexSessionState
from predictive_live.service import PredictiveLiveService


NOW = datetime(2026, 9, 10, 15, 0, tzinfo=timezone.utc)


def read(current, delta, spot=100.1, *, current_age=0, delta_age=0, spot_age=0):
    return build_gamma_read(
        current, delta, spot,
        current_as_of=NOW - timedelta(seconds=current_age),
        delta_as_of=NOW - timedelta(seconds=delta_age),
        spot_as_of=NOW - timedelta(seconds=spot_age),
        now=NOW, scope="0DTE", gex_stale_seconds=180, spot_stale_seconds=5,
    )


def test_strong_positive_concentration_near_spot_is_stabilizing_or_pinned():
    result = read({98: 1, 99: 2, 100: 20, 101: 4, 102: 2},
                  {98: 0, 99: 1, 100: 5, 101: 1, 102: 0})
    assert result["regime"] in {"PINNED", "STABILIZING", "STABILIZING / PINNED"}
    assert result["tone"] == "positive"


def test_opposite_sign_concentrations_around_spot_form_gamma_boundary():
    result = read({98: -1, 99: -2, 100: -14, 101: 13, 102: 3},
                  {98: 0, 99: -1, 100: -2, 101: 3, 102: 1}, spot=100.5)
    assert result["regime"] == "GAMMA BOUNDARY"
    assert result["key_zone"] == "100–101"


def test_nearby_negative_structure_classifies_negative_gamma():
    result = read({98: 3, 99: -4, 100: -7, 101: -5, 102: 2},
                  {98: 1, 99: 0, 100: 1, 101: 0, 102: 0})
    assert result["regime"] == "NEGATIVE GAMMA"


def test_extreme_nearby_negative_structure_classifies_acceleration_risk():
    result = read({98: 1, 99: -3, 100: -25, 101: -8, 102: 1},
                  {98: 0, 99: -1, 100: -9, 101: -3, 102: 0})
    assert result["regime"] == "ACCELERATION RISK"


def test_weak_conflicting_structure_is_mixed():
    result = read({97: 1, 98: -1, 99: 1, 100: -1, 101: 1, 102: -1, 103: 1},
                  {97: -1, 98: 1, 99: -1, 100: 1, 101: -1, 102: 1, 103: -1})
    assert result["regime"] == "MIXED"


def test_current_negative_delta_positive_preserves_current_sign_distinction():
    result = read({98: 2, 99: -3, 100: -8, 101: -3, 102: 2},
                  {98: 0, 99: 1, 100: 6, 101: 2, 102: 0})
    assert result["nearest_current_sign"] == "NEGATIVE"
    assert result["nearest_delta_sign"] == "POSITIVE"
    assert "remains negative" in result["current_vs_delta_read"]
    assert result.get("strongest_positive_current", {}).get("strike") != 100


def test_nearby_material_level_wins_over_irrelevant_far_away_maximum():
    result = read({80: 1000, 98: -2, 99: 3, 100: 5, 101: 12, 102: 2},
                  {80: 500, 98: 0, 99: 1, 100: 1, 101: 3, 102: 0})
    assert 80 not in result["local_strikes"]
    assert result["above"]["strike"] == 101


def test_strikes_are_numeric_and_sorted():
    result = read({"101": 2, "99": -1, "100": 7, "102": 1},
                  {"102": 0, "99": 0, "101": 1, "100": 2})
    assert result["local_strikes"] == sorted(result["local_strikes"])
    assert all(isinstance(value, float) for value in result["local_strikes"])


def test_stale_gex_fails_closed():
    result = read({99: 1, 100: 5, 101: 2}, {99: 0, 100: 1, 101: 0}, current_age=181)
    assert result["regime"] == "DATA STALE"
    assert result["stale_reason"] == "CURRENT_GEX_STALE"


def test_stale_spot_fails_closed():
    result = read({99: 1, 100: 5, 101: 2}, {99: 0, 100: 1, 101: 0}, spot_age=6)
    assert result["regime"] == "DATA STALE"
    assert result["stale_reason"] == "SPOT_STALE"


def test_gamma_read_never_emits_directional_trade_or_market_labels():
    result = read({98: -1, 99: -2, 100: -14, 101: 13, 102: 3},
                  {98: 0, 99: -1, 100: -2, 101: 3, 102: 1}, spot=100.5)
    def string_values(value):
        if isinstance(value, dict):
            for child in value.values():
                yield from string_values(child)
        elif isinstance(value, list):
            for child in value:
                yield from string_values(child)
        elif isinstance(value, str):
            yield value.upper()
    payload = " ".join(string_values(result))
    assert result["contract"] == CONTRACT
    assert result["regime"] in ALLOWED_REGIMES
    assert "CALL" not in payload
    assert "PUT" not in payload
    assert "BULLISH" not in payload
    assert "BEARISH" not in payload


def test_frontend_replaces_old_market_map_and_ages_gamma_read_live():
    html = (REPO / "predictive" / "index.html").read_text(encoding="utf-8")
    js = (REPO / "predictive" / "predictive.js").read_text(encoding="utf-8")
    assert "Gamma Read" in html
    assert "0DTE positioning around spot" in html
    assert "Context before conviction." not in html
    assert 'id="gammaReadGrid"' in html
    assert "function effectiveGammaRead" in js
    assert "renderGammaRead();renderLadder()" in js
    assert "BROWSER_SOURCE_AGE_EXCEEDED" in js
    assert "read.gex_stale_after_ms" in js
    assert "read.spot_stale_after_ms" in js


def test_market_context_publishes_backend_authoritative_gamma_read():
    class Sink:
        def __init__(self):
            self.rows = []

        def submit(self, *args):
            self.rows.append(args)

    class Calendar:
        @staticmethod
        def market_state(_now):
            return {"state": "OPEN"}

    now = datetime.now(timezone.utc)
    gex = GexSessionState()
    gex.scope = "0DTE"
    gex.current = {99.0: -2.0, 100.0: 15.0, 101.0: 3.0}
    gex.baseline = {99.0: -1.0, 100.0: 10.0, 101.0: 3.0}
    gex.current_time = now
    gex.baseline_time = now - timedelta(hours=1)
    service = PredictiveLiveService.__new__(PredictiveLiveService)
    service.gex = {"SPY": gex}
    service.latest_underlying = {"SPY": 100.05}
    service.latest_underlying_time = {"SPY": now.isoformat()}
    service.latest_underlying_source = {"SPY": "WEBULL_CASH"}
    service.staleness = {"quant_context": 180, "webull_quote": 5}
    service.market_context = {}
    service.recorder, service.publisher = Sink(), Sink()
    service.calendar = Calendar()
    payload = service.update_market_context(
        "SPY", option_context={}, structure={}, as_of=now.isoformat())
    assert payload["gamma_read"]["contract"] == CONTRACT
    assert payload["gamma_read"]["scope"] == "0DTE"
    assert payload["spot_source"] == "WEBULL_CASH"
    assert payload["gamma_read"]["spot_stale_after_ms"] == 5000
    assert payload["gamma_read"]["gex_stale_after_ms"] == 180000
    assert service.publisher.rows[0][0] == "predictive_market_context_live"


def test_gamma_read_uses_fresh_gex_spot_when_cash_timestamp_ages_out():
    class Sink:
        def submit(self, *args):
            pass

    class Calendar:
        @staticmethod
        def market_state(_now):
            return {"state": "OPEN"}

    now = datetime.now(timezone.utc)
    gex = GexSessionState()
    gex.scope = "0DTE"
    gex.current = {99.0: -2.0, 100.0: 15.0, 101.0: 3.0}
    gex.baseline = {99.0: -1.0, 100.0: 10.0, 101.0: 3.0}
    gex.current_time = now - timedelta(seconds=20)
    gex.baseline_time = now - timedelta(hours=1)
    service = PredictiveLiveService.__new__(PredictiveLiveService)
    service.gex = {"SPY": gex}
    service.latest_underlying = {"SPY": 99.9}
    service.latest_underlying_time = {"SPY": (now - timedelta(seconds=8)).isoformat()}
    service.latest_underlying_source = {"SPY": "WEBULL_CASH"}
    service.latest_gex_spot = {"SPY": 100.1}
    service.latest_gex_spot_time = {"SPY": (now - timedelta(seconds=20)).isoformat()}
    service.staleness = {"quant_context": 180, "quant_option_event": 90, "webull_quote": 5}
    service.market_context = {}
    service.recorder, service.publisher = Sink(), Sink()
    service.calendar = Calendar()

    payload = service.update_market_context(
        "SPY", option_context={}, structure={}, as_of=now.isoformat())

    read = payload["gamma_read"]
    assert payload["spot_source"] == "QUANT_GEX_SPOT"
    assert read["spot"] == 100.1
    assert read["regime"] != "DATA STALE"
    assert read["spot_stale_after_ms"] == 180000
