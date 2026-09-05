from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from .math_utils import bounded_median, clamp, ewma_alpha, finite, safe_ratio


@dataclass
class DecayedFlow:
    fast_half_life: float = 0.75
    slow_half_life: float = 3.0
    book_half_life: float = 0.5
    persistence_window: float = 2.0
    active_threshold: float = 0.15
    n_fast: float = 0.0
    d_fast: float = 0.0
    n_slow: float = 0.0
    d_slow: float = 0.0
    smoothed_depth: float = 0.0
    samples: deque[tuple[float, int, bool]] = field(default_factory=deque)
    last_sign: int = 0
    sign_since: float = 0.0

    def update(
        self,
        *,
        now: float,
        dt: float,
        buy_volume: float,
        sell_volume: float,
        bids: list[tuple[float, float]],
        asks: list[tuple[float, float]],
        bid: float,
        ask: float,
        bid_size: float,
        ask_size: float,
        large_buy_volume: float = 0.0,
        large_sell_volume: float = 0.0,
        normalized_price_response: float = 0.0,
        bid_replenishment: float = 0.0,
        ask_replenishment: float = 0.0,
        activity: float = 0.0,
    ) -> dict[str, float]:
        buy_volume, sell_volume = max(0.0, buy_volume), max(0.0, sell_volume)
        signed, total = buy_volume - sell_volume, buy_volume + sell_volume
        a_fast, a_slow = ewma_alpha(dt, self.fast_half_life), ewma_alpha(dt, self.slow_half_life)
        self.n_fast = (1.0 - a_fast) * self.n_fast + a_fast * signed
        self.d_fast = (1.0 - a_fast) * self.d_fast + a_fast * total
        self.n_slow = (1.0 - a_slow) * self.n_slow + a_slow * signed
        self.d_slow = (1.0 - a_slow) * self.d_slow + a_slow * total
        f_fast = clamp(safe_ratio(self.n_fast, max(self.d_fast, 1e-12)), -1.0, 1.0)
        f_slow = clamp(safe_ratio(self.n_slow, max(self.d_slow, 1e-12)), -1.0, 1.0)
        aggression = clamp(0.60 * f_fast + 0.40 * f_slow, -1.0, 1.0)

        weighted_bid = sum(max(size, 0.0) / (index + 1.0) for index, (_, size) in enumerate(bids[:5]))
        weighted_ask = sum(max(size, 0.0) / (index + 1.0) for index, (_, size) in enumerate(asks[:5]))
        raw_depth = clamp(safe_ratio(weighted_bid - weighted_ask, weighted_bid + weighted_ask), -1.0, 1.0)
        a_book = ewma_alpha(dt, self.book_half_life)
        self.smoothed_depth = (1.0 - a_book) * self.smoothed_depth + a_book * raw_depth
        valid_book = bid > 0.0 and ask >= bid and bid_size > 0.0 and ask_size > 0.0
        if valid_book:
            microprice = (ask * bid_size + bid * ask_size) / (bid_size + ask_size)
            mid = (bid + ask) / 2.0
            microprice_edge = clamp(2.0 * (microprice - mid) / max(ask - bid, 1e-12), -1.0, 1.0)
            book = clamp(0.50 * self.smoothed_depth + 0.50 * microprice_edge, -1.0, 1.0)
        else:
            microprice = float("nan")
            microprice_edge = 0.0
            book = clamp(self.smoothed_depth * 0.50, -1.0, 1.0) if weighted_bid + weighted_ask > 0 else 0.0

        price_response = clamp(normalized_price_response, -1.0, 1.0)
        response_magnitude = clamp(abs(price_response), 0.0, 1.0)
        sell_absorption = max(f_fast, 0.0) * clamp(activity, 0.0, 1.0) * (1.0 - response_magnitude) * clamp(ask_replenishment, 0.0, 1.0)
        buy_absorption = max(-f_fast, 0.0) * clamp(activity, 0.0, 1.0) * (1.0 - response_magnitude) * clamp(bid_replenishment, 0.0, 1.0)
        absorption = clamp(buy_absorption - sell_absorption, -1.0, 1.0)
        large_direction = clamp(safe_ratio(large_buy_volume - large_sell_volume, large_buy_volume + large_sell_volume), -1.0, 1.0)
        execution_response = clamp(0.40 * large_direction + 0.35 * absorption + 0.25 * price_response, -1.0, 1.0)
        flow = bounded_median([aggression, book, execution_response])

        active = total > 0.0 and abs(flow) >= self.active_threshold
        sign = 1 if flow > 0.0 else -1 if flow < 0.0 else 0
        self.samples.append((now, sign, active))
        while self.samples and self.samples[0][0] < now - self.persistence_window:
            self.samples.popleft()
        active_samples = [sample_sign for _, sample_sign, is_active in self.samples if is_active]
        persistence = safe_ratio(sum(1 for sample_sign in active_samples if sample_sign == sign), len(active_samples)) if sign else 0.0
        active_fraction = safe_ratio(len(active_samples), len(self.samples))
        if active and sign != self.last_sign:
            self.last_sign, self.sign_since = sign, now
        elif not active:
            self.last_sign, self.sign_since = 0, now
        sign_duration = max(0.0, now - self.sign_since) if active else 0.0

        return {
            "f_fast": f_fast,
            "f_slow": f_slow,
            "aggression": aggression,
            "depth_imbalance": clamp(self.smoothed_depth, -1.0, 1.0),
            "microprice": microprice,
            "microprice_edge": microprice_edge,
            "book": book,
            "large_trade_direction": large_direction,
            "bid_replenishment": clamp(bid_replenishment, 0.0, 1.0),
            "ask_replenishment": clamp(ask_replenishment, 0.0, 1.0),
            "absorption": absorption,
            "normalized_price_response": price_response,
            "execution_response": execution_response,
            "futures_flow_evidence": flow,
            "flow_persistence": clamp(persistence, 0.0, 1.0),
            "flow_active_fraction": clamp(active_fraction, 0.0, 1.0),
            "flow_sign_duration": sign_duration,
        }


def normalized_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Validate the NinjaTrader V2 feature contract and clamp every published feature."""
    signed = (
        "f_fast", "f_slow", "aggression", "depth_imbalance", "microprice_edge", "book",
        "large_trade_direction", "absorption", "normalized_price_response", "execution_response",
        "futures_flow_evidence",
    )
    quality = ("bid_replenishment", "ask_replenishment", "flow_persistence", "flow_active_fraction")
    result = dict(payload)
    for name in signed:
        result[name] = clamp(finite(payload.get(name), 0.0) or 0.0, -1.0, 1.0)
    for name in quality:
        result[name] = clamp(finite(payload.get(name), 0.0) or 0.0, 0.0, 1.0)
    result["flow_sign_duration"] = max(0.0, finite(payload.get("flow_sign_duration"), 0.0) or 0.0)
    return result
