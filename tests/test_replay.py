from __future__ import annotations

import json
from datetime import datetime, timezone

from backend.v2.config import load_config, with_overrides
from backend.v2.models import Evidence
from backend.v2.state_machine import DirectionStateMachine


STREAM = [
    (0.0, .70), (.5, .70), (1.0, .70), (1.5, .70),
    (2.0, .25), (2.2, .05), (2.4, -.10), (2.6, .30), (3.0, .65),
    (4.0, .65),
]


def run(config: dict) -> list[dict]:
    machine = DirectionStateMachine(config["markets"]["SPY_1DTE"], config["direction"])
    output = []
    for timestamp, score in STREAM:
        transition = machine.step(
            now=timestamp, core=score,
            evidence=Evidence(score, score, score, .85, .9, 3),
            setup_type="CONTINUATION",
        )
        output.append({"time": timestamp, "state": transition.state.value, "display": transition.display_state,
                       "reason": transition.primary_reason})
    return output


def test_replay_is_deterministic_without_wall_clock() -> None:
    config = load_config()
    assert json.dumps(run(config), sort_keys=True) == json.dumps(run(config), sort_keys=True)


def test_anti_flip_replay_has_no_opposite_ready_transition() -> None:
    displays = [row["display"] for row in run(load_config())]
    assert "PUT READY" not in displays


def test_threshold_sensitivity_is_descriptive_not_pnl() -> None:
    config = load_config()
    report = {}
    paths = (
        "markets.SPY_1DTE.enter_threshold", "markets.SPY_1DTE.hold_threshold",
        "markets.SPY_1DTE.flip_threshold", "markets.SPY_1DTE.entry_persistence_seconds",
        "markets.SPY_1DTE.switch_margin", "structure.path_abstain_threshold",
        "direction.conflict_strength",
    )
    for path in paths:
        node = config
        for part in path.split("."):
            node = node[part]
        report[path] = {
            "minus_20pct": [row["state"] for row in run(with_overrides(config, {path: node * .8}))],
            "plus_20pct": [row["state"] for row in run(with_overrides(config, {path: node * 1.2}))],
        }
    assert set(report) == set(paths)
    assert all("pnl" not in key.lower() for key in report)
