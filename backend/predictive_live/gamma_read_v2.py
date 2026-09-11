"""Stateful deterministic 0DTE Gamma Read interpretation engine V2.

The rich state produced here is presentation context only.  It is deliberately
isolated from frozen model features, contract selection, grading, Aim For, and
signal lifecycle logic.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from statistics import median
from typing import Any
from zoneinfo import ZoneInfo

from .gamma_read import _age_ms, _clean, _finite, _level, _stamp, _zone


# Preserve the deployed JSON contract; the additive rich state carries the V2
# engine identifier without forcing a frontend/schema migration.
CONTRACT = "OPTIONS_DASHBOARD_0DTE_GAMMA_READ_V1"
ET = ZoneInfo("America/New_York")
ALLOWED_REGIMES = {
    "STABILIZING", "PINNED", "STABILIZING / PINNED", "GAMMA BOUNDARY",
    "TRANSITION", "NEGATIVE GAMMA", "ACCELERATION RISK", "MIXED", "DATA STALE",
}


def _bounded(value: float) -> float:
    return max(-1.0, min(1.0, float(value)))


def _position(strike: float, spot: float, near: float) -> str:
    if abs(strike - spot) <= near:
        return "AT_OR_NEAR_SPOT"
    return "BELOW_SPOT" if strike < spot else "ABOVE_SPOT"


def _surface_fingerprint(current: dict[float, float], delta: dict[float, float],
                         spot: float, spacing: float, current_as_of: Any) -> str:
    body = {
        "current": [(key, current[key]) for key in sorted(current)],
        "delta": [(key, delta.get(key, 0.0)) for key in sorted(current)],
        "spot_bucket": round(spot / max(spacing * .25, .01)),
        "as_of": str(current_as_of),
    }
    return hashlib.sha256(json.dumps(body, separators=(",", ":"), default=str).encode()).hexdigest()


def _classify_current(value: float, share: float, percentile: float) -> tuple[str, int]:
    if share < .02:
        return "NEAR_NEUTRAL", 0
    strength = "STRONGLY" if share >= .18 or percentile >= .88 else "MODERATELY" if share >= .075 else "WEAK"
    sign = 1 if value > 0 else -1
    return f"{strength}_{'POSITIVE' if sign > 0 else 'NEGATIVE'}", sign


def _classify_delta(value: float, share: float) -> tuple[str, int]:
    if share < .035 or abs(value) <= 1e-12:
        return "APPROXIMATELY_STABLE", 0
    strength = "STRONGLY_" if share >= .17 else ""
    sign = 1 if value > 0 else -1
    return f"{strength}{'POSITIVE_CHANGE' if sign > 0 else 'NEGATIVE_CHANGE'}", sign


def _evolution(current_sign: int, delta_sign: int, delta_class: str) -> tuple[str, str | None]:
    strong = delta_class.startswith("STRONGLY")
    if current_sign > 0 and delta_sign > 0:
        return "STRENGTHENING", "POSITIVE_GEX_STRENGTHENING"
    if current_sign > 0 and delta_sign < 0:
        return ("SIGN_FLIP_RISK" if strong else "WEAKENING"), "POSITIVE_GEX_WEAKENING"
    if current_sign < 0 and delta_sign < 0:
        return "STRENGTHENING", "NEGATIVE_GEX_STRENGTHENING"
    if current_sign < 0 and delta_sign > 0:
        return ("SIGN_FLIP_RISK" if strong else "WEAKENING"), "NEGATIVE_GEX_WEAKENING"
    if current_sign == 0 and delta_sign > 0:
        return "FORMING_POSITIVE", "NEW_POSITIVE_STRUCTURE_FORMING"
    if current_sign == 0 and delta_sign < 0:
        return "FORMING_NEGATIVE", "NEW_NEGATIVE_STRUCTURE_FORMING"
    return "STABLE", None


def _tone(regime: str) -> str:
    if regime in {"STABILIZING", "PINNED", "STABILIZING / PINNED"}:
        return "positive"
    if regime in {"GAMMA BOUNDARY", "TRANSITION"}:
        return "caution"
    if regime in {"NEGATIVE GAMMA", "ACCELERATION RISK"}:
        return "negative"
    return "neutral"


def _zone_payload(zone: dict[str, Any] | None) -> dict[str, Any] | None:
    if not zone:
        return None
    return {key: zone.get(key) for key in (
        "lower_strike", "upper_strike", "sign", "aggregate_current_share",
        "aggregate_delta_share", "strongest_strike", "distance_to_spot",
        "spot_relation", "trend", "first_seen", "migration", "priority",
    )}


class GammaReadEngine:
    """Create rich state, then compress it into the stable compact-card contract."""

    def __init__(self, symbol: str, state_path: Path | None = None) -> None:
        self.symbol = str(symbol).upper()
        self.state_path = state_path
        self.state: dict[str, Any] = {
            "schema_version": 2, "symbol": self.symbol, "session_date": None,
            "stable_regime": None, "stable_score": 0.0, "pending_regime": None,
            "pending_count": 0, "last_input_fingerprint": None,
            "previous_current": {}, "previous_delta": {}, "previous_spot": None,
            "last_non_neutral_signs": {}, "dominant_positive": None,
            "dominant_negative": None, "boundary": None, "pin": None,
            "migration_candidates": {}, "previous_zones": [], "last_valid_read": None,
        }
        self._load()

    def _load(self) -> None:
        if not self.state_path or not self.state_path.is_file():
            return
        try:
            loaded = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        if loaded.get("schema_version") == 2 and loaded.get("symbol") == self.symbol:
            self.state.update(loaded)

    def _persist(self) -> None:
        if not self.state_path:
            return
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=self.state_path.parent,
                                         delete=False) as handle:
            json.dump(self.state, handle, sort_keys=True, separators=(",", ":"), allow_nan=False)
            temporary = Path(handle.name)
        os.replace(temporary, self.state_path)

    def _reset(self, session_date: str) -> None:
        path = self.state_path
        symbol = self.symbol
        self.__init__(symbol, None)
        self.state_path = path
        self.state["session_date"] = session_date

    @staticmethod
    def _session_date(value: Any, now: datetime) -> str:
        parsed = _stamp(value) or now
        return parsed.astimezone(ET).date().isoformat()

    def _stale(self, reason: str, *, spot: float | None, current_age: float | None,
               delta_age: float | None, spot_age: float | None, current_as_of: Any,
               delta_as_of: Any, spot_as_of: Any) -> dict[str, Any]:
        prior = self.state.get("last_valid_read")
        result = {
            "contract": CONTRACT, "scope": "0DTE", "regime": "DATA STALE", "tone": "stale",
            "spot": spot, "key_zone": "—", "above": None, "below": None, "callouts": [],
            "read": "Gamma inputs are stale; wait for a fresh read.", "data_state": "STALE",
            "stale_reason": reason, "current_gex_age_ms": current_age,
            "delta_gex_age_ms": delta_age, "spot_age_ms": spot_age,
            "current_gex_as_of": str(current_as_of) if current_as_of else None,
            "delta_gex_as_of": str(delta_as_of) if delta_as_of else None,
            "spot_as_of": str(spot_as_of) if spot_as_of else None,
            "local_balance": None, "local_delta_balance": None, "local_strikes": [],
            "rich_state": {"symbol": self.symbol, "regime": "DATA STALE", "stale_reason": reason},
        }
        if prior:
            result["last_valid_read"] = prior
        return result

    @staticmethod
    def _local_rows(current: dict[float, float], delta: dict[float, float], spot: float
                    ) -> tuple[list[dict[str, Any]], float, float, float, float]:
        strikes = sorted(current)
        diffs = [b - a for a, b in zip(strikes, strikes[1:]) if b > a]
        spacing = median(diffs) if diffs else max(1.0, spot * .001)
        radius = max(spacing * 7, spot * .009)
        local = [strike for strike in strikes if abs(strike - spot) <= radius]
        if len(local) < min(5, len(strikes)):
            local = sorted(strikes, key=lambda strike: (abs(strike - spot), strike))[:min(15, len(strikes))]
        elif len(local) > 15:
            local = sorted(local, key=lambda strike: (abs(strike - spot), strike))[:15]
        local = sorted(local)
        total_abs = sum(abs(current[s]) for s in local)
        total_delta_abs = sum(abs(delta.get(s, 0.0)) for s in local)
        magnitudes = sorted(abs(current[s]) for s in local)
        near = max(spacing * .45, spot * .0007)
        rows: list[dict[str, Any]] = []
        for strike in local:
            value, change = current[strike], delta.get(strike, 0.0)
            share = abs(value) / max(total_abs, 1e-12)
            dshare = abs(change) / max(total_delta_abs, 1e-12)
            percentile = sum(item <= abs(value) for item in magnitudes) / max(len(magnitudes), 1)
            current_class, current_sign = _classify_current(value, share, percentile)
            delta_class, delta_sign = _classify_delta(change, dshare)
            trend, reason = _evolution(current_sign, delta_sign, delta_class)
            distance_steps = abs(strike - spot) / max(spacing, 1e-12)
            distance_weight = 1 / (1 + distance_steps)
            rows.append({
                "strike": strike, "current_gex": value, "delta_gex": change,
                "current_class": current_class, "current_sign_value": current_sign,
                "current_share": share, "current_percentile": percentile,
                "delta_class": delta_class, "delta_sign_value": delta_sign,
                "delta_share": dshare, "evolution": trend, "evolution_reason": reason,
                "distance_from_spot": abs(strike - spot), "strike_steps_from_spot": distance_steps,
                "distance_weight": distance_weight, "position": _position(strike, spot, near),
                "priority": distance_weight * (share + .22 * dshare),
            })
        return rows, spacing, total_abs, total_delta_abs, near

    def _clusters(self, rows: list[dict[str, Any]], spacing: float, spot: float,
                  as_of: str) -> list[dict[str, Any]]:
        meaningful = [row for row in rows if row["current_sign_value"] != 0]
        groups: list[list[dict[str, Any]]] = []
        for row in meaningful:
            if (not groups or row["current_sign_value"] != groups[-1][-1]["current_sign_value"]
                    or row["strike"] - groups[-1][-1]["strike"] > spacing * 1.51):
                groups.append([row])
            else:
                groups[-1].append(row)
        prior_zones = {
            f"{z.get('sign')}:{z.get('lower_strike')}:{z.get('upper_strike')}": z
            for z in self.state.get("previous_zones", [])
        }
        zones: list[dict[str, Any]] = []
        for group in groups:
            sign_value = group[0]["current_sign_value"]
            low, high = group[0]["strike"], group[-1]["strike"]
            sign = "POSITIVE" if sign_value > 0 else "NEGATIVE"
            signed_delta = sum(row["delta_gex"] for row in group)
            delta_share = sum(row["delta_share"] for row in group)
            trend = ("STRENGTHENING" if signed_delta * sign_value > 0 and delta_share >= .06
                     else "WEAKENING" if signed_delta * sign_value < 0 and delta_share >= .06 else "STABLE")
            strongest = max(group, key=lambda row: (row["priority"], row["current_share"]))
            if low <= spot <= high:
                relation, distance = "SPOT_INSIDE", 0.0
            elif spot < low:
                relation, distance = "SPOT_BELOW", low - spot
            else:
                relation, distance = "SPOT_ABOVE", spot - high
            coherence = min(.12, .025 * max(0, len(group) - 1))
            priority = sum(row["current_share"] * row["distance_weight"] for row in group) + coherence
            key = f"{sign}:{low}:{high}"
            prior = prior_zones.get(key)
            zones.append({
                "lower_strike": low, "upper_strike": high, "sign": sign,
                "aggregate_current_share": sum(row["current_share"] for row in group),
                "aggregate_delta_share": delta_share,
                "aggregate_signed_delta": signed_delta, "strongest_strike": strongest["strike"],
                "distance_to_spot": distance, "spot_relation": relation, "trend": trend,
                "first_seen": prior.get("first_seen") if prior else as_of,
                "previous_state": ({field: prior.get(field) for field in
                                    ("trend", "priority", "strongest_strike")} if prior else None),
                "migration": None, "priority": priority, "strike_count": len(group),
            })
        return zones

    @staticmethod
    def _best_zone(zones: list[dict[str, Any]], sign: str) -> dict[str, Any] | None:
        candidates = [zone for zone in zones if zone["sign"] == sign]
        return max(candidates, default=None,
                   key=lambda zone: (zone["priority"], zone["aggregate_current_share"], -zone["distance_to_spot"]))

    @staticmethod
    def _nearest_zone(zones: list[dict[str, Any]], sign: str) -> dict[str, Any] | None:
        candidates = [zone for zone in zones if zone["sign"] == sign]
        return min(candidates, default=None,
                   key=lambda zone: (zone["distance_to_spot"], -zone["priority"]))

    @staticmethod
    def _boundary(zones: list[dict[str, Any]], spot: float, spacing: float) -> dict[str, Any] | None:
        candidates: list[dict[str, Any]] = []
        for left in zones:
            for right in zones:
                if left["upper_strike"] >= right["lower_strike"] or left["sign"] == right["sign"]:
                    continue
                low, high = left["upper_strike"], right["lower_strike"]
                gap = high - low
                if gap > spacing * 4.1 or spot < low - spacing or spot > high + spacing:
                    continue
                strength = min(left["priority"], right["priority"])
                if strength < .035:
                    continue
                candidates.append({
                    "low": low, "high": high, "lower_sign": left["sign"],
                    "upper_sign": right["sign"], "lower_zone": left, "upper_zone": right,
                    "score": strength / (1 + abs(spot - (low + high) / 2) / max(spacing, 1e-12)),
                })
        return max(candidates, default=None, key=lambda item: item["score"])

    def _migration(self, key: str, old: Any, new: Any, *, material: bool) -> str | None:
        candidate = self.state["migration_candidates"].get(key)
        if old is None or new is None:
            self.state["migration_candidates"].pop(key, None)
            return None
        if old == new and not (candidate and candidate.get("value") == new):
            return None
        if not material:
            return None
        count = int(candidate.get("count", 0)) + 1 if candidate and candidate.get("value") == new else 1
        origin = candidate.get("origin") if candidate and candidate.get("value") == new else old
        self.state["migration_candidates"][key] = {"value": new, "origin": origin, "count": count}
        if count < 2:
            return None
        self.state["migration_candidates"].pop(key, None)
        if isinstance(new, list):
            old_mid, new_mid = sum(origin) / 2, sum(new) / 2
            return "BOUNDARY_MIGRATING_UP" if new_mid > old_mid else "BOUNDARY_MIGRATING_DOWN"
        return f"{key.upper()}_MIGRATING_{'UP' if float(new) > float(origin) else 'DOWN'}"

    @staticmethod
    def _primary_level(zone: dict[str, Any] | None, spot: float, direction: str,
                       regime: str) -> dict[str, Any] | None:
        if not zone:
            return None
        level = zone["lower_strike"] if direction == "above" else zone["upper_strike"]
        if zone["sign"] == "POSITIVE":
            label = "STABILIZING" if regime == "GAMMA BOUNDARY" else "DAMPENING"
        else:
            label = "ACCELERATION" if regime in {"GAMMA BOUNDARY", "ACCELERATION RISK"} else "NEGATIVE GAMMA"
        return {"level": _zone(zone["lower_strike"], zone["upper_strike"]), "strike": level,
                "label": label, "current_sign": zone["sign"],
                "current_share": zone["aggregate_current_share"],
                "trend": zone["trend"]}

    def _apply_hysteresis(self, candidate: str, score: float, *, material: bool,
                          immediate: bool) -> tuple[str, dict[str, Any]]:
        stable = self.state.get("stable_regime")
        if stable is None:
            stable = candidate
            self.state.update(stable_regime=stable, stable_score=score, pending_regime=None, pending_count=0)
            return stable, {"candidate": candidate, "pending": False, "reason": "INITIAL_STATE"}
        if candidate == stable:
            self.state.update(stable_score=score, pending_regime=None, pending_count=0)
            return stable, {"candidate": candidate, "pending": False, "reason": "UNCHANGED"}
        if immediate:
            self.state.update(stable_regime=candidate, stable_score=score, pending_regime=None, pending_count=0)
            return candidate, {"candidate": candidate, "pending": False, "reason": "MATERIAL_TRANSITION"}
        if not material:
            return stable, {"candidate": candidate, "pending": True, "reason": "DUPLICATE_SNAPSHOT_HELD"}
        count = int(self.state.get("pending_count", 0)) + 1 if self.state.get("pending_regime") == candidate else 1
        self.state.update(pending_regime=candidate, pending_count=count)
        if count >= 2:
            self.state.update(stable_regime=candidate, stable_score=score, pending_regime=None, pending_count=0)
            return candidate, {"candidate": candidate, "pending": False, "reason": "PERSISTENCE_CONFIRMED"}
        return stable, {"candidate": candidate, "pending": True, "reason": "WAITING_FOR_PERSISTENCE"}

    def update(self, current_gex: dict[float, float] | None,
               delta_gex: dict[float, float] | None, spot: Any, *,
               current_as_of: datetime | str | None,
               delta_as_of: datetime | str | None,
               spot_as_of: datetime | str | None,
               now: datetime | None = None,
               gex_stale_seconds: float = 180,
               spot_stale_seconds: float = 5,
               scope: str = "0DTE") -> dict[str, Any]:
        now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
        current, delta, spot_value = _clean(current_gex), _clean(delta_gex), _finite(spot)
        current_age, delta_age, spot_age = (_age_ms(current_as_of, now), _age_ms(delta_as_of, now),
                                             _age_ms(spot_as_of, now))
        session_date = self._session_date(current_as_of or spot_as_of, now)
        if self.state.get("session_date") != session_date:
            self._reset(session_date)
        stale_kwargs = dict(spot=spot_value, current_age=current_age, delta_age=delta_age,
                            spot_age=spot_age, current_as_of=current_as_of,
                            delta_as_of=delta_as_of, spot_as_of=spot_as_of)
        if str(scope).upper() != "0DTE":
            return self._stale("NON_0DTE_SCOPE", **stale_kwargs)
        if spot_value is None:
            return self._stale("SPOT_UNAVAILABLE", **stale_kwargs)
        if not current:
            return self._stale("CURRENT_GEX_UNAVAILABLE", **stale_kwargs)
        if not delta:
            return self._stale("INTRADAY_DELTA_GEX_UNAVAILABLE", **stale_kwargs)
        if current_age is None or current_age > gex_stale_seconds * 1000:
            return self._stale("CURRENT_GEX_STALE", **stale_kwargs)
        if delta_age is None or delta_age > gex_stale_seconds * 1000:
            return self._stale("INTRADAY_DELTA_GEX_STALE", **stale_kwargs)
        if spot_age is None or spot_age > spot_stale_seconds * 1000:
            return self._stale("SPOT_STALE", **stale_kwargs)

        rows, spacing, total_abs, total_delta_abs, near_band = self._local_rows(current, delta, spot_value)
        if total_abs <= 1e-12:
            return self._stale("CURRENT_GEX_ZERO_MASS", **stale_kwargs)
        as_of = str(current_as_of or now.isoformat())
        fingerprint = _surface_fingerprint(current, delta, spot_value, spacing, current_as_of)
        material = fingerprint != self.state.get("last_input_fingerprint")
        zones = self._clusters(rows, spacing, spot_value, as_of)
        positive = self._best_zone(zones, "POSITIVE")
        negative = self._best_zone(zones, "NEGATIVE")
        near_positive = self._nearest_zone(zones, "POSITIVE")
        near_negative = self._nearest_zone(zones, "NEGATIVE")
        boundary = self._boundary(zones, spot_value, spacing)

        current_balance = sum(row["current_gex"] for row in rows) / max(total_abs, 1e-12)
        delta_balance = sum(row["delta_gex"] for row in rows) / max(total_delta_abs, 1e-12)
        near_rows = [row for row in rows if row["strike_steps_from_spot"] <= 1.3]
        near_pos = sum(row["current_share"] for row in near_rows if row["current_sign_value"] > 0)
        near_neg = sum(row["current_share"] for row in near_rows if row["current_sign_value"] < 0)
        near_delta_pos = sum(row["delta_share"] for row in near_rows if row["delta_sign_value"] > 0)
        near_delta_neg = sum(row["delta_share"] for row in near_rows if row["delta_sign_value"] < 0)

        reasons = {row["evolution_reason"] for row in rows if row.get("evolution_reason")}
        if positive and positive["distance_to_spot"] <= spacing:
            reasons.add("POSITIVE_CLUSTER_NEAR_SPOT")
        if negative and negative["distance_to_spot"] <= spacing:
            reasons.add("NEGATIVE_CLUSTER_NEAR_SPOT")
        if boundary:
            reasons.add("LOCAL_SIGN_BOUNDARY")

        previous_current = {float(k): float(v) for k, v in self.state.get("previous_current", {}).items()}
        last_signs = {str(k): int(v) for k, v in self.state.get("last_non_neutral_signs", {}).items()}
        sign_flips: list[dict[str, Any]] = []
        for row in rows:
            key = str(row["strike"])
            old_value = previous_current.get(row["strike"])
            old_sign = 1 if old_value is not None and old_value > 0 else -1 if old_value is not None and old_value < 0 else last_signs.get(key, 0)
            new_sign = row["current_sign_value"]
            if new_sign and old_sign and new_sign != old_sign and row["current_share"] >= .04:
                code = "POSITIVE_SIGN_FLIP" if new_sign > 0 else "NEGATIVE_SIGN_FLIP"
                sign_flips.append({"strike": row["strike"], "code": code,
                                   "distance_steps": row["strike_steps_from_spot"]})
                reasons.add(code)
            if new_sign:
                last_signs[key] = new_sign

        pin_rows = [row for row in rows if row["current_sign_value"] > 0
                    and row["strike_steps_from_spot"] <= .55
                    and (row["current_share"] >= .12 or
                         (row["delta_sign_value"] > 0 and row["delta_share"] >= .16))]
        pin = max(pin_rows, default=None, key=lambda row: (row["priority"], row["current_share"]))
        if pin:
            reasons.add("PIN_NEAR_SPOT")

        old_pos, new_pos = self.state.get("dominant_positive"), positive.get("strongest_strike") if positive else None
        old_neg, new_neg = self.state.get("dominant_negative"), negative.get("strongest_strike") if negative else None
        old_boundary = self.state.get("boundary")
        new_boundary = [boundary["low"], boundary["high"]] if boundary else None
        old_pin, new_pin = self.state.get("pin"), pin.get("strike") if pin else None
        positive_migration = self._migration("POSITIVE_ZONE", old_pos, new_pos, material=material)
        negative_migration = self._migration("NEGATIVE_ZONE", old_neg, new_neg, material=material)
        boundary_migration = self._migration("BOUNDARY", old_boundary, new_boundary, material=material)
        pin_migration = self._migration("PIN", old_pin, new_pin, material=material)
        for code in (positive_migration, negative_migration, boundary_migration, pin_migration):
            if code:
                reasons.add(code)
        if positive:
            positive["migration"] = positive_migration
        if negative:
            negative["migration"] = negative_migration

        previous_spot = _finite(self.state.get("previous_spot"))
        crossed_boundary = False
        if previous_spot is not None and old_boundary:
            old_low, old_high = old_boundary
            before = -1 if previous_spot < old_low else 1 if previous_spot > old_high else 0
            after = -1 if spot_value < old_low else 1 if spot_value > old_high else 0
            if before != after:
                crossed_boundary = True
                reasons.add("SPOT_CROSSED_BOUNDARY")
        if positive and positive["spot_relation"] == "SPOT_INSIDE":
            reasons.add("SPOT_ENTERED_POSITIVE_ZONE")
        if negative and negative["spot_relation"] == "SPOT_INSIDE":
            reasons.add("SPOT_ENTERED_NEGATIVE_ZONE")

        transition_score = 0.0
        transition_reasons = []
        for row in near_rows:
            if row["evolution"] in {"SIGN_FLIP_RISK", "FORMING_POSITIVE", "FORMING_NEGATIVE"}:
                transition_score += row["priority"] + .15
                transition_reasons.append(row["evolution_reason"])
        if positive and positive["trend"] == "WEAKENING":
            transition_score += min(.3, positive["priority"])
        if negative and negative["trend"] == "WEAKENING":
            transition_score += min(.3, negative["priority"])
        if any((positive_migration, negative_migration, boundary_migration, pin_migration)):
            transition_score += .25

        local_negative_strength = near_neg + max(0.0, -current_balance) * .35
        local_positive_strength = near_pos + max(0.0, current_balance) * .35
        boundary_score = boundary["score"] if boundary else 0.0
        pin_score = pin["priority"] if pin else 0.0
        immediate_flip = any(item["distance_steps"] <= 1.25 for item in sign_flips)
        spot_inside_boundary = bool(boundary and boundary["low"] <= spot_value <= boundary["high"])
        if pin and local_positive_strength >= .20 and not spot_inside_boundary:
            candidate = "STABILIZING / PINNED" if (current_balance >= .16 or near_delta_pos > near_delta_neg) else "PINNED"
            score = min(1.0, .5 + pin_score)
        elif boundary and boundary_score >= .045:
            candidate, score = "GAMMA BOUNDARY", min(1.0, .55 + boundary_score)
        elif local_negative_strength >= .62 and (near_delta_neg >= near_delta_pos * .85 or current_balance <= -.55):
            candidate, score = "ACCELERATION RISK", min(1.0, .55 + local_negative_strength * .5)
        elif local_negative_strength >= .24 and near_neg > near_pos * 1.12:
            candidate, score = "NEGATIVE GAMMA", min(1.0, .45 + local_negative_strength * .5)
        elif transition_score >= .25 and not (immediate_flip or crossed_boundary):
            candidate, score = "TRANSITION", min(1.0, .5 + transition_score)
        elif local_positive_strength >= .20 or (delta_balance >= .28 and current_balance > -.16):
            candidate, score = "STABILIZING", min(1.0, .45 + local_positive_strength * .5)
        else:
            candidate, score = "MIXED", .4
            reasons.add("MIXED_LOCAL_STRUCTURE")

        immediate = immediate_flip or crossed_boundary
        regime, hysteresis = self._apply_hysteresis(candidate, score, material=material, immediate=immediate)

        lower = max((row["strike"] for row in rows if row["strike"] <= spot_value), default=rows[0]["strike"])
        upper = min((row["strike"] for row in rows if row["strike"] >= spot_value), default=rows[-1]["strike"])
        if boundary:
            lower, upper = boundary["low"], boundary["high"]
        elif regime in {"PINNED", "STABILIZING / PINNED"} and pin:
            lower, upper = pin["strike"], min((row["strike"] for row in rows if row["strike"] > pin["strike"]), default=pin["strike"])
        key_zone = _zone(lower, upper)

        above_zones = [zone for zone in zones if zone["lower_strike"] > spot_value]
        below_zones = [zone for zone in zones if zone["upper_strike"] < spot_value]
        above_zone = max(above_zones, default=None, key=lambda zone: (zone["priority"], -zone["distance_to_spot"]))
        below_zone = max(below_zones, default=None, key=lambda zone: (zone["priority"], -zone["distance_to_spot"]))
        above = self._primary_level(above_zone, spot_value, "above", regime)
        below = self._primary_level(below_zone, spot_value, "below", regime)

        callouts: list[dict[str, str]] = []
        if pin:
            callouts.append({"label": "PIN", "level": _level(pin["strike"])})
        if positive and not pin:
            callouts.append({"label": "+GEX", "level": _zone(positive["lower_strike"], positive["upper_strike"])})
        if negative:
            callouts.append({"label": "RISK" if regime in {"NEGATIVE GAMMA", "ACCELERATION RISK"} else "-GEX",
                             "level": _zone(negative["lower_strike"], negative["upper_strike"])})
        callouts = callouts[:2]

        read = self._read_sentence(regime, key_zone, pin, positive, negative, boundary,
                                   positive_migration, negative_migration, boundary_migration,
                                   pin_migration, rows)
        nearest = min(rows, key=lambda row: (row["distance_from_spot"], row["strike"]))
        if nearest["current_sign_value"] < 0 and nearest["delta_sign_value"] > 0:
            distinction = "Current GEX remains negative; positive intraday ΔGEX is weakening that state."
        elif nearest["current_sign_value"] > 0 and nearest["delta_sign_value"] < 0:
            distinction = "Current GEX remains positive; negative intraday ΔGEX is weakening that state."
        else:
            distinction = "Current GEX is state; intraday ΔGEX is evolution since the RTH baseline."

        rich = {
            "engine_version": "GAMMA_READ_INTERPRETATION_ENGINE_V2",
            "symbol": self.symbol, "spot": spot_value, "regime": regime,
            "regime_candidate": candidate, "regime_candidate_score": score,
            "regime_score": float(self.state.get("stable_score", score)),
            "regime_reason_codes": sorted(reason for reason in reasons if reason),
            "key_zone_low": lower, "key_zone_high": upper,
            "above_zone": _zone_payload(above_zone), "below_zone": _zone_payload(below_zone),
            "pin_candidate": pin.get("strike") if pin else None,
            "pin_strength": pin.get("priority") if pin else None, "pin_migration": pin_migration,
            "strongest_positive_zone": _zone_payload(positive),
            "strongest_negative_zone": _zone_payload(negative),
            "nearest_positive_zone": _zone_payload(near_positive),
            "nearest_negative_zone": _zone_payload(near_negative),
            "local_current_gamma_balance": _bounded(current_balance),
            "local_delta_gamma_balance": _bounded(delta_balance),
            "positive_zone_trend": positive.get("trend") if positive else None,
            "negative_zone_trend": negative.get("trend") if negative else None,
            "dominant_positive_migration": positive_migration,
            "dominant_negative_migration": negative_migration,
            "boundary_state": {key: boundary.get(key) for key in ("low", "high", "lower_sign", "upper_sign", "score")} if boundary else None,
            "boundary_migration": boundary_migration, "sign_flip_events": sign_flips,
            "transition_state": {"score": transition_score, "reasons": sorted(set(filter(None, transition_reasons))),
                                 "hysteresis": hysteresis},
            "current_gex_timestamp": str(current_as_of) if current_as_of else None,
            "delta_gex_timestamp": str(delta_as_of) if delta_as_of else None,
            "spot_timestamp": str(spot_as_of) if spot_as_of else None,
            "per_strike": rows, "zones": [_zone_payload(zone) for zone in zones],
        }
        output = {
            "contract": CONTRACT, "scope": "0DTE", "regime": regime, "tone": _tone(regime),
            "spot": spot_value, "key_zone": key_zone, "above": above, "below": below,
            "callouts": callouts, "read": read, "data_state": "LIVE", "stale_reason": None,
            "current_gex_age_ms": current_age, "delta_gex_age_ms": delta_age,
            "spot_age_ms": spot_age, "current_gex_as_of": str(current_as_of) if current_as_of else None,
            "delta_gex_as_of": str(delta_as_of) if delta_as_of else None,
            "spot_as_of": str(spot_as_of) if spot_as_of else None,
            "local_balance": _bounded(current_balance), "local_delta_balance": _bounded(delta_balance),
            "local_strikes": [row["strike"] for row in rows], "nearest_strike": nearest["strike"],
            "nearest_current_sign": "POSITIVE" if nearest["current_sign_value"] > 0 else "NEGATIVE" if nearest["current_sign_value"] < 0 else "NEUTRAL",
            "nearest_delta_sign": "POSITIVE" if nearest["delta_sign_value"] > 0 else "NEGATIVE" if nearest["delta_sign_value"] < 0 else "NEUTRAL",
            "strongest_positive_current": positive, "strongest_negative_current": negative,
            "current_vs_delta_read": distinction, "rich_state": rich,
        }

        self.state.update({
            "session_date": session_date, "last_input_fingerprint": fingerprint,
            "previous_current": {str(k): v for k, v in current.items()},
            "previous_delta": {str(k): v for k, v in delta.items()}, "previous_spot": spot_value,
            "last_non_neutral_signs": last_signs,
            "dominant_positive": new_pos, "dominant_negative": new_neg,
            "boundary": new_boundary, "pin": new_pin,
            "previous_zones": [_zone_payload(zone) for zone in zones],
            "last_valid_read": {key: output.get(key) for key in
                                ("regime", "key_zone", "read", "current_gex_as_of")},
        })
        if material or immediate:
            self._persist()
        return output

    @staticmethod
    def _read_sentence(regime: str, key_zone: str, pin: dict[str, Any] | None,
                       positive: dict[str, Any] | None, negative: dict[str, Any] | None,
                       boundary: dict[str, Any] | None, positive_migration: str | None,
                       negative_migration: str | None, boundary_migration: str | None,
                       pin_migration: str | None, rows: list[dict[str, Any]]) -> str:
        if boundary_migration:
            return "Gamma boundary is shifting higher." if boundary_migration.endswith("UP") else "Gamma boundary is shifting lower."
        if pin_migration:
            return f"The local gamma pin is migrating toward {_level(pin['strike'])}." if pin else "The local gamma pin is migrating."
        if positive_migration:
            return ("Positive gamma concentration is migrating upward." if positive_migration.endswith("UP")
                    else "Positive gamma concentration is migrating downward.")
        if negative_migration:
            return ("Negative gamma concentration is migrating upward." if negative_migration.endswith("UP")
                    else "Negative gamma concentration is migrating downward.")
        weakening_negative = negative and negative.get("trend") == "WEAKENING"
        weakening_positive = positive and positive.get("trend") == "WEAKENING"
        if weakening_negative and pin:
            return f"Negative gamma is weakening; {_level(pin['strike'])} remains the local pin."
        if weakening_positive and boundary:
            return "Positive gamma is weakening; boundary risk is increasing."
        if regime == "TRANSITION":
            return "Local gamma structure is transitioning; wait for cleaner separation."
        if regime == "GAMMA BOUNDARY":
            return f"Wait inside {key_zone}; break defines the gamma regime."
        if regime == "STABILIZING":
            return f"Avoid chasing while price remains inside {key_zone}."
        if regime == "PINNED":
            return f"Price is near a gamma pin at {_level(pin['strike']) if pin else key_zone}."
        if regime == "STABILIZING / PINNED":
            return f"Avoid chasing near the {_level(pin['strike']) if pin else key_zone} gamma pin."
        reference = negative["strongest_strike"] if negative else rows[0]["strike"]
        if regime == "ACCELERATION RISK":
            return f"Near {_level(reference)}, acceleration risk rises if price accepts through."
        if regime == "NEGATIVE GAMMA":
            return f"Near {_level(reference)}, movement may become less damped."
        return "Gamma structure is mixed; wait for cleaner separation."


def build_gamma_read_v2(current_gex: dict[float, float] | None,
                        delta_gex: dict[float, float] | None, spot: Any, **kwargs: Any
                        ) -> dict[str, Any]:
    """Stateless convenience entry point for deterministic tests and diagnostics."""
    return GammaReadEngine(str(kwargs.pop("symbol", "UNKNOWN"))).update(
        current_gex, delta_gex, spot, **kwargs)
