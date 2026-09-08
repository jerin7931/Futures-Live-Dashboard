"""Official Webull OpenAPI market-data-only adapter."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from v2.providers.runtime import build_candidates, cash_snapshot_map
from v2.providers.quantdata import ProviderResult
from v2.providers.webull import WebullResult
from v2.providers.webull import WebullMarketDataClient


class PredictiveWebullMarketData:
    def __init__(self) -> None:
        self.client = WebullMarketDataClient()

    def cash_quotes(self) -> dict[str, dict[str, Any]]:
        return cash_snapshot_map(self.client.stock_snapshot(["SPY", "QQQ"]))

    def option_ladder(self, *, symbol: str, expiration: str, low_strike: float, high_strike: float,
                      quant_surface: ProviderResult | None, spot: float) -> list[dict[str, Any]]:
        contracts = self.client.option_contracts(symbol, expiration, low_strike, high_strike)
        rows = contracts.data.get("data", []) if isinstance(contracts.data, dict) else []
        option_symbols = [str(row.get("symbol")) for row in rows if row.get("symbol")]
        snapshots: list[dict[str, Any]] = []
        for start in range(0, len(option_symbols), 20):
            result = self.client.option_snapshots(option_symbols[start:start + 20])
            if isinstance(result.data, dict):
                snapshots.extend(result.data.get("data", []))
        quote_result = WebullResult({"data": snapshots}, None, "", 0.0, "LIVE")
        output: list[dict[str, Any]] = []
        for candidate in build_candidates(symbol, expiration, contracts, quote_result, quant_surface, spot):
            try:
                quote_age_ms = max(0.0, (datetime.now(timezone.utc) - datetime.fromisoformat(str(candidate.quote_time).replace("Z", "+00:00"))).total_seconds() * 1000)
            except (TypeError, ValueError):
                quote_age_ms = None
            try:
                greek_age_ms = max(0.0, (datetime.now(timezone.utc) - datetime.fromisoformat(str(candidate.greeks_time).replace("Z", "+00:00"))).total_seconds() * 1000)
            except (TypeError, ValueError):
                greek_age_ms = None
            output.append({
                **candidate.__dict__, "contract_key": candidate.option_symbol,
                "contract_type": candidate.option_type, "dte": 1,
                "relative_spread": candidate.relative_spread,
                "quote_age_ms": quote_age_ms, "greek_age_ms": greek_age_ms,
                "eligible": 0.60 <= abs(candidate.delta) <= 0.70,
                "selected": False, "flow_context": None,
            })
        return output
