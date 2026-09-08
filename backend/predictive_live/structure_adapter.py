"""Read-only adapter for the already-running deterministic V2 structure state."""

from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any, Callable

from v2.supabase import load_project_env


class V2StructureAdapter:
    """Reads ``options_signal_v2_live``; it never mutates or reimplements V2."""

    def __init__(self, fetch_override: Callable[[str], dict[str, Any]] | None = None) -> None:
        self.fetch_override = fetch_override
        if fetch_override is None:
            load_project_env()
            self.url = os.environ.get("SUPABASE_URL", "").rstrip("/")
            self.key = (os.environ.get("SUPABASE_SECRET_KEY", "").strip()
                        or os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip())
            if not self.url or not self.key:
                raise RuntimeError("V2 structure read configuration unavailable")

    def _fetch(self, symbol: str) -> dict[str, Any]:
        if self.fetch_override is not None:
            return self.fetch_override(symbol)
        query = urllib.parse.urlencode({
            "market_key": f"eq.{symbol}_1DTE", "select": "payload,as_of", "limit": "1"
        })
        request = urllib.request.Request(
            f"{self.url}/rest/v1/options_signal_v2_live?{query}",
            headers={"apikey": self.key, "Authorization": "Bearer " + self.key}, method="GET",
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            rows = json.loads(response.read().decode("utf-8"))
        if not isinstance(rows, list) or not rows:
            raise RuntimeError(f"V2 structure unavailable for {symbol}")
        return rows[0]

    @staticmethod
    def _zone(payload: dict[str, Any], role: str) -> dict[str, Any] | None:
        zones = [value for value in payload.get("active_path_zones", []) if isinstance(value, dict)]
        direct = payload.get("support_zone") if role == "SUPPORT" else payload.get("next_obstacle_zone")
        if isinstance(direct, dict):
            zones.append(direct)
        matches = [zone for zone in zones if role in str(zone.get("current_role") or role).upper()]
        if not matches:
            return None
        cash = float(payload.get("cash_price") or 0)
        return min(matches, key=lambda zone: abs(float(zone.get("center") or cash) - cash))

    def snapshot(self, symbol: str) -> dict[str, Any]:
        row = self._fetch(symbol.upper())
        payload = row.get("payload") if isinstance(row.get("payload"), dict) else row
        cash = payload.get("cash_price"); vwap = payload.get("etf_vwap")
        support = self._zone(payload, "SUPPORT")
        resistance = self._zone(payload, "RESISTANCE")
        direction = str(payload.get("direction") or "NONE").upper()
        core = payload.get("directional_core")
        try:
            bias = "BULLISH" if float(core) > 0 else "BEARISH" if float(core) < 0 else "TRANSITION / MIXED"
        except (TypeError, ValueError):
            bias = "BULLISH" if direction == "CALL" else "BEARISH" if direction == "PUT" else "TRANSITION / MIXED"
        # Bind acceptance to the qualified side-specific zone. An accepted
        # state on an unrelated path zone must not invalidate this setup.
        accepted_below = bool(support and str(support.get("accepted_state")) == "ACCEPTED_BELOW")
        accepted_above = bool(resistance and str(resistance.get("accepted_state")) == "ACCEPTED_ABOVE")
        try:
            above_vwap = float(cash) > float(vwap)
        except (TypeError, ValueError):
            above_vwap = None
        state = str(payload.get("state") or "")
        transition = state.startswith("ARMING") or "TRANSITION" in str(payload.get("display_state") or "").upper()
        as_of = str(payload.get("as_of") or row.get("as_of") or "")
        if as_of:
            age_ms = max(0.0, (datetime.now(timezone.utc) - datetime.fromisoformat(as_of.replace("Z", "+00:00"))).total_seconds() * 1000)
        else:
            age_ms = None
        return {
            "symbol": symbol.upper(), "source": "TRUSTED_DETERMINISTIC_V2_READ_ONLY",
            "as_of": as_of, "age_ms": age_ms, "above_vwap": above_vwap,
            "vwap": vwap, "cash_price": cash, "support_zone": support,
            "resistance_zone": resistance, "support_holding": bool(support and not accepted_below),
            "resistance_holding": bool(resistance and not accepted_above),
            "accepted_below": accepted_below, "accepted_above": accepted_above,
            "transition": transition, "structure_bias": bias,
            "call_invalidation_level": support.get("lower_bound") if support else None,
            "put_invalidation_level": resistance.get("upper_bound") if resistance else None,
        }
