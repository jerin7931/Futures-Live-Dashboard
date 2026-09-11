"""Backend-only current-state publisher; never used to construct features."""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
import urllib.parse
import urllib.request
from typing import Any

from v2.supabase import load_project_env

from .provider_health import PROVIDER_HEALTH_ID_SET


TABLE_KEYS = {
    "predictive_model_state_live": "model_id",
    "predictive_signal_episode_live": "id",
    "predictive_market_context_live": "symbol",
    "predictive_gex_surface_live": "symbol,surface_kind,scope",
    "predictive_option_ladder_live": "contract_key",
    "predictive_provider_health_live": "provider",
}


class PredictiveCurrentStatePublisher:
    def __init__(self) -> None:
        load_project_env()
        self.url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        self.key = (os.environ.get("SUPABASE_SECRET_KEY", "").strip()
                    or os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip())
        if not self.url or not self.key:
            raise RuntimeError("Supabase backend configuration is unavailable")

    def __call__(self, table: str, payload: dict[str, Any]) -> None:
        if table not in TABLE_KEYS:
            raise ValueError("Predictive publisher table is not allowlisted")
        key = TABLE_KEYS[table]
        now = datetime.now(timezone.utc).isoformat()
        batch = payload.get("_batch") if table == "predictive_option_ladder_live" else None
        if batch is not None:
            if not isinstance(batch, list) or not batch:
                return
            rows = [self._row(table, item, now) for item in batch]
            body: dict[str, Any] | list[dict[str, Any]] = rows
        else:
            body = self._row(table, payload, now)
        query = urllib.parse.urlencode({"on_conflict": key})
        request = urllib.request.Request(
            f"{self.url}/rest/v1/{table}?{query}",
            data=json.dumps(body, separators=(",", ":"), allow_nan=False).encode("utf-8"),
            headers={"apikey": self.key, "Authorization": "Bearer " + self.key,
                     "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=minimal"},
            method="POST",
        )
        started = time.perf_counter()
        with urllib.request.urlopen(request, timeout=8) as response:
            response.read()
        _ = (time.perf_counter() - started) * 1000

    @staticmethod
    def _row(table: str, payload: dict[str, Any], now: str) -> dict[str, Any]:
        if table == "predictive_model_state_live":
            row = {
                "model_id": payload["model_id"], "symbol": payload["symbol"],
                "state": payload["state"], "direction": payload["direction"],
                "guidance_state": payload.get("guidance_state", "BLOCKED"),
                "thesis_state": payload.get("thesis_state", "HOLD"),
                "setup_episode_id": payload.get("setup_episode_id"),
                "model_version": payload["model_version"], "payload": payload,
                "model_event_time": payload.get("model_event_time"),
                "updated_at": now,
            }
        elif table == "predictive_signal_episode_live":
            row = {
                "id": payload["id"], "signal_key": payload["signal_key"],
                "model_id": payload["model_id"],
                "model_setup_episode_id": payload.get("model_setup_episode_id"),
                "symbol": payload["symbol"], "side": payload["side"],
                "expiry": payload["expiry"], "strike": payload["strike"],
                "dte_class": payload.get("dte_class", "1DTE"),
                "contract": payload.get("contract"),
                "delta_at_entry": payload.get("delta_at_entry"),
                "entry_ask": payload.get("entry_ask"),
                "latest_bid": payload.get("latest_bid"),
                "latest_ask": payload.get("latest_ask"),
                "current_return": payload.get("current_return"),
                "model_strength_p30_30": payload.get("model_strength_p30_30"),
                "setup_grade": payload.get("setup_grade"),
                "status": payload["status"], "active": bool(payload.get("active")),
                "created_at": payload["created_at"], "updated_at": now,
                "expires_at": payload["expires_at"],
                "terminal_at": payload.get("terminal_at"),
                "invalidation_reason_code": payload.get("invalidation_reason_code"),
                "invalidation_reason_text": payload.get("invalidation_reason_text"),
                "model_event_time": payload.get("model_event_time"),
                "latest_quote_time": payload.get("latest_quote_time"),
                "source_timestamps": payload.get("source_timestamps") or {},
                "details_payload": payload.get("details_payload") or {},
            }
        elif table == "predictive_market_context_live":
            row = {
                "symbol": payload["symbol"], "gamma_regime": payload.get("gamma_regime", "UNAVAILABLE"),
                "market_condition": payload.get("market_condition", "UNAVAILABLE"), "payload": payload,
                "as_of": payload["as_of"], "updated_at": now,
            }
        elif table == "predictive_gex_surface_live":
            row = {
                "symbol": payload["symbol"], "surface_kind": payload["surface_kind"],
                "scope": payload["scope"], "payload": payload, "as_of": payload["as_of"],
                "updated_at": now,
            }
        elif table == "predictive_option_ladder_live":
            row = {
                "contract_key": payload["contract_key"], "symbol": payload["symbol"],
                "expiration": payload.get("expiration"), "strike": payload.get("strike"),
                "contract_type": payload.get("contract_type"), "payload": payload,
                "quote_time": payload.get("quote_time"), "updated_at": now,
                "active": bool(payload.get("active", True)),
            }
        elif table == "predictive_provider_health_live":
            if payload["provider"] not in PROVIDER_HEALTH_ID_SET:
                raise ValueError("Predictive provider-health identifier is not allowlisted")
            row = {
                "provider": payload["provider"], "status": payload["status"],
                "age_ms": payload.get("age_ms"), "payload": payload, "as_of": payload["as_of"],
                "updated_at": now,
            }
        else:
            row = payload
        return row
