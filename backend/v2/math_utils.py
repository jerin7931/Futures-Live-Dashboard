from __future__ import annotations

import hashlib
import json
import math
import statistics
from datetime import datetime, timezone
from typing import Any, Iterable


EPSILON = 1e-12


def clamp(value: float, low: float, high: float) -> float:
    if not math.isfinite(value):
        # Signed features fail neutral and [0, 1] qualities fail to zero.
        # Returning ``low`` would turn NaN into a bearish -1.
        return 0.0 if low <= 0.0 <= high else low
    return low if value < low else high if value > high else value


def finite(value: Any, default: float | None = None) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return parsed if math.isfinite(parsed) else default


def safe_ratio(numerator: float, denominator: float, default: float = 0.0) -> float:
    if not math.isfinite(numerator) or not math.isfinite(denominator) or abs(denominator) <= EPSILON:
        return default
    value = numerator / denominator
    return value if math.isfinite(value) else default


def bounded_median(values: Iterable[float], low: float = -1.0, high: float = 1.0) -> float:
    clean = [float(value) for value in values if value is not None and math.isfinite(float(value))]
    return clamp(statistics.median(clean), low, high) if clean else 0.0


def harmonic_mean(values: Iterable[float]) -> float:
    clean = [clamp(float(value), 0.0, 1.0) for value in values if value is not None and math.isfinite(float(value))]
    if not clean or any(value <= 0.0 for value in clean):
        return 0.0
    return clamp(len(clean) / sum(1.0 / value for value in clean), 0.0, 1.0)


def ewma_alpha(dt_seconds: float, half_life_seconds: float) -> float:
    if half_life_seconds <= 0.0:
        return 1.0
    return clamp(1.0 - math.exp(-math.log(2.0) * max(dt_seconds, 0.0) / half_life_seconds), 0.0, 1.0)


def parse_utc(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, (int, float)):
        number = float(value)
        if number > 10_000_000_000:
            number /= 1000.0
        try:
            return datetime.fromtimestamp(number, tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    else:
        text = str(value).strip()
        if not text:
            return None
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def utc_iso(value: datetime | None = None) -> str:
    return (value or datetime.now(timezone.utc)).astimezone(timezone.utc).isoformat()


def age_seconds(provider_event_time: Any, now_utc: datetime) -> float:
    parsed = parse_utc(provider_event_time)
    if parsed is None:
        return float("inf")
    return max(0.0, (now_utc.astimezone(timezone.utc) - parsed).total_seconds())


def stable_hash(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str, allow_nan=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def sanitize_json(value: Any) -> Any:
    """Recursively replace non-finite values so publishable JSON never contains NaN/Inf."""
    if isinstance(value, dict):
        return {str(key): sanitize_json(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [sanitize_json(item) for item in value]
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value
