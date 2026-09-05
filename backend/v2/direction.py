from __future__ import annotations

from typing import Any

from .math_utils import clamp, harmonic_mean
from .models import Evidence


def cross_domain_conflicts(
    evidence: Evidence,
    *,
    threshold: float = 0.45,
    options_flow_evidence: float | None = None,
    basis_unstable: bool = False,
    absorption: float | None = None,
    book: float | None = None,
    aggression: float | None = None,
) -> list[str]:
    reasons: list[str] = []
    if evidence.futures * evidence.structure < 0.0 and min(abs(evidence.futures), abs(evidence.structure)) >= threshold:
        reasons.append("FLOW_STRUCTURE_CONFLICT")
    if evidence.futures * evidence.cash < 0.0 and min(abs(evidence.futures), abs(evidence.cash)) >= threshold:
        reasons.append("CASH_FUTURES_CONFLICT")
    if book is not None and aggression is not None and book * aggression < 0.0 and min(abs(book), abs(aggression)) >= threshold:
        reasons.append("BOOK_FLOW_CONFLICT")
    tentative = 0.50 * evidence.futures + 0.20 * evidence.cash + 0.30 * evidence.structure
    if absorption is not None and tentative * absorption < 0.0 and abs(absorption) >= threshold:
        reasons.append("ABSORPTION_AGAINST_SIGNAL")
    if options_flow_evidence is not None and tentative * options_flow_evidence < 0.0 and min(abs(tentative), abs(options_flow_evidence)) >= threshold:
        reasons.append("OPTIONS_FLOW_CONFLICT")
    if basis_unstable:
        reasons.append("BASIS_UNSTABLE")
    return list(dict.fromkeys(reasons))


def directional_core(evidence: Evidence, config: dict[str, Any]) -> float:
    return clamp(
        config["futures_weight"] * evidence.futures
        + config["cash_weight"] * evidence.cash
        + config["structure_weight"] * evidence.structure,
        -1.0,
        1.0,
    )


def agreement_quality(evidence: Evidence, core: float) -> float:
    sign = 1.0 if core > 0.0 else -1.0 if core < 0.0 else 0.0
    if sign == 0.0:
        return 0.0
    components = [clamp((sign * value + 1.0) / 2.0, 0.0, 1.0) for value in (evidence.futures, evidence.cash, evidence.structure)]
    return harmonic_mean(components)


def setup_quality(core: float, flow_persistence: float, agreement: float, candidate_utility: float) -> tuple[float, dict[str, float]]:
    components = {
        "direction_strength": clamp(abs(core), 0.0, 1.0),
        "flow_persistence": clamp(flow_persistence, 0.0, 1.0),
        "agreement_quality": clamp(agreement, 0.0, 1.0),
        "candidate_utility": clamp(candidate_utility, 0.0, 1.0),
    }
    return 100.0 * harmonic_mean(components.values()), components


def setup_archetype(
    *,
    core: float,
    at_support: bool,
    at_resistance: bool,
    local_reclaim: bool,
    local_rejection: bool,
    absorption: float,
    bid_replenishment: float,
    ask_replenishment: float,
) -> str:
    if core > 0.0 and at_support and local_reclaim and absorption > 0.20 and bid_replenishment > 0.20:
        return "SUPPORT_REVERSAL"
    if core < 0.0 and at_resistance and local_rejection and absorption < -0.20 and ask_replenishment > 0.20:
        return "RESISTANCE_REVERSAL"
    return "CONTINUATION"
