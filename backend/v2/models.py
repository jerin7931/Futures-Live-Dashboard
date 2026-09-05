from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class DirectionState(str, Enum):
    BLOCKED = "BLOCKED"
    NO_TRADE = "NO_TRADE"
    ARMING_CALL = "ARMING_CALL"
    CALL_READY = "CALL_READY"
    ARMING_PUT = "ARMING_PUT"
    PUT_READY = "PUT_READY"


class QuoteState(str, Enum):
    GOOD = "QUOTE_GOOD"
    DEGRADED = "QUOTE_DEGRADED"
    INVALID = "QUOTE_INVALID"


@dataclass(frozen=True)
class Evidence:
    futures: float
    cash: float
    structure: float
    flow_persistence: float
    flow_active_fraction: float = 0.0
    flow_sign_duration: float = 0.0


@dataclass
class Transition:
    state: DirectionState
    display_state: str
    state_since: float
    direction: str
    primary_reason: str
    reasons: list[str] = field(default_factory=list)
    armed_seconds: float = 0.0
    required_seconds: float = 0.0


@dataclass
class Zone:
    zone_id: str
    symbol: str
    lower_bound: float
    upper_bound: float
    center: float
    first_seen: float
    last_reaction_time: float
    source_types: list[str]
    source_timeframes: list[str]
    qualified_touch_count: int = 0
    historical_reaction_strength: float = 0.0
    volume_profile_significance: float = 0.0
    options_positioning_confluence: float = 0.0
    zone_strength: float = 0.0
    current_role: str = "NEUTRAL"
    accepted_state: str = "NEUTRAL"
    broken: bool = False

    def as_dict(self) -> dict[str, Any]:
        return vars(self).copy()


@dataclass
class Candidate:
    symbol: str
    expiration: str
    option_type: str
    strike: float
    option_symbol: str
    bid: float
    ask: float
    last: float | None
    bid_size: int | None
    ask_size: int | None
    volume: int
    open_interest: int
    delta: float
    gamma: float
    iv: float
    quote_time: str | None
    greeks_time: str | None
    spot_at_greeks: float | None
    quote_quality: float = 0.0
    liquidity: float = 0.0
    surface_consistency: float = 0.0
    scenario_resilience: float = 0.0
    path_clearance: float = 0.0
    delta_preference: float = 0.0
    utility: float = 0.0
    reasons: list[str] = field(default_factory=list)

    @property
    def relative_spread(self) -> float:
        mid = (self.bid + self.ask) / 2.0
        return (self.ask - self.bid) / mid if mid > 0.0 else float("inf")

    @property
    def min_displayed_size(self) -> int:
        if self.bid_size is None or self.ask_size is None:
            return 0
        return min(max(self.bid_size, 0), max(self.ask_size, 0))
