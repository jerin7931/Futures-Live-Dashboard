"""Persistent 1DTE signal-row lifecycle, separate from card/model health state."""

from __future__ import annotations

import hashlib
import json
import math
import os
import queue
import threading
from datetime import datetime, time, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo


CT = ZoneInfo("America/Chicago")
SIGNAL_STATUSES = {"TRACKING", "INVALIDATED", "TARGET_HIT", "EXPIRED"}
TERMINAL_STATUSES = SIGNAL_STATUSES - {"TRACKING"}
SCHEMA_VERSION = 1


def _stamp(value: datetime | str | None) -> datetime:
    if value is None:
        return datetime.now(timezone.utc)
    if isinstance(value, datetime):
        parsed = value
    else:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _strike_key(value: Any) -> str:
    try:
        decimal = Decimal(str(value)).normalize()
    except (InvalidOperation, ValueError) as exc:
        raise ValueError("Signal strike is unavailable") from exc
    return format(decimal, "f")


def signal_identity(model_id: str, symbol: str, expiry: str, strike: Any, side: str) -> tuple[str, str]:
    """Return the explicit deterministic key and compact row id required by V1."""
    key = "|".join((model_id.upper(), symbol.upper(), str(expiry), _strike_key(strike), side.upper()))
    return key, hashlib.sha256(key.encode("utf-8")).hexdigest()[:32]


def signal_creation_allowed(value: datetime | str | None) -> bool:
    """The 08:30:00-08:44:59 CT open window is update-only for 1DTE rows."""
    local = _stamp(value).astimezone(CT)
    clock = local.time().replace(tzinfo=None)
    return not (time(8, 30) <= clock < time(8, 45))


def _finite(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _human_reason(value: Any) -> str | None:
    if not value:
        return None
    text = str(value).strip()
    replacements = {
        "MODEL_REVERSAL_CONFIRMED": "Opposite-side model evidence and structure confirmed deterioration",
        "STRUCTURE_ACCEPTED_BELOW_SUPPORT": "Price accepted below the qualified support zone",
        "STRUCTURE_ACCEPTED_ABOVE_RESISTANCE": "Price accepted above the qualified resistance zone",
        "LATEST_SAME_SIDE_MODEL_EVIDENCE_STALE_OR_UNAVAILABLE": "Latest same-side model evidence is stale or unavailable",
        "REQUIRED_PROVIDER_OR_STRUCTURE_STALE": "A required provider or trusted structure input is stale",
    }
    return replacements.get(text, text.replace("_", " ").strip().capitalize())


class SignalEpisodeBook:
    """Durable, deterministic signal rows for the four independent 1DTE cards.

    The thesis state machine remains owned by :mod:`service`. This book mirrors
    actionable completed-cadence decisions into independent contract rows so a
    later selection can never erase an already-tracking contract.
    """

    def __init__(self, state_path: Path, *, tracking_minutes: int = 30) -> None:
        self.state_path = state_path.resolve()
        self.tracking_minutes = int(tracking_minutes)
        self.rows: dict[str, dict[str, Any]] = {}
        self.lock = threading.RLock()
        self._load()
        self._write_queue: queue.Queue[dict[str, Any] | None] = queue.Queue(maxsize=1)
        self._writer = threading.Thread(target=self._run_writer, name="signal-episode-state-writer", daemon=True)
        self._writer.start()

    def _load(self) -> None:
        if not self.state_path.exists():
            return
        try:
            body = json.loads(self.state_path.read_text(encoding="utf-8"))
            if body.get("schema_version") != SCHEMA_VERSION:
                return
            for row in body.get("rows", []):
                if row.get("status") in SIGNAL_STATUSES and row.get("id"):
                    self.rows[str(row["id"])] = dict(row)
            self.sweep(datetime.now(timezone.utc), persist=False)
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            # Operational continuity fails closed to an empty local cache. The
            # append-only forward log and Supabase records remain untouched.
            self.rows = {}

    def _persist(self) -> None:
        body = {"schema_version": SCHEMA_VERSION, "rows": [dict(row) for row in self.rows.values()]}
        try:
            self._write_queue.put_nowait(body)
        except queue.Full:
            try:
                self._write_queue.get_nowait()
                self._write_queue.task_done()
            except queue.Empty:
                pass
            self._write_queue.put_nowait(body)

    def _run_writer(self) -> None:
        while True:
            body = self._write_queue.get()
            if body is None:
                self._write_queue.task_done()
                return
            try:
                self.state_path.parent.mkdir(parents=True, exist_ok=True)
                temp = self.state_path.with_suffix(self.state_path.suffix + ".tmp")
                temp.write_text(json.dumps(body, separators=(",", ":"), allow_nan=False), encoding="utf-8")
                os.replace(temp, self.state_path)
            finally:
                self._write_queue.task_done()

    @staticmethod
    def _details(decision: dict[str, Any]) -> dict[str, Any]:
        keys = (
            "raw_probability_surface", "display_probability_surface",
            "raw_aim_for_by_horizon", "aim_for_percent_by_horizon",
            "invalid_if", "invalidation_reason", "relative_spread",
            "selected_contract_probability_at_selection", "model_version",
            "surface_contract", "probability_language", "feature_hash",
            "candidate_contract", "bid", "ask", "delta",
        )
        return {key: decision.get(key) for key in keys}

    @staticmethod
    def _target_reached(row: dict[str, Any]) -> bool:
        current_return = _finite(row.get("current_return"))
        aims = row.get("details_payload", {}).get("aim_for_percent_by_horizon") or {}
        target = _finite(aims.get("30"))
        return current_return is not None and target is not None and current_return >= target / 100.0

    def sync_decision(self, decision: dict[str, Any], *, now: datetime | None = None) -> tuple[dict[str, Any] | None, bool]:
        """Insert or update one deterministic signal key; never replace another."""
        now = _stamp(now)
        model_id = str(decision.get("model_id") or "")
        symbol = str(decision.get("symbol") or "")
        expiry = str(decision.get("expiration") or "")
        side = str(decision.get("direction") or "").upper()
        strike = decision.get("strike")
        grade = str(decision.get("grade") or "").upper()
        if not all((model_id, symbol, expiry, side in {"CALL", "PUT"}, strike is not None)):
            return None, False
        key, row_id = signal_identity(model_id, symbol, expiry, strike, side)
        event_time = _stamp(decision.get("model_event_time") or now)
        actionable = (
            grade in {"A", "B", "C"}
            and decision.get("guidance_state") == "LIVE"
            and decision.get("thesis_state") != "INVALIDATED"
            and (_finite(decision.get("option_entry_price") or decision.get("ask")) or 0) > 0
        )
        with self.lock:
            existing = self.rows.get(row_id)
            if existing is None:
                if not actionable or not signal_creation_allowed(event_time):
                    return None, False
                created = _stamp(decision.get("option_entry_time") or now)
                entry_ask = _finite(decision.get("option_entry_price") or decision.get("ask"))
                existing = {
                    "id": row_id, "signal_key": key, "model_id": model_id,
                    "model_setup_episode_id": decision.get("setup_episode_id"),
                    "symbol": symbol, "side": side, "expiry": expiry,
                    "strike": _finite(strike), "dte_class": "1DTE",
                    "contract": str(decision.get("candidate_contract") or ""),
                    "delta_at_entry": _finite(decision.get("delta")),
                    "entry_ask": entry_ask, "latest_bid": _finite(decision.get("bid")),
                    "latest_ask": _finite(decision.get("ask")),
                    "current_return": _finite(decision.get("current_option_return")),
                    "model_strength_p30_30": _finite(decision.get("grade_probability") or decision.get("probability")),
                    "setup_grade": grade, "status": "TRACKING", "active": True,
                    "created_at": created.isoformat(), "updated_at": now.isoformat(),
                    "expires_at": (created + timedelta(minutes=self.tracking_minutes)).isoformat(),
                    "terminal_at": None, "invalidation_reason_code": None,
                    "invalidation_reason_text": None,
                    "model_event_time": decision.get("model_event_time"),
                    "latest_quote_time": decision.get("latest_quote_time"),
                    "source_timestamps": {
                        "model_event_time": decision.get("model_event_time"),
                        "latest_quote_time": decision.get("latest_quote_time"),
                        "selected_contract_event_time": decision.get("selected_contract_event_time"),
                    },
                    "details_payload": self._details(decision),
                }
                self.rows[row_id] = existing
                created_row = True
            else:
                created_row = False
                if existing.get("status") in TERMINAL_STATUSES:
                    return dict(existing), False
                new_details = self._details(decision)
                prior_details = dict(existing.get("details_payload") or {})
                prior_details.update({key: value for key, value in new_details.items() if value is not None})
                existing.update({
                    "model_setup_episode_id": decision.get("setup_episode_id") or existing.get("model_setup_episode_id"),
                    "latest_bid": _finite(decision.get("bid")),
                    "latest_ask": _finite(decision.get("ask")),
                    "model_strength_p30_30": _finite(decision.get("grade_probability") or decision.get("probability")),
                    "model_event_time": decision.get("model_event_time"),
                    "latest_quote_time": decision.get("latest_quote_time"),
                    "updated_at": now.isoformat(),
                    "details_payload": prior_details,
                })
                if existing.get("status") == "TRACKING":
                    existing["current_return"] = self._return(existing.get("entry_ask"), decision.get("bid"))
                existing["source_timestamps"] = {
                    "model_event_time": decision.get("model_event_time"),
                    "latest_quote_time": decision.get("latest_quote_time"),
                    "selected_contract_event_time": decision.get("selected_contract_event_time"),
                }
            if existing.get("status") == "TRACKING":
                if self._target_reached(existing):
                    self._terminal(existing, "TARGET_HIT", now)
                elif decision.get("thesis_state") == "INVALIDATED":
                    self._terminal(existing, "INVALIDATED", now,
                                   decision.get("invalidation_reason"), decision.get("invalidation_reason"))
                elif now >= _stamp(existing["expires_at"]):
                    self._terminal(existing, "EXPIRED", now)
            self._persist()
            return dict(existing), created_row

    @staticmethod
    def _return(entry: Any, bid: Any) -> float | None:
        entry_value, bid_value = _finite(entry), _finite(bid)
        if entry_value is None or bid_value is None or entry_value <= 0 or bid_value < 0:
            return None
        return bid_value / entry_value - 1.0

    @staticmethod
    def _terminal(row: dict[str, Any], status: str, now: datetime,
                  reason_code: Any = None, reason_text: Any = None) -> None:
        if status not in TERMINAL_STATUSES:
            raise ValueError(f"Invalid terminal signal status: {status}")
        row["status"] = status
        row["active"] = False
        row["terminal_at"] = now.isoformat()
        if status == "INVALIDATED":
            row["invalidation_reason_code"] = str(reason_code or "SETUP_INVALIDATED")
            row["invalidation_reason_text"] = _human_reason(reason_text or reason_code or "SETUP_INVALIDATED")

    def invalidate_setup(self, model_id: str, setup_episode_id: str | None,
                         reason_code: Any, *, now: datetime | None = None) -> list[dict[str, Any]]:
        now = _stamp(now)
        changed: list[dict[str, Any]] = []
        with self.lock:
            for row in self.rows.values():
                if (row.get("model_id") == model_id and row.get("status") == "TRACKING"
                        and (setup_episode_id is None or row.get("model_setup_episode_id") == setup_episode_id)):
                    self._terminal(row, "INVALIDATED", now, reason_code, reason_code)
                    row["updated_at"] = now.isoformat()
                    changed.append(dict(row))
            if changed:
                self._persist()
        return changed

    def update_quote(self, contract: str, *, bid: Any, ask: Any,
                     quote_time: str | None, now: datetime | None = None) -> list[dict[str, Any]]:
        now = _stamp(now)
        changed: list[dict[str, Any]] = []
        with self.lock:
            for row in self.rows.values():
                # Historical rows store the provider contract inside details so
                # the deterministic identity remains exactly the specified key.
                stored_contract = row.get("contract") or row.get("details_payload", {}).get("candidate_contract")
                if stored_contract != contract:
                    continue
                if row.get("status") in TERMINAL_STATUSES:
                    continue
                row.update({"latest_bid": _finite(bid), "latest_ask": _finite(ask),
                            "latest_quote_time": quote_time, "updated_at": now.isoformat()})
                row["current_return"] = self._return(row.get("entry_ask"), bid)
                row.setdefault("source_timestamps", {})["latest_quote_time"] = quote_time
                if row.get("status") == "TRACKING":
                    if self._target_reached(row):
                        self._terminal(row, "TARGET_HIT", now)
                    elif now >= _stamp(row["expires_at"]):
                        self._terminal(row, "EXPIRED", now)
                changed.append(dict(row))
            if changed:
                self._persist()
        return changed

    def sweep(self, now: datetime | None = None, *, persist: bool = True) -> list[dict[str, Any]]:
        now = _stamp(now)
        changed: list[dict[str, Any]] = []
        with self.lock:
            for row in self.rows.values():
                if row.get("status") == "TRACKING" and now >= _stamp(row["expires_at"]):
                    self._terminal(row, "EXPIRED", now)
                    row["updated_at"] = now.isoformat()
                    changed.append(dict(row))
            if changed and persist:
                self._persist()
        return changed

    def active_contracts(self) -> list[str]:
        with self.lock:
            return list(dict.fromkeys(str(row.get("contract")) for row in self.rows.values()
                                      if row.get("status") == "TRACKING" and row.get("contract")))

    def snapshot(self) -> list[dict[str, Any]]:
        with self.lock:
            return [dict(row) for row in self.rows.values()]

    def close(self, timeout: float = 5.0) -> None:
        deadline = datetime.now(timezone.utc) + timedelta(seconds=timeout)
        while self._write_queue.unfinished_tasks and datetime.now(timezone.utc) < deadline:
            threading.Event().wait(.01)
        self._write_queue.put(None)
        self._writer.join(timeout=max(.1, timeout / 2))
