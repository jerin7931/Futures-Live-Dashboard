"""Versioned presentation, target, regime, selection, and invalidation policies."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from .providers.contracts import (CANDIDATE_MAX_ABS_DELTA,
                                  CANDIDATE_MIN_ABS_DELTA)


TARGETS = (0.05, 0.10, 0.15, 0.20, 0.25, 0.30)


def grade_for_probability(probability: float) -> str | None:
    if probability >= 0.25:
        return "A"
    if probability >= 0.15:
        return "B"
    if probability >= 0.10:
        return "C"
    return None


def validate_ladder(ladder: dict[float, float]) -> None:
    values = [float(ladder[target]) for target in TARGETS]
    if any(not 0 <= value <= 1 for value in values):
        raise ValueError("Target-ladder probabilities must be in [0, 1]")
    if any(left < right for left, right in zip(values, values[1:])):
        raise ValueError("Target-ladder probabilities must be nested")


def aim_for(ladder: dict[float, float]) -> float:
    validate_ladder(ladder)
    return max(0.0, min(0.30, 0.05 * sum(float(ladder[target]) for target in TARGETS)))


def rounded_aim_percent(ladder: dict[float, float]) -> int:
    return int(round(100 * aim_for(ladder)))


def target_premium(current_ask: float, ladder: dict[float, float]) -> float:
    if not current_ask or current_ask <= 0:
        raise ValueError("A positive current ask is required")
    return current_ask * (1 + aim_for(ladder))


def gamma_regime(signed_by_strike: dict[float, float], neutral_band: float = 0.15,
                 scope: str = "FULL_CHAIN") -> dict[str, Any]:
    denominator = sum(abs(float(value)) for value in signed_by_strike.values())
    balance = sum(float(value) for value in signed_by_strike.values()) / max(denominator, 1e-12)
    balance = max(-1.0, min(1.0, balance))
    label = "POSITIVE GAMMA" if balance >= neutral_band else "NEGATIVE GAMMA" if balance <= -neutral_band else "MIXED / NEAR NEUTRAL"
    return {"label": label, "gamma_balance": balance, "scope": scope}


def market_condition(option_context: dict[str, float], structure: dict[str, Any]) -> dict[str, Any]:
    score = 0
    reasons: list[str] = []
    for key, positive_reason, negative_reason, polarity in (
        ("directional_flow", "positive call-side flow", "negative directional flow", 1),
        ("net_drift", "positive net drift", "negative net drift", 1),
    ):
        if key not in option_context:
            continue
        try:
            value = float(option_context[key]) * polarity
        except (TypeError, ValueError):
            continue
        if value > 0:
            score += 1; reasons.append(positive_reason)
        elif value < 0:
            score -= 1; reasons.append(negative_reason)
    if structure.get("above_vwap") is True:
        score += 1; reasons.append("above accepted VWAP")
    elif structure.get("above_vwap") is False:
        score -= 1; reasons.append("below accepted VWAP")
    if structure.get("support_holding") is True:
        score += 1; reasons.append("support holding")
    if structure.get("resistance_holding") is True:
        score -= 1; reasons.append("resistance holding")
    if structure.get("transition") is True:
        label = "TRANSITION / MIXED"
    elif abs(score) <= 1:
        label = "RANGE"
    else:
        label = "BULLISH" if score > 0 else "BEARISH"
    return {"label": label, "score": score, "reasons": reasons[:4] or ["mixed causal evidence"]}


class ThesisState(StrEnum):
    LIVE = "LIVE"
    HOLD = "HOLD"
    WARNING = "WARNING"
    INVALIDATED = "INVALIDATED"
    STALE = "STALE"
    BLOCKED = "BLOCKED"


@dataclass
class InvalidationMachine:
    direction: str
    grade_boundary: float
    support_or_resistance: float | None = None
    setup_episode_id: str = ""
    state: ThesisState = ThesisState.LIVE
    weak_count: int = 0
    reason: str | None = None
    history: list[dict[str, Any]] = field(default_factory=list)

    def update(
        self,
        *,
        current_probability: float,
        opposite_probability: float | None,
        structure_bias: str,
        accepted_structure_break: bool = False,
        wick_only: bool = False,
        data_valid: bool = True,
        advance_weak_count: bool = True,
    ) -> ThesisState:
        previous = self.state
        if self.state == ThesisState.INVALIDATED:
            return self.state
        if not data_valid:
            # Data/guidance health is an orthogonal service concern. Preserve
            # thesis memory, especially a terminal INVALIDATED state.
            return self.state
        elif accepted_structure_break and not wick_only:
            self.state = ThesisState.INVALIDATED
            self.reason = "STRUCTURE_ACCEPTED_BELOW_SUPPORT" if self.direction == "CALL" else "STRUCTURE_ACCEPTED_ABOVE_RESISTANCE"
        else:
            if advance_weak_count:
                self.weak_count = self.weak_count + 1 if current_probability < 0.10 else 0
            opposite_strong = opposite_probability is not None and opposite_probability >= 0.15
            deteriorated = structure_bias != ("BULLISH" if self.direction == "CALL" else "BEARISH")
            if self.weak_count >= 2 and opposite_strong and deteriorated:
                self.state = ThesisState.INVALIDATED
                self.reason = "MODEL_REVERSAL_CONFIRMED"
            elif current_probability < self.grade_boundary or opposite_strong:
                self.state = ThesisState.WARNING
                self.reason = "THESIS_WEAKENING"
            else:
                self.state = ThesisState.LIVE
                self.reason = None
        if self.state != previous:
            self.history.append({"previous_state": previous.value, "state": self.state.value, "reason": self.reason})
        return self.state

    def invalid_if_text(self) -> str:
        if self.support_or_resistance is not None:
            relation = "below" if self.direction == "CALL" else "above"
            noun = "support" if self.direction == "CALL" else "resistance"
            return f"Invalid if price accepts {relation} {self.support_or_resistance:.2f} {noun}"
        opposite = "PUT" if self.direction == "CALL" else "CALL"
        structure = "bearish" if self.direction == "CALL" else "bullish"
        return f"Invalid if {self.direction} score stays <10% and {opposite} reaches >=15% with {structure} structure"


def choose_contract(candidates: list[dict[str, Any]]) -> dict[str, Any] | None:
    eligible = [row for row in candidates if row.get("quote_valid") and
                CANDIDATE_MIN_ABS_DELTA <= abs(float(row.get("delta", 0))) <= CANDIDATE_MAX_ABS_DELTA and
                int(row.get("dte", -1)) == 1]
    if not eligible:
        return None
    # Product-approved deterministic ordering. Probability is bucketed at one
    # basis point so numerically immaterial score noise is a tie. Quote quality
    # remains the primary execution-quality comparison; live current-session
    # volume is the first tie-break after probability and spread are tied.
    return min(
        eligible,
        key=lambda row: (
            -round(float(row.get("model_probability", 0.0)), 4),
            float(row.get("relative_spread") if row.get("relative_spread") is not None else float("inf")),
            -float(row.get("current_session_volume") or 0.0),
            abs(abs(float(row.get("delta", 0))) - 0.65),
            str(row.get("contract", "")),
        ),
    )
