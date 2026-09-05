from __future__ import annotations

import math

from backend.v2.config import load_config
from backend.v2.direction import cross_domain_conflicts, directional_core, setup_quality
from backend.v2.models import Evidence


def test_direction_only_uses_directional_domains() -> None:
    config = load_config()["direction"]
    evidence = Evidence(.8, .4, .2, .9)
    assert math.isclose(directional_core(evidence, config), .5 * .8 + .2 * .4 + .3 * .2)


def test_conflict_detection_sign_symmetric() -> None:
    bullish = cross_domain_conflicts(Evidence(.7, .1, -.7, .8))
    bearish = cross_domain_conflicts(Evidence(-.7, -.1, .7, .8))
    assert bullish == bearish == ["FLOW_STRUCTURE_CONFLICT"]


def test_conflict_never_strengthens_negative_score() -> None:
    # Conflicts are reason-coded abstentions, not score subtraction.
    config = load_config()["direction"]
    evidence = Evidence(-.6, -.4, -.2, .8)
    before = directional_core(evidence, config)
    cross_domain_conflicts(evidence)
    after = directional_core(evidence, config)
    assert before == after < 0


def test_setup_quality_bounds_and_semantics() -> None:
    value, components = setup_quality(.6, .7, .8, .9)
    assert 0 <= value <= 100
    assert set(components) == {"direction_strength", "flow_persistence", "agreement_quality", "candidate_utility"}


def test_zero_candidate_utility_collapses_setup_quality() -> None:
    value, _ = setup_quality(.9, .9, .9, 0.0)
    assert value == 0.0
