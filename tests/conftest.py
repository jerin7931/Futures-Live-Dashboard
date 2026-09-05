from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timezone

import pytest

from backend.v2.models import Candidate


@pytest.fixture
def now_utc() -> datetime:
    return datetime(2026, 9, 8, 15, 0, tzinfo=timezone.utc)


@pytest.fixture
def candidate(now_utc: datetime) -> Candidate:
    return Candidate(
        symbol="SPY", expiration="2026-09-09", option_type="CALL", strike=768.0,
        option_symbol="SPY260909C00768000", bid=4.40, ask=4.50, last=4.45,
        bid_size=20, ask_size=18, volume=5000, open_interest=10000,
        delta=0.65, gamma=0.04, iv=0.20, quote_time=now_utc.isoformat(),
        greeks_time=now_utc.isoformat(), spot_at_greeks=770.0,
        quote_quality=0.9, liquidity=0.9, surface_consistency=0.9,
        scenario_resilience=0.9, path_clearance=0.9, delta_preference=1.0,
    )


@pytest.fixture
def clone_candidate():
    return replace
