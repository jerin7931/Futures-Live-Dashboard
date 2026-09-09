"""Provider-neutral validation. Concrete credentials stay in existing local adapters."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from ..calendar import ExchangeSessionCalendar, ET
from ..trade_classification import BAD_TRADE_TYPES, classify_quant_row


CONTEXT_MIN_ABS_DELTA = 0.55
CONTEXT_MAX_ABS_DELTA = 0.75
CANDIDATE_MIN_ABS_DELTA = 0.49
CANDIDATE_MAX_ABS_DELTA = 0.70


def candidate_delta_band(delta: float) -> str:
    value = abs(float(delta))
    if CANDIDATE_MIN_ABS_DELTA <= value < 0.55:
        return "EXTENDED_49_55"
    if 0.55 <= value < 0.60:
        return "EXTENDED_55_60"
    if 0.60 <= value <= CANDIDATE_MAX_ABS_DELTA:
        return "ORIGINAL_60_70"
    return "OUTSIDE_ACTIONABLE_UNIVERSE"


def quote_valid(quote: dict[str, Any] | None, *, max_age_seconds: float = 5.0, now: datetime | None = None) -> tuple[bool, str]:
    now = now or datetime.now(timezone.utc)
    try:
        bid = float(quote["bid"]); ask = float(quote["ask"])
        stamp = datetime.fromisoformat(str(quote["quote_time"]).replace("Z", "+00:00"))
    except (KeyError, TypeError, ValueError):
        return False, "WEBULL_QUOTE_UNRESOLVABLE"
    if bid < 0 or ask <= 0 or bid > ask:
        return False, "WEBULL_QUOTE_CROSSED_OR_IMPOSSIBLE"
    if (now - stamp.astimezone(timezone.utc)).total_seconds() > max_age_seconds:
        return False, "WEBULL_QUOTE_STALE"
    return True, "OK"


def _exact_integer(value: Any) -> int | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    integer = int(round(number))
    return integer if abs(number - integer) <= 1e-9 else None


def _quant_1dte_trade_eligible(row: dict[str, Any], *, expected_expiration: str | None = None) -> tuple[bool, str]:
    """Shared causal 1DTE and trade-quality checks, without a delta policy."""
    try:
        provider_dte = float(row.get("dte"))
    except (TypeError, ValueError):
        provider_dte = -1
    if provider_dte <= 0:
        return False, "CONTEXT_NOT_1DTE"
    if expected_expiration is None:
        try:
            event_day = datetime.fromtimestamp(int(row["tradeTime"])/1000, timezone.utc).astimezone(ET).date()
            expected_expiration = ExchangeSessionCalendar().next_session(event_day).session_date
        except (KeyError, TypeError, ValueError, RuntimeError):
            return False, "CONTEXT_1DTE_EXPIRATION_UNRESOLVABLE"
    if str(row.get("expirationDate") or "") != expected_expiration:
        return False, "CONTEXT_NOT_1DTE"
    classification = classify_quant_row(row)
    if row.get("isCancelled") is True:
        return False, "CONTEXT_CANCELLED"
    if classification["is_excluded_bad_trade"]:
        return False, "CONTEXT_BAD_TRADE_TYPE"
    if classification["is_extended_hours"]:
        return False, "CONTEXT_EXTENDED_HOURS"
    try:
        if int(row.get("tradeTime") or 0) <= 0:
            return False, "CONTEXT_TIME_UNRESOLVABLE"
    except (TypeError, ValueError):
        return False, "CONTEXT_TIME_UNRESOLVABLE"
    return True, "OK"


def quant_context_eligible(row: dict[str, Any], *, expected_expiration: str | None = None) -> tuple[bool, str]:
    """Exact frozen unconsolidated context-tape population.

    Historical context is actual/provider 1DTE, 0.55-.75 absolute delta, with
    reviewed bad-condition exclusion and explicit complex/tied classification.
    """
    valid, reason = _quant_1dte_trade_eligible(row, expected_expiration=expected_expiration)
    if not valid:
        return valid, reason
    greeks = row.get("greeks") if isinstance(row.get("greeks"), dict) else {}
    try:
        delta = abs(float(greeks.get("delta")))
    except (TypeError, ValueError):
        return False, "CONTEXT_DELTA_UNRESOLVABLE"
    if not CONTEXT_MIN_ABS_DELTA <= delta <= CONTEXT_MAX_ABS_DELTA:
        return False, "CONTEXT_DELTA_OUTSIDE_055_075"
    return True, "OK"

def quant_candidate_eligible(row: dict[str, Any]) -> tuple[bool, str]:
    valid, reason = _quant_1dte_trade_eligible(row)
    if not valid:
        return valid, reason
    try:
        delta = abs(float((row.get("greeks") or {}).get("delta")))
    except (TypeError, ValueError):
        return False, "CANDIDATE_DELTA_UNRESOLVABLE"
    if not CANDIDATE_MIN_ABS_DELTA <= delta <= CANDIDATE_MAX_ABS_DELTA:
        return False, "CANDIDATE_DELTA_OUTSIDE_049_070"
    try:
        bid, ask = float(row["bidPrice"]), float(row["askPrice"])
    except (KeyError, TypeError, ValueError):
        return False, "CANDIDATE_QUOTE_UNRESOLVABLE"
    if bid < 0 or ask <= 0 or bid > ask:
        return False, "CANDIDATE_QUOTE_CROSSED_OR_IMPOSSIBLE"
    return True, "OK"


def eligible_contract(contract: dict[str, Any]) -> tuple[bool, str]:
    try:
        delta = abs(float(contract["delta"])); dte = int(contract["dte"])
    except (KeyError, TypeError, ValueError):
        return False, "CONTRACT_FIELDS_UNRESOLVABLE"
    if dte != 1:
        return False, "NOT_ACTUAL_1DTE"
    if not CANDIDATE_MIN_ABS_DELTA <= delta <= CANDIDATE_MAX_ABS_DELTA:
        return False, "DELTA_OUTSIDE_PRODUCTION_BAND"
    return True, "OK"
