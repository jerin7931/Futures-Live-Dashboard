from __future__ import annotations

from dataclasses import dataclass

from .math_utils import clamp
from .models import DirectionState, Evidence, Transition


@dataclass
class _Timers:
    arm_started: float | None = None
    neutral_started: float | None = None
    opposite_started: float | None = None


class DirectionStateMachine:
    """Deterministic Schmitt-trigger state machine; callers supply the replay clock."""

    def __init__(self, market_config: dict, direction_config: dict, initial_time: float = 0.0) -> None:
        self.cfg = market_config
        self.direction_cfg = direction_config
        self.state = DirectionState.NO_TRADE
        self.state_since = initial_time
        self.timers = _Timers()

    def _set(self, state: DirectionState, now: float) -> None:
        if state != self.state:
            self.state = state
            self.state_since = now
        self.timers = _Timers()

    @staticmethod
    def _sign(state: DirectionState) -> int:
        if state in {DirectionState.ARMING_CALL, DirectionState.CALL_READY}:
            return 1
        if state in {DirectionState.ARMING_PUT, DirectionState.PUT_READY}:
            return -1
        return 0

    def _qualifies(self, sign: int, core: float, evidence: Evidence, setup_type: str) -> tuple[bool, float, list[str]]:
        reversal = "REVERSAL" in setup_type.upper()
        threshold = self.cfg["enter_threshold"]
        required_flow = self.cfg["reversal_flow_persistence"] if reversal else self.cfg["minimum_flow_persistence"]
        required_seconds = self.cfg["reversal_persistence_seconds"] if reversal else self.cfg["entry_persistence_seconds"]
        missing: list[str] = []
        if sign * core < threshold:
            missing.append("DIRECTION_THRESHOLD")
        if evidence.flow_persistence < required_flow:
            missing.append("FLOW_PERSISTENCE")
        required_futures = self.cfg["reversal_flow_threshold"] if reversal else 0.0
        if sign * evidence.futures <= required_futures:
            missing.append("FUTURES_CONFIRMATION")
        if reversal:
            if sign * evidence.cash <= 0.0:
                missing.append("CASH_RESPONSE")
            if sign * evidence.structure < 0.35:
                missing.append("QUALIFIED_LEVEL_REACTION")
        return not missing, required_seconds, missing

    def _shock(self, sign: int, core: float, evidence: Evidence) -> bool:
        threshold = self.direction_cfg.get("shock_threshold", 0.80)
        return (
            sign * core >= threshold
            and sign * evidence.futures >= 0.60
            and sign * evidence.cash >= 0.55
            and sign * evidence.structure >= 0.55
            and evidence.flow_persistence >= max(self.cfg["minimum_flow_persistence"], 0.75)
        )

    def step(
        self,
        *,
        now: float,
        core: float,
        evidence: Evidence,
        setup_type: str = "CONTINUATION",
        hard_vetoes: list[str] | None = None,
        conflicts: list[str] | None = None,
    ) -> Transition:
        core = clamp(core, -1.0, 1.0)
        hard_vetoes = list(hard_vetoes or [])
        conflicts = list(conflicts or [])

        if hard_vetoes:
            self._set(DirectionState.BLOCKED, now)
            return self._transition("BLOCKED", "NONE", hard_vetoes[0], hard_vetoes)

        if self.state == DirectionState.BLOCKED:
            self._set(DirectionState.NO_TRADE, now)

        if conflicts:
            # Abstain immediately while retaining Schmitt state memory. A
            # one-snapshot conflict must not manufacture direction churn.
            return self._transition("ABSTAIN", "NONE", conflicts[0], conflicts)

        if self.direction_cfg.get("shock_reversal_enabled", False) and self._shock(1, core, evidence) and self.state == DirectionState.PUT_READY:
            self._set(DirectionState.CALL_READY, now)
            return self._transition("CALL READY", "CALL", "SHOCK_REVERSAL", ["SHOCK_REVERSAL"])
        if self.direction_cfg.get("shock_reversal_enabled", False) and self._shock(-1, core, evidence) and self.state == DirectionState.CALL_READY:
            self._set(DirectionState.PUT_READY, now)
            return self._transition("PUT READY", "PUT", "SHOCK_REVERSAL", ["SHOCK_REVERSAL"])

        if self.state == DirectionState.NO_TRADE:
            sign = 1 if core >= self.cfg["enter_threshold"] else -1 if core <= -self.cfg["enter_threshold"] else 0
            if sign:
                qualifies, required, missing = self._qualifies(sign, core, evidence, setup_type)
                target = DirectionState.ARMING_CALL if sign > 0 else DirectionState.ARMING_PUT
                self._set(target, now)
                self.timers.arm_started = now
                if not qualifies:
                    return self._arming(sign, now, required, missing)
                return self._arming(sign, now, required, ["WAITING_FOR_PERSISTENCE"])
            return self._transition("NO TRADE", "NONE", "NO_DIRECTIONAL_EDGE", ["NO_DIRECTIONAL_EDGE"])

        if self.state in {DirectionState.ARMING_CALL, DirectionState.ARMING_PUT}:
            sign = self._sign(self.state)
            qualifies, required, missing = self._qualifies(sign, core, evidence, setup_type)
            if not qualifies:
                # Opposite evidence must enter through NO_TRADE; no direct arming flip.
                if sign * core <= 0.0:
                    self._set(DirectionState.NO_TRADE, now)
                    return self._transition("NO TRADE", "NONE", missing[0] if missing else "ARMING_CANCELLED", missing or ["ARMING_CANCELLED"])
                self.timers.arm_started = now
                return self._arming(sign, now, required, missing)
            if self.timers.arm_started is None:
                self.timers.arm_started = now
            armed = max(0.0, now - self.timers.arm_started)
            if armed >= required:
                ready = DirectionState.CALL_READY if sign > 0 else DirectionState.PUT_READY
                self._set(ready, now)
                return self._transition("CALL READY" if sign > 0 else "PUT READY", "CALL" if sign > 0 else "PUT", "ENTRY_CONFIRMED", ["ENTRY_CONFIRMED"])
            return self._arming(sign, now, required, ["WAITING_FOR_PERSISTENCE"])

        sign = self._sign(self.state)
        direction = "CALL" if sign > 0 else "PUT"
        display_ready = f"{direction} READY"
        opposite_ready = (
            sign * core <= -self.cfg["flip_threshold"]
            and sign * evidence.futures < 0.0
            and sign * evidence.cash <= 0.20
            and sign * evidence.structure <= 0.20
            and evidence.flow_persistence >= self.cfg["minimum_flow_persistence"]
        )
        if opposite_ready:
            if self.timers.opposite_started is None:
                self.timers.opposite_started = now
            if now - self.timers.opposite_started >= self.cfg["flip_persistence_seconds"]:
                self._set(DirectionState.NO_TRADE, now)
                return self._transition("NO TRADE", "NONE", "CONFIRMED_REVERSAL_NEUTRALIZATION", ["CONFIRMED_REVERSAL_NEUTRALIZATION"])
            return self._transition(f"{direction} HOLD", direction, "OPPOSITE_FLOW_NOT_YET_CONFIRMED", ["OPPOSITE_FLOW_NOT_YET_CONFIRMED"])
        self.timers.opposite_started = None

        if sign * core >= self.cfg["hold_threshold"]:
            self.timers.neutral_started = None
            return self._transition(display_ready, direction, "HOLD_THRESHOLD_MAINTAINED", ["HOLD_THRESHOLD_MAINTAINED"])

        if self.timers.neutral_started is None:
            self.timers.neutral_started = now
        neutral_for = max(0.0, now - self.timers.neutral_started)
        if neutral_for >= self.cfg["neutral_persistence_seconds"]:
            self._set(DirectionState.NO_TRADE, now)
            return self._transition("NO TRADE", "NONE", "PERSISTENT_NEUTRALIZATION", ["PERSISTENT_NEUTRALIZATION"])
        return self._transition(f"{direction} HOLD", direction, "TRANSIENT_COUNTERFLOW", ["TRANSIENT_COUNTERFLOW"])

    def _arming(self, sign: int, now: float, required: float, reasons: list[str]) -> Transition:
        armed = 0.0 if self.timers.arm_started is None else max(0.0, now - self.timers.arm_started)
        transition = self._transition(
            "ARMING CALL" if sign > 0 else "ARMING PUT",
            "CALL" if sign > 0 else "PUT",
            reasons[0] if reasons else "WAITING_FOR_PERSISTENCE",
            reasons,
        )
        transition.armed_seconds = armed
        transition.required_seconds = required
        return transition

    def _transition(self, display: str, direction: str, primary: str, reasons: list[str]) -> Transition:
        return Transition(
            state=self.state,
            display_state=display,
            state_since=self.state_since,
            direction=direction,
            primary_reason=primary,
            reasons=list(dict.fromkeys(reasons)),
        )
