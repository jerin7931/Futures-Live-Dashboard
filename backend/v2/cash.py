from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from .math_utils import bounded_median, clamp, safe_ratio


@dataclass
class CashMicrostructure:
    symbol: str
    prices: deque[tuple[float, float]] = field(default_factory=deque)

    def add_price(self, provider_seconds: float, price: float) -> None:
        if price <= 0.0 or not math.isfinite(price):
            return
        if self.prices and provider_seconds < self.prices[-1][0]:
            return
        self.prices.append((provider_seconds, price))
        while self.prices and self.prices[0][0] < provider_seconds - 300.0:
            self.prices.popleft()

    def clock_return(self, seconds: float) -> float | None:
        if not self.prices:
            return None
        now_time, now_price = self.prices[-1]
        eligible = [row for row in self.prices if row[0] <= now_time - seconds]
        if not eligible:
            return None
        old_price = eligible[-1][1]
        return math.log(now_price / old_price) if old_price > 0.0 else None

    @staticmethod
    def depth_components(
        bids: list[tuple[float, float]],
        asks: list[tuple[float, float]],
        bid: float,
        ask: float,
        bid_size: float,
        ask_size: float,
    ) -> tuple[float | None, float | None]:
        if not bids or not asks:
            return None, None
        weighted_bid = sum(max(size, 0.0) / (index + 1.0) for index, (_, size) in enumerate(bids[:10]))
        weighted_ask = sum(max(size, 0.0) / (index + 1.0) for index, (_, size) in enumerate(asks[:10]))
        depth = clamp(safe_ratio(weighted_bid - weighted_ask, weighted_bid + weighted_ask), -1.0, 1.0)
        if bid <= 0.0 or ask < bid or bid_size <= 0.0 or ask_size <= 0.0:
            return depth, None
        microprice = (ask * bid_size + bid * ask_size) / (bid_size + ask_size)
        edge = clamp(2.0 * (microprice - (bid + ask) / 2.0) / max(ask - bid, 1e-12), -1.0, 1.0)
        return depth, edge

    def evidence(
        self,
        *,
        bids: list[tuple[float, float]] | None = None,
        asks: list[tuple[float, float]] | None = None,
        bid: float = 0.0,
        ask: float = 0.0,
        bid_size: float = 0.0,
        ask_size: float = 0.0,
        trade_pressure: float | None = None,
        l2_valid: bool = False,
    ) -> dict[str, Any]:
        depth, microprice = self.depth_components(bids or [], asks or [], bid, ask, bid_size, ask_size) if l2_valid else (None, None)
        returns = {f"return_{seconds}s": self.clock_return(float(seconds)) for seconds in (5, 15, 30, 60)}
        momentum_values = [clamp(value / 0.0015, -1.0, 1.0) for value in returns.values() if value is not None]
        momentum = bounded_median(momentum_values) if momentum_values else None
        valid: list[float] = []
        for value in (depth, microprice, momentum, trade_pressure):
            if value is not None and math.isfinite(value):
                valid.append(clamp(value, -1.0, 1.0))
        return {
            "cash_evidence": bounded_median(valid),
            "distance_weighted_depth_imbalance": depth,
            "cash_microprice_edge": microprice,
            "cash_momentum": momentum,
            "trade_pressure": trade_pressure,
            "returns": returns,
            "valid_components": len(valid),
            "l2_valid": l2_valid,
        }


def tracking_error_bps(etf_now: float, etf_old: float, future_now: float, future_old: float) -> float | None:
    if min(etf_now, etf_old, future_now, future_old) <= 0.0:
        return None
    return 10_000.0 * abs(math.log(etf_now / etf_old) - math.log(future_now / future_old))
