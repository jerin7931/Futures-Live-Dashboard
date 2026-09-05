from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from .math_utils import age_seconds, parse_utc


@dataclass(frozen=True)
class SourceAge:
    name: str
    provider_event_time: str | None
    local_receive_time: str | None
    age_seconds: float
    receive_age_seconds: float
    valid: bool
    status: str


def source_age(
    name: str,
    provider_event_time: Any,
    local_receive_time: Any,
    now_utc: datetime,
    stale_after: float,
) -> SourceAge:
    event_age = age_seconds(provider_event_time, now_utc)
    receive_age = age_seconds(local_receive_time, now_utc)
    valid = math.isfinite(event_age) and event_age <= stale_after
    status = "LIVE" if valid else "STALE" if math.isfinite(event_age) else "UNAVAILABLE"
    return SourceAge(
        name=name,
        provider_event_time=parse_utc(provider_event_time).isoformat() if parse_utc(provider_event_time) else None,
        local_receive_time=parse_utc(local_receive_time).isoformat() if parse_utc(local_receive_time) else None,
        age_seconds=event_age,
        receive_age_seconds=receive_age,
        valid=valid,
        status=status,
    )


def clock_skew_seconds(provider_event_time: Any, local_receive_time: Any) -> float | None:
    event = parse_utc(provider_event_time)
    received = parse_utc(local_receive_time)
    if event is None or received is None:
        return None
    return (received - event).total_seconds()


def timestamp_lineage(
    *,
    provider_event_time: Any,
    local_receive_time: Any,
    feature_complete_time: Any = None,
    signal_decision_time: Any = None,
    database_ack_time: Any = None,
    browser_render_time: Any = None,
) -> dict[str, str | None]:
    def iso(value: Any) -> str | None:
        parsed = parse_utc(value)
        return parsed.isoformat() if parsed else None

    return {
        "provider_event_time": iso(provider_event_time),
        "local_receive_time": iso(local_receive_time),
        "feature_complete_time": iso(feature_complete_time),
        "signal_decision_time": iso(signal_decision_time),
        "database_ack_time": iso(database_ack_time),
        "browser_render_time": iso(browser_render_time),
    }


def utc_now() -> datetime:
    return datetime.now(timezone.utc)
