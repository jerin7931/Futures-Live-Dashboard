"""Provider-neutral validation. Concrete credentials stay in existing local adapters."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from ..calendar import ExchangeSessionCalendar, ET


BAD_TRADE_TYPES = frozenset({
    "OUT_OF_SEQ", "OPEN_OUT_OF_SEQ", "SOLD_LAST", "CANCEL",
    "CANCEL_LAST", "CANCEL_OPEN", "CANCEL_ONLY",
})


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


def quant_context_eligible(row: dict[str, Any], *, expected_expiration: str | None = None) -> tuple[bool, str]:
    """Exact frozen unconsolidated context-tape population.

    The historical option context used actual/provider 1DTE, 0.55-.75 absolute
    delta, the reviewed bad-condition exclusion, and explicit complex/tied
    classification. Missing flags are not silently interpreted as simple flow.
    """
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
    greeks = row.get("greeks") if isinstance(row.get("greeks"), dict) else {}
    try:
        delta = abs(float(greeks.get("delta")))
    except (TypeError, ValueError):
        return False, "CONTEXT_DELTA_UNRESOLVABLE"
    if not 0.55 <= delta <= 0.75:
        return False, "CONTEXT_DELTA_OUTSIDE_055_075"
    if row.get("isCancelled") is True:
        return False, "CONTEXT_CANCELLED"
    if str(row.get("tradeType") or "").upper() in BAD_TRADE_TYPES:
        return False, "CONTEXT_BAD_TRADE_TYPE"
    if not isinstance(row.get("isComplex"), bool) or not isinstance(row.get("isTied"), bool):
        return False, "CONTEXT_COMPLEX_TIED_UNRESOLVABLE"
    try:
        if int(row.get("tradeTime") or 0) <= 0:
            return False, "CONTEXT_TIME_UNRESOLVABLE"
    except (TypeError, ValueError):
        return False, "CONTEXT_TIME_UNRESOLVABLE"
    return True, "OK"


def quant_candidate_eligible(row: dict[str, Any]) -> tuple[bool, str]:
    valid, reason = quant_context_eligible(row)
    if not valid:
        return valid, reason
    delta = abs(float((row.get("greeks") or {}).get("delta")))
    if not 0.60 <= delta <= 0.70:
        return False, "CANDIDATE_DELTA_OUTSIDE_060_070"
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
    if not 0.60 <= delta <= 0.70:
        return False, "DELTA_OUTSIDE_FROZEN_BAND"
    return True, "OK"
