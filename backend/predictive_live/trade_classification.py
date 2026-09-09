"""Canonical Quant option trade-condition classification (version 1).

This file is mechanically mirrored into Predictive Live.  Historical research
and live ingestion must use byte-identical copies; unknown conditions fail into
AMBIGUOUS/NON_DIRECTIONAL rather than SIMPLE.
"""

from __future__ import annotations

from typing import Any


TRADE_CLASSIFIER_VERSION = "QUANT_TRADETYPE_COMPLEX_TIED_V1"

BAD_TRADE_TYPES = frozenset({
    "OUT_OF_SEQ", "OPEN_OUT_OF_SEQ", "SOLD_LAST", "CANCEL",
    "CANCEL_LAST", "CANCEL_OPEN", "CANCEL_ONLY",
})

SIMPLE_DIRECTIONAL_TRADE_TYPES = frozenset({
    "OPEN_IN_SEQ", "AUTO", "REOPEN", "ISO", "AUCT", "AUCT_ISO",
    "CROSS", "CROSS_ISO", "FLR",
})

COMPLEX_TRADE_TYPES = frozenset({
    "MULTI_AUTO_COB", "MULTI_AUCT_COB", "MULTI_CROSS", "M2M_FLR",
    "M2S_AUTO", "M2S_AUCT", "M2S_FLR", "TIED_MULTI_AUCT_COB",
    "TIED_MULTI_AUTO_COB", "TIED_MULTI_CROSS", "TIED_MULTI_FLR_COB",
    "TIED_M2S_AUTO", "TIED_M2S_AUCT", "TIED_M2S_FLR",
    "MULTI_FLR_PP", "MULTI_COMP_PP",
})

TIED_TRADE_TYPES = frozenset({
    "TIED_MULTI_AUCT_COB", "TIED_MULTI_AUTO_COB", "TIED_MULTI_CROSS",
    "TIED_MULTI_FLR_COB", "TIED_M2S_AUTO", "TIED_M2S_AUCT",
    "TIED_M2S_FLR",
})

EXTENDED_HOURS_TRADE_TYPES = frozenset({"EXT_HOURS"})

DOCUMENTED_TRADE_TYPES = frozenset(
    BAD_TRADE_TYPES
    | SIMPLE_DIRECTIONAL_TRADE_TYPES
    | COMPLEX_TRADE_TYPES
    | EXTENDED_HOURS_TRADE_TYPES
)


def classify_trade_type(value: Any) -> dict[str, Any]:
    """Return a conservative, fully explicit classification for one trade type."""
    trade_type = str(value or "").strip().upper()
    is_bad = trade_type in BAD_TRADE_TYPES
    is_tied = trade_type in TIED_TRADE_TYPES
    is_complex = trade_type in COMPLEX_TRADE_TYPES
    is_simple = trade_type in SIMPLE_DIRECTIONAL_TRADE_TYPES
    is_extended = trade_type in EXTENDED_HOURS_TRADE_TYPES
    is_ambiguous = trade_type not in DOCUMENTED_TRADE_TYPES
    if is_bad:
        trade_class = "EXCLUDED_BAD_TRADE"
    elif is_tied:
        trade_class = "TIED_COMPLEX_NON_DIRECTIONAL"
    elif is_complex:
        trade_class = "COMPLEX_NON_DIRECTIONAL"
    elif is_simple:
        trade_class = "SIMPLE_DIRECTIONAL"
    elif is_extended:
        trade_class = "EXTENDED_HOURS_NON_DIRECTIONAL"
    else:
        trade_class = "AMBIGUOUS_NON_DIRECTIONAL"
    return {
        "classifier_version": TRADE_CLASSIFIER_VERSION,
        "trade_type": trade_type,
        "trade_class": trade_class,
        "is_simple_directional": is_simple,
        "is_complex": is_complex,
        "is_tied": is_tied,
        "is_ambiguous": is_ambiguous,
        "is_excluded_bad_trade": is_bad,
        "is_extended_hours": is_extended,
        "is_auction": "AUCT" in trade_type,
        "is_cross": "CROSS" in trade_type,
        "is_floor": "FLR" in trade_type,
    }


def classify_quant_row(row: dict[str, Any]) -> dict[str, Any]:
    """Classify a Quant row solely from its documented ``tradeType`` value."""
    return classify_trade_type(row.get("tradeType"))
