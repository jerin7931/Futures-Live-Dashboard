from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import Iterable

from .math_utils import clamp


@dataclass
class CausalVolumeProfile:
    """Incremental profile using only volume observed at or before each call."""

    tick_size: float
    volume_by_price: dict[float, float] = field(default_factory=lambda: defaultdict(float))

    def add(self, price: float, volume: float) -> None:
        if price <= 0.0 or volume <= 0.0:
            return
        bucket = round(price / self.tick_size) * self.tick_size
        self.volume_by_price[bucket] += float(volume)

    def levels(self, value_area_fraction: float = 0.70) -> dict[str, float | None]:
        if not self.volume_by_price:
            return {"poc": None, "vah": None, "val": None, "total_volume": 0.0}
        rows = sorted(self.volume_by_price.items())
        total = sum(volume for _, volume in rows)
        poc_index = max(range(len(rows)), key=lambda index: (rows[index][1], -rows[index][0]))
        included = {poc_index}
        accumulated = rows[poc_index][1]
        left, right = poc_index - 1, poc_index + 1
        target = total * clamp(value_area_fraction, 0.0, 1.0)
        while accumulated < target and (left >= 0 or right < len(rows)):
            left_volume = rows[left][1] if left >= 0 else -1.0
            right_volume = rows[right][1] if right < len(rows) else -1.0
            take = right if right_volume > left_volume else left
            included.add(take)
            accumulated += rows[take][1]
            if take == left:
                left -= 1
            else:
                right += 1
        prices = [rows[index][0] for index in included]
        return {"poc": rows[poc_index][0], "vah": max(prices), "val": min(prices), "total_volume": total}


def composite_profile(profiles: Iterable[CausalVolumeProfile], tick_size: float) -> CausalVolumeProfile:
    result = CausalVolumeProfile(tick_size)
    for profile in profiles:
        for price, volume in profile.volume_by_price.items():
            result.add(price, volume)
    return result
