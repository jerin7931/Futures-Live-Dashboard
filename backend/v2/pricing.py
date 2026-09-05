from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from .math_utils import clamp, harmonic_mean


SECONDS_PER_YEAR = 365.0 * 24.0 * 60.0 * 60.0


def _cdf(value: float) -> float:
    return 0.5 * (1.0 + math.erf(value / math.sqrt(2.0)))


def intrinsic(option_type: str, spot: float, strike: float) -> float:
    return max(spot - strike, 0.0) if option_type.upper() == "CALL" else max(strike - spot, 0.0)


def black_scholes_merton(option_type: str, spot: float, strike: float, t_years: float, rate: float, dividend: float, sigma: float) -> float:
    if min(spot, strike) <= 0.0:
        return 0.0
    if t_years <= 0.0 or sigma <= 0.0:
        return intrinsic(option_type, spot, strike)
    root_t = math.sqrt(t_years)
    d1 = (math.log(spot / strike) + (rate - dividend + 0.5 * sigma * sigma) * t_years) / (sigma * root_t)
    d2 = d1 - sigma * root_t
    if option_type.upper() == "CALL":
        price = spot * math.exp(-dividend * t_years) * _cdf(d1) - strike * math.exp(-rate * t_years) * _cdf(d2)
    else:
        price = strike * math.exp(-rate * t_years) * _cdf(-d2) - spot * math.exp(-dividend * t_years) * _cdf(-d1)
    return max(price, intrinsic(option_type, spot, strike), 0.0)


def bsm_greeks(option_type: str, spot: float, strike: float, t_years: float, rate: float, dividend: float, sigma: float) -> tuple[float, float]:
    if min(spot, strike, t_years, sigma) <= 0.0:
        terminal_delta = 1.0 if option_type.upper() == "CALL" and spot > strike else -1.0 if option_type.upper() == "PUT" and spot < strike else 0.0
        return terminal_delta, 0.0
    root_t = math.sqrt(t_years)
    d1 = (math.log(spot / strike) + (rate - dividend + 0.5 * sigma * sigma) * t_years) / (sigma * root_t)
    normal_pdf = math.exp(-0.5 * d1 * d1) / math.sqrt(2.0 * math.pi)
    call_delta = math.exp(-dividend * t_years) * _cdf(d1)
    delta = call_delta if option_type.upper() == "CALL" else call_delta - math.exp(-dividend * t_years)
    gamma = math.exp(-dividend * t_years) * normal_pdf / (spot * sigma * root_t)
    return delta, max(gamma, 0.0)


def crr_american(option_type: str, spot: float, strike: float, t_years: float, rate: float, dividend: float, sigma: float, steps: int = 100) -> float:
    if t_years <= 0.0 or sigma <= 0.0 or min(spot, strike) <= 0.0:
        return intrinsic(option_type, spot, strike)
    steps = max(2, int(steps))
    dt = t_years / steps
    up = math.exp(sigma * math.sqrt(dt))
    down = 1.0 / up
    growth = math.exp((rate - dividend) * dt)
    probability = clamp((growth - down) / max(up - down, 1e-12), 0.0, 1.0)
    discount = math.exp(-rate * dt)
    values = [intrinsic(option_type, spot * (up ** j) * (down ** (steps - j)), strike) for j in range(steps + 1)]
    for level in range(steps - 1, -1, -1):
        for j in range(level + 1):
            node_spot = spot * (up ** j) * (down ** (level - j))
            continuation = discount * (probability * values[j + 1] + (1.0 - probability) * values[j])
            values[j] = max(continuation, intrinsic(option_type, node_spot, strike))
    return max(values[0], intrinsic(option_type, spot, strike), 0.0)


def price_option(
    option_type: str,
    spot: float,
    strike: float,
    t_years: float,
    rate: float,
    dividend: float,
    sigma: float,
    *,
    american: bool = True,
    early_exercise_material: bool = False,
) -> float:
    if american and early_exercise_material:
        return crr_american(option_type, spot, strike, t_years, rate, dividend, sigma)
    return black_scholes_merton(option_type, spot, strike, t_years, rate, dividend, sigma)


@dataclass(frozen=True)
class ScenarioInput:
    option_type: str
    spot: float
    strike: float
    seconds_to_expiration: float
    iv: float
    bid: float
    ask: float
    rate: float = 0.04
    dividend: float = 0.012
    profit_objective: float = 0.30
    future_spread_multiplier: float = 1.25
    maximum_root_move_pct: float = 0.03
    bisection_tolerance: float = 1e-6
    minimum_iv: float = 0.01
    early_exercise_material: bool = False


def estimated_exit_bid(theoretical_value: float, current_spread: float, multiplier: float) -> float:
    return max(theoretical_value - 0.5 * max(current_spread, 0.0) * max(multiplier, 1.0), 0.0)


def solve_required_move(data: ScenarioInput, elapsed_minutes: float, iv_shock: float, spread_multiplier: float = 1.0) -> dict[str, Any]:
    entry = data.ask
    target = round(entry * (1.0 + data.profit_objective), 10)
    remaining = max(data.seconds_to_expiration - elapsed_minutes * 60.0, 0.0) / SECONDS_PER_YEAR
    sigma = max(data.minimum_iv, data.iv * (1.0 + iv_shock))
    current_spread = max(data.ask - data.bid, 0.0)
    multiplier = data.future_spread_multiplier * max(spread_multiplier, 1.0)
    sign = 1.0 if data.option_type.upper() == "CALL" else -1.0

    def exit_bid(move_pct: float) -> float:
        scenario_spot = data.spot * (1.0 + sign * move_pct)
        theoretical = price_option(
            data.option_type, scenario_spot, data.strike, remaining, data.rate, data.dividend, sigma,
            early_exercise_material=data.early_exercise_material,
        )
        return estimated_exit_bid(theoretical, current_spread, multiplier)

    low, high = 0.0, data.maximum_root_move_pct
    if exit_bid(high) + 1e-12 < target:
        return {
            "status": "NO_ROOT_WITHIN_RANGE",
            "elapsed_minutes": elapsed_minutes,
            "iv_shock": iv_shock,
            "required_move_pct": None,
            "required_underlying_price": None,
            "target_exit_price": target,
        }
    for _ in range(80):
        middle = (low + high) / 2.0
        if exit_bid(middle) >= target:
            high = middle
        else:
            low = middle
        if high - low <= data.bisection_tolerance:
            break
    required = high
    target_spot = data.spot * (1.0 + sign * required)
    achieved_bid = exit_bid(required)
    return {
        "status": "ROOT_FOUND",
        "elapsed_minutes": elapsed_minutes,
        "iv_shock": iv_shock,
        "required_move_pct": required,
        "required_underlying_price": target_spot,
        "estimated_exit_bid": achieved_bid,
        "scenario_return": achieved_bid / entry - 1.0 if entry > 0.0 else None,
        "target_exit_price": target,
    }


def scenario_grid(data: ScenarioInput, elapsed_minutes: list[int], iv_shocks: list[float], late_tte_multiplier: float = 1.5) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    for elapsed in elapsed_minutes:
        for shock in iv_shocks:
            late = data.seconds_to_expiration - elapsed * 60.0 <= 60.0 * 60.0
            rows.append(solve_required_move(data, elapsed, shock, late_tte_multiplier if late else 1.0))
    current_theoretical = price_option(
        data.option_type,
        data.spot,
        data.strike,
        data.seconds_to_expiration / SECONDS_PER_YEAR,
        data.rate,
        data.dividend,
        data.iv,
        early_exercise_material=data.early_exercise_material,
    )
    mid = (data.bid + data.ask) / 2.0
    residual = (current_theoretical - mid) / mid if mid > 0.0 else None
    resilience_rows = [row for row in rows if row["elapsed_minutes"] in elapsed_minutes[: min(4, len(elapsed_minutes))] and row["iv_shock"] in {-0.10, 0.0}]
    resilience_parts = [
        0.0 if row["required_move_pct"] is None else clamp(1.0 - row["required_move_pct"] / data.maximum_root_move_pct, 0.0, 1.0)
        for row in resilience_rows
    ]
    return {
        "entry_price": data.ask,
        "entry_basis": "CURRENT_WEBULL_ASK",
        "target_exit_price": round(data.ask * (1.0 + data.profit_objective), 10),
        "exit_basis": "THEORETICAL_VALUE_MINUS_HALF_CONSERVATIVE_FUTURE_SPREAD",
        "seconds_to_expiration": data.seconds_to_expiration,
        "current_theoretical_value": current_theoretical,
        "current_model_residual": residual,
        "scenario_resilience": harmonic_mean(resilience_parts),
        "rows": rows,
    }
