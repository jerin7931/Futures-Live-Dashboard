from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from .math_utils import age_seconds, clamp, finite, harmonic_mean, parse_utc
from .models import Candidate, QuoteState
from .pricing import SECONDS_PER_YEAR, bsm_greeks


def normalize_iv(value: Any) -> float | None:
    parsed = finite(value)
    if parsed is None or parsed <= 0.0:
        return None
    decimal = parsed / 100.0 if parsed > 3.0 else parsed
    return decimal if 0.005 <= decimal <= 5.0 else None


def delta_preference(delta: float, center: float = 0.65, width: float = 0.10) -> float:
    return round(clamp(1.0 - abs(abs(delta) - center) / width, 0.0, 1.0), 12)


def quote_quality(candidate: Candidate, quote_age: float, maximum_spread: float, stale_seconds: float) -> float:
    if candidate.ask <= 0.0 or candidate.bid < 0.0 or candidate.bid > candidate.ask:
        return 0.0
    spread_component = clamp(1.0 - candidate.relative_spread / max(maximum_spread, 1e-12), 0.0, 1.0)
    age_component = clamp(1.0 - quote_age / max(stale_seconds, 1e-12), 0.0, 1.0)
    size_component = 1.0 if candidate.bid_size is None or candidate.ask_size is None else clamp(candidate.min_displayed_size / 10.0, 0.0, 1.0)
    return harmonic_mean([spread_component, age_component, size_component])


def liquidity_quality(candidate: Candidate) -> float:
    oi = clamp(math.log10(max(candidate.open_interest, 0) + 1.0) / 5.0, 0.0, 1.0)
    volume = clamp(math.log10(max(candidate.volume, 0) + 1.0) / 5.0, 0.0, 1.0)
    size = 0.5 if candidate.bid_size is None or candidate.ask_size is None else clamp(candidate.min_displayed_size / 25.0, 0.0, 1.0)
    return harmonic_mean([max(oi, 0.01), max(volume, 0.01), max(size, 0.01)])


def surface_consistency(candidate: Candidate, peers: list[Candidate]) -> float:
    same_side = sorted((row for row in peers if row.option_type == candidate.option_type and row.expiration == candidate.expiration), key=lambda row: row.strike)
    try:
        index = same_side.index(candidate)
    except ValueError:
        return 0.0
    neighbors = same_side[max(0, index - 1):index] + same_side[index + 1:index + 2]
    if not neighbors:
        return 0.5
    local = sum(row.iv for row in neighbors) / len(neighbors)
    difference = abs(candidate.iv - local) / max(local, 1e-12)
    return clamp(1.0 - difference / 0.30, 0.0, 1.0)


def candidate_utility(candidate: Candidate) -> float:
    return harmonic_mean([
        candidate.delta_preference,
        candidate.quote_quality,
        candidate.liquidity,
        candidate.surface_consistency,
        candidate.scenario_resilience,
        candidate.path_clearance,
    ])


def validate_candidate(
    candidate: Candidate,
    *,
    now_utc: datetime,
    seconds_to_expiration: float,
    minimum_minutes_to_expiration: float,
    quote_stale_seconds: float,
    eligible_delta_min: float = 0.60,
    eligible_delta_max: float = 0.70,
) -> list[str]:
    reasons: list[str] = []
    if candidate.ask <= 0.0 or candidate.bid < 0.0:
        reasons.append("INVALID_OPTION_QUOTE")
    if candidate.bid > candidate.ask:
        reasons.append("CROSSED_OPTION_QUOTE")
    if candidate.iv <= 0.0 or not math.isfinite(candidate.iv):
        reasons.append("IV_UNIT_INVALID")
    if candidate.option_type == "CALL" and candidate.delta <= 0.0:
        reasons.append("INVALID_DELTA_SIGN")
    if candidate.option_type == "PUT" and candidate.delta >= 0.0:
        reasons.append("INVALID_DELTA_SIGN")
    if not eligible_delta_min <= abs(candidate.delta) <= eligible_delta_max:
        reasons.append("NO_ELIGIBLE_DELTA")
    if seconds_to_expiration <= minimum_minutes_to_expiration * 60.0:
        reasons.append("TTE_TOO_SHORT")
    if age_seconds(candidate.quote_time, now_utc) > quote_stale_seconds:
        reasons.append("OPTION_QUOTE_STALE")
    if parse_utc(candidate.quote_time) is None:
        reasons.append("OPTION_QUOTE_STALE")
    return list(dict.fromkeys(reasons))


def greek_consistency(
    candidate: Candidate,
    *,
    current_spot: float,
    seconds_to_expiration: float,
    rate: float,
    dividend: float,
    move_tolerance: float,
    delta_tolerance: float,
    gamma_relative_tolerance: float,
) -> tuple[float, float, list[str]]:
    reasons: list[str] = []
    if candidate.spot_at_greeks and abs(current_spot - candidate.spot_at_greeks) / candidate.spot_at_greeks > move_tolerance:
        reasons.append("GREEKS_DEGRADED")
    local_delta, local_gamma = bsm_greeks(
        candidate.option_type,
        current_spot,
        candidate.strike,
        max(seconds_to_expiration, 0.0) / SECONDS_PER_YEAR,
        rate,
        dividend,
        candidate.iv,
    )
    if abs(local_delta - candidate.delta) > delta_tolerance:
        reasons.append("GREEKS_QUOTE_INCONSISTENT")
    if abs(local_gamma - candidate.gamma) / max(abs(candidate.gamma), 1e-9) > gamma_relative_tolerance:
        reasons.append("GREEKS_QUOTE_INCONSISTENT")
    return local_delta, local_gamma, list(dict.fromkeys(reasons))


def rank_candidates(candidates: list[Candidate], required_moves: dict[str, float | None]) -> list[Candidate]:
    def key(candidate: Candidate) -> tuple[Any, ...]:
        move = required_moves.get(candidate.option_symbol)
        move_sort = float("inf") if move is None else move
        strike_sort = candidate.strike if candidate.option_type == "CALL" else -candidate.strike
        return (
            -candidate.utility,
            candidate.relative_spread,
            move_sort,
            -candidate.min_displayed_size,
            abs(abs(candidate.delta) - 0.65),
            -candidate.open_interest,
            strike_sort,
            candidate.option_symbol,
        )
    return sorted(candidates, key=key)


@dataclass
class QuoteHysteresis:
    state: QuoteState = QuoteState.INVALID
    bad_since: float | None = None
    invalid_since: float | None = None

    def update(self, *, now: float, hard_invalid: bool, wide: bool, degraded_seconds: float, invalid_seconds: float) -> QuoteState:
        if hard_invalid:
            if self.invalid_since is None:
                self.invalid_since = now
            if now - self.invalid_since >= invalid_seconds:
                self.state = QuoteState.INVALID
            else:
                self.state = QuoteState.DEGRADED
            return self.state
        self.invalid_since = None
        if wide:
            if self.bad_since is None:
                self.bad_since = now
            if self.state == QuoteState.INVALID:
                self.state = QuoteState.DEGRADED
            if now - self.bad_since >= degraded_seconds:
                self.state = QuoteState.DEGRADED
            return self.state
        self.bad_since = None
        self.state = QuoteState.GOOD
        return self.state


@dataclass
class ContractSelector:
    selected: Candidate | None = None
    challenger_symbol: str | None = None
    challenger_since: float | None = None

    def choose(self, ranked: list[Candidate], *, now: float, switch_margin: float, switch_persistence: float) -> Candidate | None:
        if not ranked:
            self.selected = None
            self.challenger_symbol = None
            self.challenger_since = None
            return None
        best = ranked[0]
        current = next((row for row in ranked if self.selected and row.option_symbol == self.selected.option_symbol), None)
        if current is None:
            self.selected, self.challenger_symbol, self.challenger_since = best, None, None
            return best
        self.selected = current
        if best.option_symbol == current.option_symbol or best.utility < current.utility + switch_margin:
            self.challenger_symbol, self.challenger_since = None, None
            return current
        if self.challenger_symbol != best.option_symbol:
            self.challenger_symbol, self.challenger_since = best.option_symbol, now
            return current
        if self.challenger_since is not None and now - self.challenger_since >= switch_persistence:
            self.selected, self.challenger_symbol, self.challenger_since = best, None, None
        return self.selected
