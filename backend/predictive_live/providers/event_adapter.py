"""Point-in-time provider rows translated into the frozen live feature contract."""

from __future__ import annotations

from datetime import datetime, timezone
import math
from typing import Any

from ..features import OptionPrint
from ..calendar import ExchangeSessionCalendar
from ..trade_classification import classify_quant_row
from .contracts import quant_candidate_eligible, quant_context_eligible


SIDE = {"A": "ASK", "AA": "ABOVE_ASK", "B": "BID", "BB": "BELOW_BID", "M": "MID",
        "AT_ASK": "ASK", "AT_BID": "BID"}
CALENDAR = ExchangeSessionCalendar()


def _expiration_close(expiration: str) -> datetime:
    return CALENDAR.expiration_close(expiration)


def option_print_from_quant(row: dict[str, Any], *, candidate: bool = False) -> OptionPrint:
    eligible, reason = (quant_candidate_eligible(row) if candidate else quant_context_eligible(row))
    if not eligible:
        raise ValueError(reason)
    trade_ms = int(row["tradeTime"])
    trade_time = datetime.fromtimestamp(trade_ms / 1000, timezone.utc)
    expiration = str(row["expirationDate"])
    tte_minutes = (_expiration_close(expiration).astimezone(timezone.utc) - trade_time).total_seconds() / 60
    if tte_minutes <= 0:
        raise ValueError("Expired option event")
    greeks = row.get("greeks") if isinstance(row.get("greeks"), dict) else {}
    delta_value = greeks.get("delta")
    delta = float(delta_value) if delta_value is not None and math.isfinite(float(delta_value)) else None
    side = SIDE.get(str(row.get("tradeSideCode") or "").upper(), str(row.get("tradeSideCode") or "MID").upper())
    trade_type = str(row.get("tradeType") or "UNKNOWN")
    classification = classify_quant_row(row)
    complex_flag = bool(classification["is_complex"])
    tied_flag = bool(classification["is_tied"])
    raw_dte = float(row.get("dte", -1))
    dte = 1
    fields = {
        "askPrice": row.get("askPrice"), "bidPrice": row.get("bidPrice"),
        "bidAskSpread": row.get("bidAskSpread"), "optionPrice": row.get("optionPrice"),
        "impliedVolatility": row.get("impliedVolatility"), "strikePrice": row.get("strikePrice"),
        "expiration": expiration, "dte": dte, "provider_dte": raw_dte,
        "actual_tte_minutes_rth": tte_minutes, "greeks": greeks,
        "moneyness": row.get("moneyness") if isinstance(row.get("moneyness"), dict) else {},
        "trade_class": classification["trade_class"],
        "trade_classifier_version": classification["classifier_version"],
        "is_simple_directional": classification["is_simple_directional"],
        "is_complex": classification["is_complex"],
        "is_tied": classification["is_tied"],
        "is_ambiguous": classification["is_ambiguous"],
        "is_excluded_bad_trade": classification["is_excluded_bad_trade"],
        "trade_side_code": str(row.get("tradeSideCode") or "UNKNOWN").upper(),
    }
    return OptionPrint(
        symbol=str(row["ticker"]).upper(), event_time_ms=trade_ms, osi=str(row["osi"]),
        provider_id=str(row["id"]),
        contract_type=str(row["contractType"]).upper(), trade_side=side,
        premium=float(row.get("premium") or 0), size=float(row.get("size") or 0), delta=delta,
        stock_price=float(row["stockPrice"]) if row.get("stockPrice") is not None else None,
        is_complex=complex_flag, is_tied=tied_flag, trade_type=trade_type, fields=fields,
    )


def signed_gex(body: dict[str, Any], symbol: str) -> tuple[dict[float, float], float | None]:
    node = body.get("data", {}).get(symbol, {}) if isinstance(body, dict) else {}
    totals: dict[float, float] = {}
    for strikes in (node.get("exposureMap") or {}).values():
        if not isinstance(strikes, dict):
            continue
        for strike, cell in strikes.items():
            if isinstance(cell, dict):
                totals[float(strike)] = totals.get(float(strike), 0.0) + sum(float(value or 0) for value in cell.values())
    spot = float(node["stockPrice"]) if node.get("stockPrice") is not None else None
    return totals, spot


def normalize_option_snapshot(row: dict[str, Any]) -> dict[str, Any]:
    stamp = row.get("quote_time") or row.get("timestamp") or row.get("time")
    if isinstance(stamp, (int, float)):
        value = float(stamp) / (1000 if float(stamp) > 10_000_000_000 else 1)
        stamp = datetime.fromtimestamp(value, timezone.utc).isoformat()
    return {"bid": row.get("bid"), "ask": row.get("ask"), "bid_size": row.get("bid_size"),
            "ask_size": row.get("ask_size"), "last": row.get("price"), "quote_time": stamp}
