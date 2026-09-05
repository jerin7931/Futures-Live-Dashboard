from __future__ import annotations

import random
from dataclasses import replace

from backend.v2.models import QuoteState
from backend.v2.options import (
    ContractSelector, QuoteHysteresis, candidate_utility, delta_preference,
    normalize_iv, quote_quality, rank_candidates, validate_candidate,
)


def test_iv_units() -> None:
    assert normalize_iv(0.18) == 0.18
    assert normalize_iv(18) == 0.18


def test_delta_preference_shape() -> None:
    assert delta_preference(0.65) == 1.0
    assert delta_preference(0.60) == 0.5
    assert delta_preference(-0.70) == 0.5


def test_wider_spread_never_improves_quality(candidate, now_utc) -> None:
    tight = quote_quality(candidate, 0.1, 0.20, 3.0)
    wide = quote_quality(replace(candidate, bid=4.0), 0.1, 0.20, 3.0)
    assert wide <= tight


def test_older_quote_never_improves_quality(candidate) -> None:
    assert quote_quality(candidate, 2.0, 0.20, 3.0) <= quote_quality(candidate, 0.1, 0.20, 3.0)


def test_chain_order_invariance(candidate) -> None:
    rows = []
    for index, utility in enumerate((0.72, 0.81, 0.77)):
        row = replace(candidate, strike=767 + index, option_symbol=f"OPT{index}", ask=4.5 + index * 0.05, bid=4.4 + index * 0.05)
        row.utility = utility
        rows.append(row)
    expected = rank_candidates(rows, {row.option_symbol: 0.005 for row in rows})[0].option_symbol
    for seed in range(25):
        shuffled = rows[:]
        random.Random(seed).shuffle(shuffled)
        assert rank_candidates(shuffled, {row.option_symbol: 0.005 for row in rows})[0].option_symbol == expected


def test_irrelevant_bad_row_does_not_block(candidate, now_utc) -> None:
    bad = replace(candidate, option_type="PUT", option_symbol="BAD", bid=5.0, ask=4.0, delta=-0.65)
    assert validate_candidate(candidate, now_utc=now_utc, seconds_to_expiration=86400,
                              minimum_minutes_to_expiration=120, quote_stale_seconds=3) == []
    assert validate_candidate(bad, now_utc=now_utc, seconds_to_expiration=86400,
                              minimum_minutes_to_expiration=120, quote_stale_seconds=3)


def test_unsigned_utility_cannot_change_direction(candidate) -> None:
    candidate.utility = candidate_utility(candidate)
    assert candidate.option_type == "CALL"
    assert 0.0 <= candidate.utility <= 1.0


def test_quote_hysteresis_ignores_one_wide_snapshot() -> None:
    state = QuoteHysteresis()
    assert state.update(now=0, hard_invalid=False, wide=False, degraded_seconds=1, invalid_seconds=2) == QuoteState.GOOD
    assert state.update(now=0.1, hard_invalid=False, wide=True, degraded_seconds=1, invalid_seconds=2) == QuoteState.GOOD
    assert state.update(now=1.2, hard_invalid=False, wide=True, degraded_seconds=1, invalid_seconds=2) == QuoteState.DEGRADED


def test_contract_hysteresis(candidate) -> None:
    current = replace(candidate, option_symbol="CURRENT"); current.utility = 0.70
    challenger = replace(candidate, option_symbol="NEW", strike=769); challenger.utility = 0.79
    selector = ContractSelector()
    assert selector.choose([current], now=0, switch_margin=0.08, switch_persistence=2).option_symbol == "CURRENT"
    assert selector.choose([challenger, current], now=1, switch_margin=0.08, switch_persistence=2).option_symbol == "CURRENT"
    assert selector.choose([challenger, current], now=2.9, switch_margin=0.08, switch_persistence=2).option_symbol == "CURRENT"
    assert selector.choose([challenger, current], now=3.1, switch_margin=0.08, switch_persistence=2).option_symbol == "NEW"


def test_contract_immediate_switch_when_current_invalid(candidate) -> None:
    first = replace(candidate, option_symbol="A"); first.utility = 0.8
    second = replace(candidate, option_symbol="B"); second.utility = 0.5
    selector = ContractSelector(); selector.choose([first], now=0, switch_margin=0.08, switch_persistence=2)
    assert selector.choose([second], now=0.1, switch_margin=0.08, switch_persistence=2).option_symbol == "B"
