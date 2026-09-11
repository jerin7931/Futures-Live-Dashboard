from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "backend"))

from predictive_live.gamma_read_v2 import ALLOWED_REGIMES, CONTRACT, GammaReadEngine


NOW = datetime(2026, 9, 10, 16, 0, tzinfo=timezone.utc)


def update(engine, current, delta, spot=100.1, *, minute=0, now=None):
    stamp = now or (NOW + timedelta(minutes=minute))
    return engine.update(
        current, delta, spot, current_as_of=stamp, delta_as_of=stamp,
        spot_as_of=stamp, now=stamp, scope="0DTE",
    )


def row(read, strike):
    return next(item for item in read["rich_state"]["per_strike"] if item["strike"] == strike)


@pytest.mark.parametrize(
    "current,delta,expected_evolution,expected_reason",
    [
        ({99: 4, 100: 12, 101: 3}, {99: 1, 100: 8, 101: 1}, "STRENGTHENING", "POSITIVE_GEX_STRENGTHENING"),
        ({99: 4, 100: 12, 101: 3}, {99: 1, 100: -8, 101: 1}, "SIGN_FLIP_RISK", "POSITIVE_GEX_WEAKENING"),
        ({99: 10, 100: .05, 101: -8}, {99: 1, 100: 12, 101: -1}, "FORMING_POSITIVE", "NEW_POSITIVE_STRUCTURE_FORMING"),
        ({99: 10, 100: -.05, 101: -8}, {99: 1, 100: -12, 101: -1}, "FORMING_NEGATIVE", "NEW_NEGATIVE_STRUCTURE_FORMING"),
        ({99: 4, 100: -12, 101: 3}, {99: 1, 100: -8, 101: 1}, "STRENGTHENING", "NEGATIVE_GEX_STRENGTHENING"),
        ({99: 4, 100: -12, 101: 3}, {99: 1, 100: 8, 101: 1}, "SIGN_FLIP_RISK", "NEGATIVE_GEX_WEAKENING"),
    ],
)
def test_current_and_delta_interpretation_matrix(current, delta, expected_evolution, expected_reason):
    read = update(GammaReadEngine("SPY"), current, delta)
    state = row(read, 100.0)
    assert state["evolution"] == expected_evolution
    assert state["evolution_reason"] == expected_reason


def test_negative_current_with_large_positive_delta_is_not_relabelled_positive():
    read = update(GammaReadEngine("SPY"), {99: 5, 100: -20, 101: 4}, {99: 1, 100: 25, 101: 1})
    state = row(read, 100.0)
    assert state["current_class"].endswith("NEGATIVE")
    assert state["delta_class"] == "STRONGLY_POSITIVE_CHANGE"
    assert state["evolution"] == "SIGN_FLIP_RISK"
    assert read["nearest_current_sign"] == "NEGATIVE"
    assert "remains negative" in read["current_vs_delta_read"]


def test_unsettled_weakening_structure_compresses_to_transition():
    read = update(
        GammaReadEngine("SPY"),
        {98: 3, 99: 5, 100: 15, 101: 6, 102: 2},
        {98: 0, 99: -1, 100: -20, 101: -3, 102: 0},
        101.7,
    )
    assert read["regime"] == "TRANSITION"
    assert read["tone"] == "caution"
    assert "transitioning" in read["read"].lower()


@pytest.mark.parametrize(
    "current,delta,spot,expected",
    [
        ({98: -1, 99: 3, 100: 30, 101: 5, 102: -1}, {98: 0, 99: 1, 100: 8, 101: 2, 102: 0}, 100.05,
         {"STABILIZING", "PINNED", "STABILIZING / PINNED"}),
        ({99: -20, 100: -14, 101: .01, 102: 18, 103: 10}, {99: -3, 100: -2, 101: 0, 102: 3, 103: 2}, 101.2,
         {"GAMMA BOUNDARY"}),
        ({98: 18, 99: 10, 100: -18, 101: -6, 102: 6}, {98: 0, 99: 0, 100: 5, 101: 1, 102: 0}, 100.2,
         {"NEGATIVE GAMMA", "TRANSITION", "GAMMA BOUNDARY"}),
        ({98: 1, 99: -10, 100: -35, 101: -16, 102: 1}, {98: 0, 99: -3, 100: -12, 101: -5, 102: 0}, 100.1,
         {"ACCELERATION RISK"}),
        ({98: 4, 99: -4, 100: 3, 101: -3, 102: 4}, {98: 1, 99: -1, 100: -1, 101: 1, 102: 0}, 100.4,
         {"MIXED", "GAMMA BOUNDARY"}),
    ],
)
def test_primary_regime_matrix(current, delta, spot, expected):
    read = update(GammaReadEngine("SPY"), current, delta, spot)
    assert read["regime"] in expected


def test_spot_location_recomputes_regime_and_level_semantics():
    current = {758: 4, 759: 18, 760: -20, 761: 7, 762: 6}
    delta = {758: 1, 759: 4, 760: 6, 761: 2, 762: 2}
    reads = [update(GammaReadEngine("SPY"), current, delta, spot, minute=index)
             for index, spot in enumerate((758.8, 759.7, 760.2, 761.4))]
    assert reads[0]["regime"] in {"PINNED", "STABILIZING", "STABILIZING / PINNED", "GAMMA BOUNDARY"}
    assert reads[1]["regime"] == "GAMMA BOUNDARY"
    assert reads[2]["regime"] in {"NEGATIVE GAMMA", "ACCELERATION RISK", "GAMMA BOUNDARY", "TRANSITION"}
    assert reads[3]["regime"] in {"STABILIZING", "STABILIZING / PINNED", "GAMMA BOUNDARY", "TRANSITION"}
    assert len({(item["key_zone"], json.dumps(item["above"], sort_keys=True), json.dumps(item["below"], sort_keys=True)) for item in reads}) >= 3


def test_adjacent_clusters_are_numeric_and_nearby_cluster_outranks_far_maximum():
    read = update(
        GammaReadEngine("QQQ"),
        {90: 500, 98: 12, 99: 14, 100: 16, 101: -9, 102: -8},
        {90: 10, 98: 2, 99: 2, 100: 3, 101: -2, 102: -2},
        99.4,
    )
    zones = read["rich_state"]["zones"]
    positive = read["rich_state"]["strongest_positive_zone"]
    negative = read["rich_state"]["strongest_negative_zone"]
    assert [item["strike"] for item in read["rich_state"]["per_strike"]] == sorted(item["strike"] for item in read["rich_state"]["per_strike"])
    assert positive["lower_strike"] == 98 and positive["upper_strike"] == 100
    assert negative["lower_strike"] == 101 and negative["upper_strike"] == 102
    assert all(zone["lower_strike"] <= zone["upper_strike"] for zone in zones)


def test_sign_flip_is_recorded_and_can_trigger_transition():
    engine = GammaReadEngine("SPY")
    update(engine, {99: 5, 100: -12, 101: 4}, {99: 1, 100: 1, 101: 1}, minute=0)
    update(engine, {99: 5, 100: 0, 101: 4}, {99: 1, 100: 10, 101: 1}, minute=1)
    read = update(engine, {99: 5, 100: 12, 101: 4}, {99: 1, 100: 12, 101: 1}, minute=2)
    assert any(event["code"] == "POSITIVE_SIGN_FLIP" and event["strike"] == 100 for event in read["rich_state"]["sign_flip_events"])
    assert "POSITIVE_SIGN_FLIP" in read["rich_state"]["regime_reason_codes"]
    assert read["regime"] in ALLOWED_REGIMES


def test_reverse_sign_flip_is_recorded():
    engine = GammaReadEngine("SPY")
    update(engine, {99: 4, 100: 12, 101: 5}, {99: 1, 100: -1, 101: 1}, minute=0)
    update(engine, {99: 4, 100: 0, 101: 5}, {99: 1, 100: -9, 101: 1}, minute=1)
    read = update(engine, {99: 4, 100: -12, 101: 5}, {99: 1, 100: -12, 101: 1}, minute=2)
    assert any(event["code"] == "NEGATIVE_SIGN_FLIP" for event in read["rich_state"]["sign_flip_events"])


def test_dominant_concentration_migration_requires_persistence():
    engine = GammaReadEngine("SPY")
    base_delta = {758: 1, 759: 2, 760: 2, 761: 2, 762: -1}
    update(engine, {758: 3, 759: 20, 760: 5, 761: 4, 762: -6}, base_delta, 759.4, minute=0)
    first = update(engine, {758: 3, 759: 5, 760: 20, 761: 4, 762: -6}, base_delta, 759.4, minute=1)
    assert first["rich_state"]["dominant_positive_migration"] is None
    confirmed = update(engine, {758: 3, 759: 5, 760: 20, 761: 4, 762: -6}, base_delta, 759.4, minute=2)
    assert confirmed["rich_state"]["dominant_positive_migration"] == "POSITIVE_ZONE_MIGRATING_UP"
    update(engine, {758: 3, 759: 4, 760: 5, 761: 22, 762: -6}, base_delta, 760.4, minute=3)
    confirmed2 = update(engine, {758: 3, 759: 4, 760: 5, 761: 22, 762: -6}, base_delta, 760.4, minute=4)
    assert confirmed2["rich_state"]["dominant_positive_migration"] == "POSITIVE_ZONE_MIGRATING_UP"


def test_negative_and_boundary_migration_require_persistence():
    engine = GammaReadEngine("QQQ")
    update(engine, {709: -18, 710: -15, 711: 0, 712: 18, 713: 8}, {709: -2, 710: -2, 711: 0, 712: 2, 713: 1}, 711, minute=0)
    moved = {709: -4, 710: -8, 711: -20, 712: 0, 713: 20, 714: 8}
    moved_delta = {709: 1, 710: -1, 711: -4, 712: 0, 713: 4, 714: 1}
    update(engine, moved, moved_delta, 712, minute=1)
    read = update(engine, moved, moved_delta, 712, minute=2)
    assert read["rich_state"]["dominant_negative_migration"] == "NEGATIVE_ZONE_MIGRATING_UP"
    assert read["rich_state"]["boundary_migration"] == "BOUNDARY_MIGRATING_UP"


def test_pin_migration_requires_persistence():
    engine = GammaReadEngine("SPY")
    delta = {758: 1, 759: 2, 760: 2, 761: -1}
    update(engine, {758: 3, 759: 20, 760: 5, 761: -5}, delta, 759.1, minute=0)
    moved = {758: 3, 759: 5, 760: 22, 761: -5}
    update(engine, moved, delta, 759.7, minute=1)
    read = update(engine, moved, delta, 759.7, minute=2)
    assert read["rich_state"]["pin_migration"] == "PIN_MIGRATING_UP"


def test_hysteresis_holds_noise_but_material_near_spot_flip_updates_promptly():
    engine = GammaReadEngine("SPY")
    positive = {99: 6, 100: 20, 101: 5}
    negative_noise = {99: 6, 100: -7, 101: 5}
    regimes = [update(engine, positive, {99: 1, 100: 2, 101: 1}, minute=0)["regime"]]
    regimes.append(update(engine, negative_noise, {99: 1, 100: -1, 101: 1}, minute=1)["regime"])
    regimes.append(update(engine, positive, {99: 1, 100: 2, 101: 1}, minute=2)["regime"])
    assert len(set(regimes)) <= 2
    flipped = update(engine, {99: 3, 100: -30, 101: 2}, {99: 0, 100: -20, 101: 0}, minute=3)
    assert "NEGATIVE_SIGN_FLIP" in flipped["rich_state"]["regime_reason_codes"]
    assert flipped["regime"] in {"NEGATIVE GAMMA", "ACCELERATION RISK", "GAMMA BOUNDARY", "TRANSITION"}


def test_stale_input_preserves_last_valid_read_without_new_confident_state():
    engine = GammaReadEngine("SPY")
    live = update(engine, {99: 4, 100: 18, 101: -5}, {99: 1, 100: 4, 101: -1})
    stale_now = NOW + timedelta(minutes=10)
    stale = engine.update(
        {99: 4, 100: -18, 101: -5}, {99: 1, 100: -4, 101: -1}, 100.1,
        current_as_of=NOW, delta_as_of=NOW, spot_as_of=NOW,
        now=stale_now, gex_stale_seconds=60, spot_stale_seconds=5, scope="0DTE",
    )
    assert stale["regime"] == "DATA STALE"
    assert stale["last_valid_read"]["regime"] == live["regime"]
    assert engine.state["previous_current"]["100.0"] == 18


def test_restart_restores_same_session_state_and_new_session_resets(tmp_path):
    path = tmp_path / "gamma_state.json"
    engine = GammaReadEngine("SPY", path)
    first = update(engine, {99: 4, 100: 18, 101: -5}, {99: 1, 100: 4, 101: -1})
    assert path.is_file()
    restored = GammaReadEngine("SPY", path)
    assert restored.state["stable_regime"] == first["regime"]
    next_day = NOW + timedelta(days=1)
    update(restored, {99: -5, 100: -18, 101: 4}, {99: -1, 100: -4, 101: 1}, now=next_day)
    assert restored.state["session_date"] != engine.state["session_date"]
    assert restored.state["previous_spot"] == 100.1


def test_output_is_backward_compatible_and_never_directional():
    read = update(GammaReadEngine("SPY"), {99: -5, 100: 18, 101: 4}, {99: -1, 100: 3, 101: 1})
    assert read["contract"] == CONTRACT
    assert read["engine_version"] == "GAMMA_READ_INTERPRETATION_ENGINE_V2"
    assert {"regime", "key_zone", "above", "below", "callouts", "read", "rich_state"} <= read.keys()
    serialized = json.dumps(read).upper()
    assert '"DIRECTION"' not in serialized
    assert "BUY CALL" not in serialized and "BUY PUT" not in serialized
