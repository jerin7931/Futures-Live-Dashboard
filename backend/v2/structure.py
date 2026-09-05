from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from .math_utils import bounded_median, clamp, stable_hash
from .models import Zone


TIMEFRAME_IMPORTANCE = {"INTRADAY": 0.35, "DAILY": 0.65, "WEEKLY": 0.85, "COMPOSITE": 1.0}


@dataclass
class CausalSwingDetector:
    atr_multiple: float = 1.0
    direction: int = 0
    candidate_price: float | None = None
    candidate_time: float | None = None

    def update(self, timestamp: float, price: float, atr_reference: float) -> dict[str, Any] | None:
        """Confirm an old extreme only after a subsequent ATR-sized reversal."""
        if price <= 0.0 or atr_reference <= 0.0:
            return None
        threshold = self.atr_multiple * atr_reference
        if self.candidate_price is None:
            self.candidate_price, self.candidate_time = price, timestamp
            return None
        if self.direction >= 0:
            if price >= self.candidate_price:
                self.candidate_price, self.candidate_time = price, timestamp
                self.direction = 1
                return None
            if self.candidate_price - price >= threshold:
                confirmed = {"price": self.candidate_price, "time": self.candidate_time, "role": "RESISTANCE"}
                self.direction = -1
                self.candidate_price, self.candidate_time = price, timestamp
                return confirmed
        if self.direction <= 0:
            if price <= self.candidate_price:
                self.candidate_price, self.candidate_time = price, timestamp
                self.direction = -1
                return None
            if price - self.candidate_price >= threshold:
                confirmed = {"price": self.candidate_price, "time": self.candidate_time, "role": "SUPPORT"}
                self.direction = 1
                self.candidate_price, self.candidate_time = price, timestamp
                return confirmed
        return None


class ZoneBook:
    def __init__(self, symbol: str, config: dict[str, Any], path: Path | None = None) -> None:
        self.symbol = symbol
        self.cfg = config
        self.path = path
        self.zones: list[Zone] = []
        self.dirty = False
        self._outside: dict[str, tuple[str, float, int]] = {}
        if path and path.is_file():
            self.load()

    def load(self) -> None:
        raw = json.loads(self.path.read_text(encoding="utf-8")) if self.path else []
        self.zones = [Zone(**row) for row in raw if row.get("symbol") == self.symbol]

    def save(self) -> None:
        if not self.path:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.path.with_suffix(self.path.suffix + ".tmp")
        temp.write_text(json.dumps([zone.as_dict() for zone in self.zones], indent=2, sort_keys=True), encoding="utf-8")
        temp.replace(self.path)
        self.dirty = False

    def _tolerance(self, price: float, atr_reference: float) -> float:
        return max(price * self.cfg["cluster_minimum_pct"], atr_reference * self.cfg["cluster_atr_fraction"])

    def add_level(
        self,
        *,
        price: float,
        timestamp: float,
        source_type: str,
        timeframe: str,
        role: str,
        atr_reference: float,
        reaction_strength: float = 0.0,
        profile_significance: float = 0.0,
        options_confluence: float = 0.0,
        qualified_reaction: bool = False,
    ) -> Zone:
        tolerance = self._tolerance(price, atr_reference)
        nearby = [zone for zone in self.zones if zone.lower_bound - tolerance <= price <= zone.upper_bound + tolerance]
        if nearby:
            zone = min(nearby, key=lambda item: abs(item.center - price))
            zone.lower_bound = min(zone.lower_bound, price - tolerance / 2.0)
            zone.upper_bound = max(zone.upper_bound, price + tolerance / 2.0)
            zone.center = (zone.lower_bound + zone.upper_bound) / 2.0
            # Extra sources inside one cluster are confluence metadata, not
            # independent market reactions or recency refreshes.
            if qualified_reaction:
                zone.last_reaction_time = max(zone.last_reaction_time, timestamp)
                zone.qualified_touch_count += 1
            zone.source_types = sorted(set(zone.source_types) | {source_type})
            zone.source_timeframes = sorted(set(zone.source_timeframes) | {timeframe})
            zone.historical_reaction_strength = max(zone.historical_reaction_strength, clamp(reaction_strength, 0.0, 1.0))
            zone.volume_profile_significance = max(zone.volume_profile_significance, clamp(profile_significance, 0.0, 1.0))
            zone.options_positioning_confluence = max(zone.options_positioning_confluence, clamp(options_confluence, 0.0, 1.0))
            if zone.current_role != role and role in {"SUPPORT", "RESISTANCE"}:
                zone.current_role = "FLIP_ZONE"
        else:
            zone = Zone(
                zone_id=stable_hash([self.symbol, round(price, 4), round(timestamp, 3), source_type])[:16],
                symbol=self.symbol,
                lower_bound=price - tolerance / 2.0,
                upper_bound=price + tolerance / 2.0,
                center=price,
                first_seen=timestamp,
                last_reaction_time=timestamp,
                source_types=[source_type],
                source_timeframes=[timeframe],
                qualified_touch_count=1 if qualified_reaction else 0,
                historical_reaction_strength=clamp(reaction_strength, 0.0, 1.0),
                volume_profile_significance=clamp(profile_significance, 0.0, 1.0),
                options_positioning_confluence=clamp(options_confluence, 0.0, 1.0),
                current_role=role,
            )
            self.zones.append(zone)
        zone.zone_strength = self.strength(zone, timestamp)
        self.dirty = True
        return zone

    def strength(self, zone: Zone, now: float) -> float:
        touches = clamp(math.log1p(max(zone.qualified_touch_count, 0)) / math.log(6.0), 0.0, 1.0)
        timeframe = max((TIMEFRAME_IMPORTANCE.get(value.upper(), 0.35) for value in zone.source_timeframes), default=0.35)
        source_classes = {
            "SWING" if "SWING" in value.upper() else
            "PROFILE" if any(part in value.upper() for part in ("POC", "VAH", "VAL", "HVN", "LVN", "PROFILE")) else
            "OPTIONS" if any(part in value.upper() for part in ("GEX", "OI", "DEX", "VANNA", "CHARM")) else
            "REFERENCE"
            for value in zone.source_types
        }
        confluence = clamp(len(source_classes) / 4.0, 0.0, 1.0)
        base = (
            0.20 * touches
            + 0.25 * zone.historical_reaction_strength
            + 0.20 * timeframe
            + 0.15 * zone.volume_profile_significance
            + 0.10 * zone.options_positioning_confluence
            + 0.10 * confluence
        )
        class_name = "WEEKLY" if timeframe >= 0.85 else "DAILY" if timeframe >= 0.65 else "INTRADAY"
        half_life_days = self.cfg[f"{class_name.lower()}_half_life_days"]
        age_days = max(0.0, now - zone.last_reaction_time) / 86400.0
        return clamp(base * math.exp(-math.log(2.0) * age_days / half_life_days), 0.0, 1.0)

    def refresh_strengths(self, now: float) -> None:
        for zone in self.zones:
            zone.zone_strength = self.strength(zone, now)

    def observe_price(self, *, timestamp: float, price: float, atr_reference: float, completed_short_bar: bool = False) -> None:
        """Update zone roles from elapsed acceptance/reclaim evidence only."""
        displacement = max(atr_reference * 0.10, price * 0.0001)
        for zone in self.zones:
            if zone.lower_bound <= price <= zone.upper_bound:
                if zone.current_role != "TESTING":
                    self.dirty = True
                zone.current_role = "TESTING"
                self._outside.pop(zone.zone_id, None)
                continue
            side = "ABOVE" if price > zone.upper_bound + displacement else "BELOW" if price < zone.lower_bound - displacement else "EDGE"
            if side == "EDGE":
                continue
            prior = self._outside.get(zone.zone_id)
            started, bars = (timestamp, 0) if prior is None or prior[0] != side else (prior[1], prior[2])
            if completed_short_bar:
                bars += 1
            self._outside[zone.zone_id] = (side, started, bars)
            accepted = timestamp - started >= 30.0 or bars >= 2
            if accepted:
                if zone.accepted_state != f"ACCEPTED_{side}":
                    self.dirty = True
                zone.accepted_state = f"ACCEPTED_{side}"
                zone.current_role = zone.accepted_state
                zone.broken = True

    def active_zones(self, *, now: float, current_price: float, target_price: float, direction: str) -> list[Zone]:
        self.refresh_strengths(now)
        if direction == "CALL":
            corridor = [zone for zone in self.zones if current_price < zone.center <= target_price]
            corridor = [zone for zone in corridor if zone.accepted_state != "ACCEPTED_ABOVE"]
        else:
            corridor = [zone for zone in self.zones if target_price <= zone.center < current_price]
            corridor = [zone for zone in corridor if zone.accepted_state != "ACCEPTED_BELOW"]
        corridor = [zone for zone in corridor if zone.zone_strength >= self.cfg["minimum_zone_strength"]]
        corridor.sort(key=lambda zone: (-zone.zone_strength, abs(zone.center - current_price), zone.zone_id))
        return corridor[: self.cfg["maximum_active_path_zones"]]

    def path_clearance(self, *, now: float, current_price: float, target_price: float, direction: str) -> tuple[float, Zone | None, list[Zone]]:
        distance = abs(target_price - current_price)
        if distance <= 1e-12:
            return 0.0, None, []
        active = self.active_zones(now=now, current_price=current_price, target_price=target_price, direction=direction)
        obstructions = [zone.zone_strength * (1.0 - clamp(abs(zone.center - current_price) / distance, 0.0, 1.0)) for zone in active]
        if not obstructions:
            return 1.0, None, active
        index = max(range(len(obstructions)), key=lambda idx: (obstructions[idx], -abs(active[idx].center - current_price)))
        return clamp(1.0 - obstructions[index], 0.0, 1.0), active[index], active

    def support_behind(self, price: float) -> Zone | None:
        valid = [zone for zone in self.zones if zone.center <= price and zone.accepted_state != "ACCEPTED_BELOW"]
        return max(valid, key=lambda zone: (zone.center, zone.zone_strength), default=None)

    def resistance_ahead(self, price: float) -> Zone | None:
        valid = [zone for zone in self.zones if zone.center > price and zone.accepted_state != "ACCEPTED_ABOVE"]
        return min(valid, key=lambda zone: (zone.center, -zone.zone_strength), default=None)


def structure_evidence(components: Iterable[float | None]) -> tuple[float, int]:
    valid = [clamp(float(value), -1.0, 1.0) for value in components if value is not None and math.isfinite(float(value))]
    return (bounded_median(valid), len(valid)) if len(valid) >= 3 else (0.0, len(valid))
