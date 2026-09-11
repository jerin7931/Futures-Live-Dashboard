"""Deterministic, local 0DTE Gamma Read for the Options Dashboard.

This module is presentation context only.  It is not imported by the frozen
model feature engine and never emits CALL/PUT or bullish/bearish direction.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone
from statistics import median
from typing import Any


CONTRACT = "OPTIONS_DASHBOARD_0DTE_GAMMA_READ_V1"
ALLOWED_REGIMES = {
    "STABILIZING", "PINNED", "STABILIZING / PINNED", "GAMMA BOUNDARY",
    "NEGATIVE GAMMA", "ACCELERATION RISK", "MIXED", "DATA STALE",
}


def _finite(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _stamp(value: datetime | str | None) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        parsed = value
    else:
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _age_ms(value: datetime | str | None, now: datetime) -> float | None:
    parsed = _stamp(value)
    return None if parsed is None else max(0.0, (now - parsed).total_seconds() * 1000)


def _clean(surface: dict[float, float] | None) -> dict[float, float]:
    clean: dict[float, float] = {}
    for raw_strike, raw_value in (surface or {}).items():
        strike, value = _finite(raw_strike), _finite(raw_value)
        if strike is not None and value is not None:
            clean[strike] = value
    return dict(sorted(clean.items()))


def _level(value: float | None) -> str:
    if value is None:
        return "—"
    return f"{value:.2f}".rstrip("0").rstrip(".")


def _zone(low: float | None, high: float | None) -> str:
    if low is None and high is None:
        return "—"
    if low is None or high is None or math.isclose(low, high):
        return _level(low if low is not None else high)
    return f"{_level(min(low, high))}–{_level(max(low, high))}"


def _stale(reason: str, *, spot: float | None, current_age_ms: float | None,
           delta_age_ms: float | None, spot_age_ms: float | None,
           current_as_of: datetime | str | None = None,
           delta_as_of: datetime | str | None = None,
           spot_as_of: datetime | str | None = None) -> dict[str, Any]:
    return {
        "contract": CONTRACT, "scope": "0DTE", "regime": "DATA STALE",
        "tone": "stale", "spot": spot, "key_zone": "—", "above": None,
        "below": None, "callouts": [], "read": "Gamma inputs are stale; wait for a fresh read.",
        "data_state": "STALE", "stale_reason": reason,
        "current_gex_age_ms": current_age_ms, "delta_gex_age_ms": delta_age_ms,
        "spot_age_ms": spot_age_ms, "local_balance": None, "local_strikes": [],
        "current_gex_as_of": str(current_as_of) if current_as_of else None,
        "delta_gex_as_of": str(delta_as_of) if delta_as_of else None,
        "spot_as_of": str(spot_as_of) if spot_as_of else None,
    }


def build_gamma_read(current_gex: dict[float, float] | None,
                     delta_gex: dict[float, float] | None, spot: Any, *,
                     current_as_of: datetime | str | None,
                     delta_as_of: datetime | str | None,
                     spot_as_of: datetime | str | None,
                     now: datetime | None = None,
                     gex_stale_seconds: float = 180,
                     spot_stale_seconds: float = 5,
                     scope: str = "0DTE") -> dict[str, Any]:
    """Return a compact normalized read of the nearby 0DTE GEX surface."""
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    current, delta, spot_value = _clean(current_gex), _clean(delta_gex), _finite(spot)
    current_age = _age_ms(current_as_of, now)
    delta_age = _age_ms(delta_as_of, now)
    spot_age = _age_ms(spot_as_of, now)
    stale_args = {"spot": spot_value, "current_age_ms": current_age,
                  "delta_age_ms": delta_age, "spot_age_ms": spot_age,
                  "current_as_of": current_as_of, "delta_as_of": delta_as_of,
                  "spot_as_of": spot_as_of}
    if str(scope).upper() != "0DTE":
        return _stale("NON_0DTE_SCOPE", **stale_args)
    if spot_value is None:
        return _stale("SPOT_UNAVAILABLE", **stale_args)
    if not current:
        return _stale("CURRENT_GEX_UNAVAILABLE", **stale_args)
    if not delta:
        return _stale("INTRADAY_DELTA_GEX_UNAVAILABLE", **stale_args)
    if current_age is None or current_age > gex_stale_seconds * 1000:
        return _stale("CURRENT_GEX_STALE", **stale_args)
    if delta_age is None or delta_age > gex_stale_seconds * 1000:
        return _stale("INTRADAY_DELTA_GEX_STALE", **stale_args)
    if spot_age is None or spot_age > spot_stale_seconds * 1000:
        return _stale("SPOT_STALE", **stale_args)

    strikes = sorted(current)
    differences = [right-left for left, right in zip(strikes, strikes[1:]) if right > left]
    spacing = median(differences) if differences else max(1.0, spot_value * .001)
    radius = max(spacing * 6, spot_value * .008)
    local_strikes = [strike for strike in strikes if abs(strike-spot_value) <= radius]
    if len(local_strikes) < min(5, len(strikes)):
        local_strikes = sorted(strikes, key=lambda strike: (abs(strike-spot_value), strike))[:min(13, len(strikes))]
    elif len(local_strikes) > 13:
        local_strikes = sorted(local_strikes, key=lambda strike: (abs(strike-spot_value), strike))[:13]
    local_strikes = sorted(local_strikes)
    total_abs = sum(abs(current[strike]) for strike in local_strikes)
    total_delta_abs = sum(abs(delta.get(strike, 0.0)) for strike in local_strikes)
    if total_abs <= 1e-12:
        return _stale("CURRENT_GEX_ZERO_MASS", **stale_args)

    rows = []
    for strike in local_strikes:
        value, change = current[strike], delta.get(strike, 0.0)
        current_share = abs(value) / total_abs
        delta_share = abs(change) / max(total_delta_abs, 1e-12)
        proximity = 1 / (1 + abs(strike-spot_value) / max(spacing, 1e-12))
        rows.append({
            "strike": strike, "current_gex": value, "delta_gex": change,
            "current_share": current_share, "delta_share": delta_share,
            "proximity": proximity,
            "priority": proximity * (.8 * current_share + .2 * delta_share),
        })

    current_balance = sum(row["current_gex"] for row in rows) / total_abs
    delta_balance = sum(row["delta_gex"] for row in rows) / max(total_delta_abs, 1e-12)
    concentration = max(row["current_share"] for row in rows)
    meaningful = [row for row in rows if row["current_share"] >= max(.09, concentration * .35)]
    below = [row for row in meaningful if row["strike"] <= spot_value]
    above = [row for row in meaningful if row["strike"] >= spot_value]
    nearest_band = max(spacing * 1.25, spot_value * .0015)
    near = [row for row in rows if abs(row["strike"]-spot_value) <= nearest_band]
    near_positive = sum(row["current_share"] for row in near if row["current_gex"] > 0)
    near_negative = sum(row["current_share"] for row in near if row["current_gex"] < 0)
    near_delta_positive = sum(row["delta_share"] for row in near if row["delta_gex"] > 0)
    near_delta_negative = sum(row["delta_share"] for row in near if row["delta_gex"] < 0)

    pair_candidates = []
    for lower in below:
        for upper in above:
            if lower["strike"] > upper["strike"] or lower["current_gex"] * upper["current_gex"] >= 0:
                continue
            ratio = min(abs(lower["current_gex"]), abs(upper["current_gex"])) / max(abs(lower["current_gex"]), abs(upper["current_gex"]))
            width = upper["strike"] - lower["strike"]
            significant_pair = (lower["current_share"] >= max(.15, concentration * .60)
                                and upper["current_share"] >= max(.15, concentration * .60))
            if significant_pair and ratio >= .35 and width <= max(spacing * 4, spot_value * .006):
                pair_candidates.append((width, -(lower["priority"]+upper["priority"]), lower, upper))
    boundary = min(pair_candidates, default=None, key=lambda item: (item[0], item[1]))

    pin_candidates = [row for row in rows if abs(row["strike"]-spot_value) <= max(spacing*.45, spot_value*.0007)
                      and row["current_gex"] > 0
                      and (row["current_share"] >= .13 or row["delta_share"] >= .18)]
    pin = max(pin_candidates, default=None, key=lambda row: (row["priority"], -abs(row["strike"]-spot_value)))
    stabilizing = current_balance >= .22 or (delta_balance >= .30 and current_balance > -.15 and near_delta_positive > near_delta_negative)
    accelerating = ((current_balance <= -.55 and near_negative >= .15)
                    or (near_negative >= .40 and near_delta_negative > near_delta_positive * 1.25))
    negative = current_balance <= -.22 and near_negative > near_positive * 1.25

    if boundary:
        regime = "GAMMA BOUNDARY"
    elif accelerating:
        regime = "ACCELERATION RISK"
    elif negative:
        regime = "NEGATIVE GAMMA"
    elif pin and stabilizing:
        regime = "STABILIZING / PINNED"
    elif pin:
        regime = "PINNED"
    elif stabilizing:
        regime = "STABILIZING"
    else:
        regime = "MIXED"

    lower_zone = max((strike for strike in local_strikes if strike <= spot_value), default=local_strikes[0])
    upper_zone = min((strike for strike in local_strikes if strike >= spot_value), default=local_strikes[-1])
    if boundary:
        lower_zone, upper_zone = boundary[2]["strike"], boundary[3]["strike"]
    key_zone = _zone(lower_zone, upper_zone)

    def primary(candidates: list[dict[str, float]], direction: str) -> dict[str, Any] | None:
        if not candidates:
            return None
        chosen = max(candidates, key=lambda row: (row["priority"], -abs(row["strike"]-spot_value), -row["strike"]))
        positive = chosen["current_gex"] > 0
        if positive:
            label = "STABILIZING" if direction == "above" and regime == "GAMMA BOUNDARY" else "DAMPENING"
        else:
            label = "ACCELERATION" if regime in {"GAMMA BOUNDARY", "ACCELERATION RISK"} else "NEGATIVE GAMMA"
        return {"level": _level(chosen["strike"]), "strike": chosen["strike"],
                "label": label, "current_sign": "POSITIVE" if positive else "NEGATIVE",
                "current_share": chosen["current_share"], "delta_gex": chosen["delta_gex"]}

    above_read = primary([row for row in meaningful if row["strike"] > spot_value], "above")
    below_read = primary([row for row in meaningful if row["strike"] < spot_value], "below")
    positive_rows = [row for row in rows if row["current_gex"] > 0]
    negative_rows = [row for row in rows if row["current_gex"] < 0]
    strongest_positive = max(positive_rows, default=None, key=lambda row: row["priority"])
    strongest_negative = max(negative_rows, default=None, key=lambda row: row["priority"])
    callouts: list[dict[str, str]] = []
    if pin:
        callouts.append({"label": "PIN", "level": _level(pin["strike"])})
    if strongest_negative:
        callouts.append({"label": "RISK" if regime in {"NEGATIVE GAMMA", "ACCELERATION RISK"} else "-GEX",
                         "level": _level(strongest_negative["strike"])})
    if not pin and strongest_positive:
        callouts.insert(0, {"label": "+GEX", "level": _level(strongest_positive["strike"])})
    callouts = callouts[:2]

    reference = (below_read or above_read or {"level": key_zone})["level"]
    pin_level = _level(pin["strike"]) if pin else key_zone
    reads = {
        "STABILIZING": f"Avoid chasing while price remains inside {key_zone}.",
        "PINNED": f"Price is near a gamma pin at {pin_level}.",
        "STABILIZING / PINNED": f"Avoid chasing near the {pin_level} gamma pin.",
        "GAMMA BOUNDARY": f"Wait inside {key_zone}; break defines the gamma regime.",
        "NEGATIVE GAMMA": f"Near {reference}, movement may become less damped.",
        "ACCELERATION RISK": f"Near {reference}, acceleration risk rises if price accepts through.",
        "MIXED": "Gamma structure is mixed; wait for cleaner separation.",
    }
    nearest = min(rows, key=lambda row: (abs(row["strike"]-spot_value), row["strike"]))
    if nearest["current_gex"] < 0 and nearest["delta_gex"] > 0:
        distinction = "Current GEX remains negative; positive intraday ΔGEX is shifting more stabilizing."
    elif nearest["current_gex"] > 0 and nearest["delta_gex"] < 0:
        distinction = "Current GEX remains positive; negative intraday ΔGEX is reducing stabilization."
    else:
        distinction = "Current GEX is the level state; intraday ΔGEX is change since the RTH baseline."
    tone = ("positive" if regime in {"STABILIZING", "PINNED", "STABILIZING / PINNED"}
            else "caution" if regime == "GAMMA BOUNDARY" else "negative"
            if regime in {"NEGATIVE GAMMA", "ACCELERATION RISK"} else "neutral")
    return {
        "contract": CONTRACT, "scope": "0DTE", "regime": regime, "tone": tone,
        "spot": spot_value, "key_zone": key_zone, "above": above_read, "below": below_read,
        "callouts": callouts, "read": reads[regime], "data_state": "LIVE", "stale_reason": None,
        "current_gex_age_ms": current_age, "delta_gex_age_ms": delta_age, "spot_age_ms": spot_age,
        "current_gex_as_of": str(current_as_of) if current_as_of else None,
        "delta_gex_as_of": str(delta_as_of) if delta_as_of else None,
        "spot_as_of": str(spot_as_of) if spot_as_of else None,
        "local_balance": max(-1.0, min(1.0, current_balance)),
        "local_delta_balance": max(-1.0, min(1.0, delta_balance)),
        "local_strikes": local_strikes, "nearest_strike": nearest["strike"],
        "nearest_current_sign": "POSITIVE" if nearest["current_gex"] > 0 else "NEGATIVE" if nearest["current_gex"] < 0 else "NEUTRAL",
        "nearest_delta_sign": "POSITIVE" if nearest["delta_gex"] > 0 else "NEGATIVE" if nearest["delta_gex"] < 0 else "NEUTRAL",
        "strongest_positive_current": strongest_positive,
        "strongest_negative_current": strongest_negative,
        "current_vs_delta_read": distinction,
    }
