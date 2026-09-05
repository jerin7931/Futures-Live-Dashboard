from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from typing import Any


@dataclass
class StabilityMetrics:
    started_at: float
    last_state: str | None = None
    last_direction: str = "NONE"
    ready_since: float | None = None
    ready_durations: list[float] = field(default_factory=list)
    direction_flips: int = 0
    ready_opposite_transitions: int = 0
    failed_arming_attempts: int = 0
    contract_switches: int = 0
    last_contract: str | None = None
    reasons: Counter[str] = field(default_factory=Counter)

    def observe(self, signal: dict[str, Any], now: float) -> None:
        state = str(signal.get("state") or "")
        direction = str(signal.get("direction") or "NONE")
        contract = (signal.get("option") or {}).get("symbol")
        if self.last_state and self.last_state.startswith("ARMING") and not state.startswith("ARMING") and "READY" not in state:
            self.failed_arming_attempts += 1
        if self.last_direction in {"CALL", "PUT"} and direction in {"CALL", "PUT"} and direction != self.last_direction:
            self.direction_flips += 1
            if self.last_state.endswith("READY") and state.endswith("READY"):
                self.ready_opposite_transitions += 1
        if state.endswith("READY") and self.ready_since is None:
            self.ready_since = now
        elif not state.endswith("READY") and self.ready_since is not None:
            self.ready_durations.append(max(0.0, now - self.ready_since))
            self.ready_since = None
        if contract and self.last_contract and contract != self.last_contract:
            self.contract_switches += 1
        if contract:
            self.last_contract = contract
        reason = signal.get("primary_reason")
        if reason:
            self.reasons[str(reason)] += 1
        self.last_state, self.last_direction = state, direction

    def snapshot(self, now: float) -> dict[str, Any]:
        hours = max((now - self.started_at) / 3600.0, 1e-9)
        durations = list(self.ready_durations)
        if self.ready_since is not None:
            durations.append(max(0.0, now - self.ready_since))
        return {
            "observation_seconds": max(0.0, now - self.started_at),
            "direction_flips_per_hour": self.direction_flips / hours,
            "ready_to_opposite_ready": self.ready_opposite_transitions,
            "average_ready_duration_seconds": sum(durations) / len(durations) if durations else 0.0,
            "failed_arming_attempts": self.failed_arming_attempts,
            "contract_switches_per_hour": self.contract_switches / hours,
            "dominant_reasons": self.reasons.most_common(5),
        }
