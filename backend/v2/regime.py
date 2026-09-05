from __future__ import annotations

import math
from datetime import date, datetime, time, timezone
from zoneinfo import ZoneInfo


NEW_YORK = ZoneInfo("America/New_York")
CHICAGO = ZoneInfo("America/Chicago")


def expiration_timestamp(expiration: str | date) -> datetime:
    day = date.fromisoformat(expiration) if isinstance(expiration, str) else expiration
    # SPY/QQQ options normally stop trading at 16:15 ET; use the actual
    # configured product timestamp rather than an integer DTE label.
    return datetime.combine(day, time(16, 15), tzinfo=NEW_YORK).astimezone(timezone.utc)


def minutes_to_expiration(expiration_utc: datetime, now_utc: datetime) -> float:
    return max(0.0, (expiration_utc.astimezone(timezone.utc) - now_utc.astimezone(timezone.utc)).total_seconds() / 60.0)


def session_phase(now_utc: datetime) -> str:
    local = now_utc.astimezone(NEW_YORK)
    minute = local.hour * 60 + local.minute
    if minute < 9 * 60 + 30 or minute >= 16 * 60 + 15:
        return "CLOSED"
    if minute < 9 * 60 + 45:
        return "OPEN_TRANSITION"
    if minute < 11 * 60 + 30:
        return "MORNING"
    if minute < 14 * 60:
        return "MIDDAY"
    if minute < 15 * 60:
        return "AFTERNOON"
    if minute < 16 * 60:
        return "POWER_HOUR"
    return "FINAL_WINDOW"


def market_is_open(now_utc: datetime) -> bool:
    local = now_utc.astimezone(NEW_YORK)
    return local.weekday() < 5 and session_phase(now_utc) != "CLOSED"


def realized_vol_regime(clock_returns: list[float]) -> str:
    clean = [abs(float(value)) for value in clock_returns if value is not None and math.isfinite(float(value))]
    if not clean:
        return "UNKNOWN"
    mean_abs = sum(clean) / len(clean)
    if mean_abs < 0.00035:
        return "LOW"
    if mean_abs > 0.0015:
        return "HIGH"
    return "NORMAL"


def regime_adjustments(market_key: str, phase: str, vol_regime: str) -> dict[str, float]:
    # Deterministic safety multipliers only; never fitted to outcomes.
    persistence = 1.0
    threshold = 1.0
    spread = 1.0
    if "0DTE" in market_key:
        persistence *= 1.15
        threshold *= 1.08
    if phase in {"OPEN_TRANSITION", "FINAL_WINDOW"}:
        persistence *= 1.20
        threshold *= 1.08
        spread *= 1.25
    elif phase == "MIDDAY":
        persistence *= 1.08
    if vol_regime == "HIGH":
        persistence *= 1.10
        spread *= 1.25
    return {"persistence_multiplier": persistence, "threshold_multiplier": threshold, "future_spread_multiplier": spread}
