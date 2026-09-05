from __future__ import annotations

from pathlib import Path

from backend.v2.config import load_config
from backend.v2.profile import CausalVolumeProfile
from backend.v2.structure import CausalSwingDetector, ZoneBook


def book(tmp_path: Path) -> ZoneBook:
    return ZoneBook("SPY", load_config()["structure"], tmp_path / "zones.json")


def test_causal_swing_has_no_lookahead() -> None:
    detector = CausalSwingDetector(1.0)
    assert detector.update(0, 100, 1) is None
    assert detector.update(1, 101, 1) is None
    confirmed = detector.update(2, 100, 1)
    assert confirmed == {"price": 101, "time": 1, "role": "RESISTANCE"}


def test_multiweek_zone_survives_restart(tmp_path: Path) -> None:
    original = book(tmp_path)
    original.add_level(price=700, timestamp=0, source_type="WEEKLY_HIGH", timeframe="WEEKLY",
                       role="RESISTANCE", atr_reference=5, reaction_strength=1, qualified_reaction=True)
    original.save()
    loaded = book(tmp_path)
    assert len(loaded.zones) == 1
    assert loaded.zones[0].center == original.zones[0].center


def test_nearby_levels_cluster_without_independent_touch_votes(tmp_path: Path) -> None:
    zones = book(tmp_path)
    first = zones.add_level(price=772.00, timestamp=10, source_type="GEX", timeframe="DAILY", role="RESISTANCE", atr_reference=2)
    second = zones.add_level(price=772.04, timestamp=11, source_type="WEEKLY_VAH", timeframe="WEEKLY", role="RESISTANCE", atr_reference=2)
    assert first.zone_id == second.zone_id
    assert len(zones.zones) == 1
    assert second.qualified_touch_count == 0


def test_real_reaction_refreshes_zone(tmp_path: Path) -> None:
    zones = book(tmp_path)
    zone = zones.add_level(price=772, timestamp=10, source_type="SWING", timeframe="INTRADAY", role="RESISTANCE", atr_reference=2)
    zones.add_level(price=772.02, timestamp=20, source_type="SWING", timeframe="INTRADAY", role="RESISTANCE", atr_reference=2, qualified_reaction=True)
    assert zone.qualified_touch_count == 1
    assert zone.last_reaction_time == 20


def test_old_weak_zone_decays(tmp_path: Path) -> None:
    zones = book(tmp_path)
    zone = zones.add_level(price=772, timestamp=0, source_type="SWING", timeframe="INTRADAY", role="RESISTANCE", atr_reference=2)
    old = zones.strength(zone, 60 * 86400)
    assert old < zones.strength(zone, 0)


def test_only_target_corridor_and_top_k_apply(tmp_path: Path) -> None:
    zones = book(tmp_path)
    for index in range(8):
        zones.add_level(price=770.5 + index * 0.25, timestamp=100, source_type=f"SWING{index}", timeframe="WEEKLY",
                        role="RESISTANCE", atr_reference=0.2, reaction_strength=1, qualified_reaction=True)
    zones.add_level(price=769, timestamp=100, source_type="SUPPORT", timeframe="WEEKLY", role="SUPPORT",
                    atr_reference=0.2, reaction_strength=1, qualified_reaction=True)
    active = zones.active_zones(now=100, current_price=770, target_price=772, direction="CALL")
    assert len(active) <= 3
    assert all(770 < zone.center <= 772 for zone in active)


def test_path_uses_strongest_obstacle_not_line_sum(tmp_path: Path) -> None:
    zones = book(tmp_path)
    a = zones.add_level(price=771, timestamp=100, source_type="WEEKLY_HIGH", timeframe="WEEKLY", role="RESISTANCE",
                        atr_reference=.1, reaction_strength=.9, qualified_reaction=True)
    b = zones.add_level(price=771.8, timestamp=100, source_type="DAILY_HIGH", timeframe="DAILY", role="RESISTANCE",
                        atr_reference=.1, reaction_strength=.5, qualified_reaction=True)
    clearance, obstacle, active = zones.path_clearance(now=100, current_price=770, target_price=772, direction="CALL")
    expected = 1 - max(zone.zone_strength * (1 - abs(zone.center - 770) / 2) for zone in active)
    assert abs(clearance - expected) < 1e-12
    assert obstacle in (a, b)


def test_accepted_resistance_no_longer_blocks_call(tmp_path: Path) -> None:
    zones = book(tmp_path)
    zones.add_level(price=771, timestamp=0, source_type="HIGH", timeframe="WEEKLY", role="RESISTANCE",
                    atr_reference=.2, reaction_strength=1, qualified_reaction=True)
    zones.observe_price(timestamp=1, price=771.2, atr_reference=.2, completed_short_bar=True)
    zones.observe_price(timestamp=2, price=771.2, atr_reference=.2, completed_short_bar=True)
    assert zones.active_zones(now=2, current_price=770, target_price=772, direction="CALL") == []


def test_causal_volume_profile_no_lookahead() -> None:
    profile = CausalVolumeProfile(0.25)
    profile.add(100, 10); before = profile.levels()
    profile.add(101, 100); after = profile.levels()
    assert before["poc"] == 100
    assert after["poc"] == 101
