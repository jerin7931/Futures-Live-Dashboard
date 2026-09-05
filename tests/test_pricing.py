from __future__ import annotations

from backend.v2.pricing import (
    ScenarioInput, black_scholes_merton, crr_american, intrinsic, scenario_grid, solve_required_move,
)


def base(option_type: str = "CALL") -> ScenarioInput:
    return ScenarioInput(option_type, 770, 768 if option_type == "CALL" else 772, 86400, .20, 4.4, 4.5)


def test_call_favorable_move_monotonic() -> None:
    a = black_scholes_merton("CALL", 770, 768, 1 / 365, .04, .012, .2)
    b = black_scholes_merton("CALL", 772, 768, 1 / 365, .04, .012, .2)
    assert b >= a


def test_put_favorable_move_monotonic() -> None:
    a = black_scholes_merton("PUT", 770, 772, 1 / 365, .04, .012, .2)
    b = black_scholes_merton("PUT", 768, 772, 1 / 365, .04, .012, .2)
    assert b >= a


def test_option_values_nonnegative_and_above_intrinsic() -> None:
    for side in ("CALL", "PUT"):
        value = crr_american(side, 770, 770, 1 / 365, .04, .012, .2)
        assert value >= intrinsic(side, 770, 770)
        assert value >= 0


def test_entry_uses_ask_and_target_130_percent() -> None:
    grid = scenario_grid(base(), [0, 5], [-.1, 0])
    assert grid["entry_price"] == 4.5
    assert grid["target_exit_price"] == 5.85
    assert grid["entry_basis"] == "CURRENT_WEBULL_ASK"


def test_bisection_tolerance() -> None:
    result = solve_required_move(base(), 0, 0)
    assert result["status"] == "ROOT_FOUND"
    assert 0 <= result["required_move_pct"] <= .03
    assert result["scenario_return"] >= .30 - 1e-6


def test_no_root() -> None:
    data = ScenarioInput("CALL", 770, 900, 300, .01, .01, 10.0, maximum_root_move_pct=.001)
    assert solve_required_move(data, 0, -.25)["status"] == "NO_ROOT_WITHIN_RANGE"


def test_actual_tte_changes_scenario() -> None:
    short = solve_required_move(ScenarioInput("CALL", 770, 768, 3600, .2, 4.4, 4.5), 0, 0)
    long = solve_required_move(base(), 0, 0)
    assert short["required_move_pct"] != long["required_move_pct"]


def test_iv_shock_uses_decimal_iv() -> None:
    crush = solve_required_move(base(), 0, -.25)
    rise = solve_required_move(base(), 0, .25)
    assert crush["required_move_pct"] >= rise["required_move_pct"]


def test_model_residual_is_reported() -> None:
    assert "current_model_residual" in scenario_grid(base(), [0], [0])
