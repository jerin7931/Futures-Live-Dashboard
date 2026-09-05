from __future__ import annotations

from backend.v2.config import load_config
from backend.v2.models import DirectionState, Evidence
from backend.v2.state_machine import DirectionStateMachine


def ev(value: float, persistence: float = 0.9, cash: float | None = None, structure: float | None = None) -> Evidence:
    return Evidence(value, value if cash is None else cash, value if structure is None else structure, persistence, 0.9, 3.0)


def machine() -> DirectionStateMachine:
    config = load_config()
    return DirectionStateMachine(config["markets"]["SPY_1DTE"], config["direction"])


def arm_ready(m: DirectionStateMachine, sign: int = 1) -> None:
    for index in range(17):
        m.step(now=index * 0.1, core=sign * 0.7, evidence=ev(sign * 0.7), setup_type="CONTINUATION")
    assert m.state == (DirectionState.CALL_READY if sign > 0 else DirectionState.PUT_READY)


def test_enter_threshold_required() -> None:
    m = machine()
    result = m.step(now=0, core=0.41, evidence=ev(0.8))
    assert result.state == DirectionState.NO_TRADE


def test_hold_threshold_preserves_ready() -> None:
    m = machine(); arm_ready(m)
    assert m.step(now=2.0, core=0.20, evidence=ev(0.2)).display_state == "CALL READY"


def test_zero_crossing_does_not_flip() -> None:
    m = machine(); arm_ready(m)
    result = m.step(now=2.0, core=-0.05, evidence=ev(-0.05))
    assert result.display_state == "CALL HOLD"
    assert m.state == DirectionState.CALL_READY


def test_explicit_anti_flip_sequence() -> None:
    m = machine(); arm_ready(m)
    states = []
    for index, score in enumerate((0.25, 0.10, -0.08, -0.12, 0.30, 0.55), start=20):
        states.append(m.step(now=index * 0.1, core=score, evidence=ev(score), setup_type="CONTINUATION").display_state)
    assert "PUT READY" not in states
    assert m.state == DirectionState.CALL_READY


def test_prolonged_neutral_exits() -> None:
    m = machine(); arm_ready(m)
    m.step(now=2.0, core=0.0, evidence=ev(0.0))
    result = m.step(now=4.1, core=0.0, evidence=ev(0.0))
    assert result.state == DirectionState.NO_TRADE


def test_ordinary_reversal_neutralizes_before_opposite_ready() -> None:
    m = machine(); arm_ready(m)
    states = []
    for index in range(21, 43):
        result = m.step(now=index * 0.1, core=-0.7, evidence=ev(-0.7))
        states.append(result.state)
    assert DirectionState.NO_TRADE in states
    first_no_trade = states.index(DirectionState.NO_TRADE)
    assert DirectionState.PUT_READY not in states[: first_no_trade + 1]


def test_hard_veto_immediate() -> None:
    m = machine(); arm_ready(m)
    result = m.step(now=2.0, core=0.7, evidence=ev(0.7), hard_vetoes=["FUTURES_STALE"])
    assert result.state == DirectionState.BLOCKED


def test_transient_conflict_abstains_without_erasing_ready_memory() -> None:
    m = machine(); arm_ready(m)
    result = m.step(now=2.0, core=0.7, evidence=ev(0.7), conflicts=["FLOW_STRUCTURE_CONFLICT"])
    assert result.display_state == "ABSTAIN"
    assert m.state == DirectionState.CALL_READY


def test_support_reversal_requires_higher_confirmation() -> None:
    m = machine()
    result = m.step(now=0.0, core=0.7, evidence=ev(0.54, cash=0.7, structure=0.7), setup_type="SUPPORT_REVERSAL")
    assert "FUTURES_CONFIRMATION" in result.reasons


def test_resistance_reversal_is_symmetric() -> None:
    m = machine()
    result = m.step(now=0.0, core=-0.7, evidence=ev(-0.7, cash=-0.7, structure=-0.7), setup_type="RESISTANCE_REVERSAL")
    assert result.state == DirectionState.ARMING_PUT
