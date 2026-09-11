"""Four-model event-triggered frozen inference and decision-state service."""

from __future__ import annotations

import hashlib
import json
import math
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .artifacts import FrozenModelFleet
from .cadence import PreparedCadenceCandidate
from .calendar import ExchangeSessionCalendar
from .direct_mfe import SURFACE_CONTRACT, rounded_aim_for_by_horizon
from .features import FeatureUnavailable, LiveFeatureEngine, OptionPrint
from .forward_store import AsyncForwardRecorder, AsyncPublishQueue
from .gex import GexSessionState
from .gamma_read_v2 import GammaReadEngine
from .mapping import TargetLadderMapping
from .policies import (InvalidationMachine, ThesisState, choose_contract,
                       gamma_regime, grade_for_probability, market_condition,
                       target_premium)
from .providers.contracts import candidate_delta_band, quote_valid
from .provider_health import PROVIDER_HEALTH_ID_SET
from .signal_episodes import SignalEpisodeBook


MODEL_FUTURES = {
    "SPY_OPTIONS_ONLY": None,
    "SPY_OPTIONS_PLUS_ES": "ES",
    "QQQ_OPTIONS_ONLY": None,
    "QQQ_OPTIONS_PLUS_NQ": "NQ",
}


@dataclass
class ModelDecision:
    model_id: str
    model_version: str
    symbol: str
    state: str
    guidance_state: str
    thesis_state: str
    setup_episode_id: str | None
    direction: str
    grade: str | None
    probability: float | None
    grade_probability: float | None
    surface_contract: str
    uncalibrated_probability_surface: dict[str, float]
    raw_probability_surface: dict[str, float]
    display_probability_surface: dict[str, float]
    raw_aim_for_by_horizon: dict[str, float]
    aim_for_percent_by_horizon: dict[str, int] | None
    selected_contract_probability_at_selection: float | None
    selected_contract_event_time: str | None
    latest_same_side_probability: float | None
    latest_same_side_event_time: str | None
    latest_same_side_age_ms: float | None
    latest_same_side_fresh: bool
    latest_opposite_side_probability: float | None
    latest_opposite_side_event_time: str | None
    latest_opposite_side_age_ms: float | None
    latest_opposite_side_fresh: bool
    probability_language: str
    aim_for_percent: int | None
    target_premium: float | None
    ladder: dict[str, float]
    ladder_language: str
    candidate_contract: str | None
    expiration: str | None
    strike: float | None
    delta: float | None
    bid: float | None
    ask: float | None
    relative_spread: float | None
    model_event_time: str | None
    model_age_ms: float | None
    latest_quote_time: str | None
    quote_age_ms: float | None
    invalid_if: str | None
    invalidation_reason: str | None
    feature_hash: str | None
    latency_ms: dict[str, float]
    score_band: str | None
    mapping_effective_n: float | None
    candidate_delta_band: str | None = None
    current_session_volume: float | None = None
    contract_selection_reason: str | None = None
    option_entry_price: float | None = None
    option_entry_time: str | None = None
    current_option_return: float | None = None


class PredictiveLiveService:
    def __init__(self, fleet: FrozenModelFleet, mapping: TargetLadderMapping | None,
                 features: LiveFeatureEngine, recorder: AsyncForwardRecorder,
                 publisher: AsyncPublishQueue, *, config: dict[str, Any] | None = None,
                 live_root: Path | None = None,
                 calendar: ExchangeSessionCalendar | None = None,
                 telegram: Any | None = None) -> None:
        self.fleet = fleet; self.mapping = mapping; self.features = features
        self.recorder = recorder; self.publisher = publisher
        self.config = config or {"staleness_seconds": {"quant_option_event": 90,
            "webull_quote": 5, "ninjatrader_futures": 3, "quant_context": 180,
            "v2_structure": 5}}
        self.staleness = self.config["staleness_seconds"]
        self.live_root = (live_root or Path.home() / "Documents" / "TradyticsPredictiveLive").resolve()
        self.calendar = calendar or ExchangeSessionCalendar()
        self.telegram = telegram
        lifecycle = self.config.get("signal_lifecycle", {})
        self.signal_episodes = SignalEpisodeBook(
            self.live_root / lifecycle.get("state_path", "state/signal_episodes_1dte_v1.json"),
            tracking_minutes=int(lifecycle.get("tracking_minutes", 30)),
        )
        self.latest_underlying: dict[str, float] = {}
        self.latest_underlying_time: dict[str, str] = {}
        self.latest_underlying_source: dict[str, str] = {}
        # Keep the provider spot delivered with each GEX snapshot as an honest
        # fallback for Gamma Read.  Cash quotes can legitimately remain at the
        # same provider timestamp for more than five seconds; that must not
        # make a fresh 30-second GEX snapshot appear stale.
        self.latest_gex_spot: dict[str, float] = {}
        self.latest_gex_spot_time: dict[str, str] = {}
        self.decisions: dict[str, ModelDecision] = {}
        self.provider_health: dict[str, dict[str, Any]] = {}
        self.provider_clocks: dict[str, dict[str, Any]] = {}
        self.invalidations: dict[str, InvalidationMachine] = {}
        self.setup_entries: dict[str, dict[str, Any]] = {}
        self.rearm_ready: dict[str, bool] = {}
        self.episode_sequence: dict[str, int] = {}
        self.quotes: dict[str, dict[str, Any]] = {}
        self.candidate_pool: dict[str, dict[str, dict[str, Any]]] = {key: {} for key in MODEL_FUTURES}
        self.selected_contracts: dict[str, dict[str, Any]] = {}
        self.latest_side_evidence: dict[str, dict[str, dict[str, Any] | None]] = {
            key: {"CALL": None, "PUT": None} for key in MODEL_FUTURES
        }
        self.best_sides: dict[str, dict[str, dict[str, Any] | None]] = {
            key: {"CALL": None, "PUT": None} for key in MODEL_FUTURES
        }
        self.invalidated_at_event_ms: dict[str, int] = {}
        self.last_thesis_same_event: dict[str, tuple[int, str]] = {}
        self.structure_state: dict[str, dict[str, Any]] = {}
        self.option_warm = {"SPY": False, "QQQ": False}
        self.ladder_cache: dict[str, dict[str, Any]] = {}
        self.contract_context_cache: dict[str, dict[str, Any]] = {}
        self.active_expiration: dict[str, str] = {}
        self.gex = {
            symbol: GexSessionState(self.live_root / "state" / f"gex_rth_baseline_{symbol}.json")
            for symbol in ("SPY", "QQQ")
        }
        self.gamma_read_engines = {
            symbol: GammaReadEngine(
                symbol, self.live_root / "state" / f"gamma_read_v2_{symbol}.json"
            ) for symbol in ("SPY", "QQQ")
        }
        self.market_context: dict[str, dict[str, Any]] = {}
        self.update_provider_health("MODEL_ARTIFACTS", status="VERIFIED", age_ms=0,
                                    detail="All four frozen hashes verified at process startup")

    @staticmethod
    def _feature_hash(vector: dict[str, Any]) -> str:
        normalized = {key: (None if isinstance(value, float) and not math.isfinite(value) else value)
                      for key, value in vector.items()}
        return hashlib.sha256(json.dumps(normalized, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()

    def _publish_signal_rows(self, rows: list[dict[str, Any]]) -> None:
        for row in rows:
            self.recorder.submit("signal_episodes", row)
            self.publisher.submit("predictive_signal_episode_live", row)

    def _sync_signal_decision(self, payload: dict[str, Any]) -> None:
        book = getattr(self, "signal_episodes", None)
        if book is None:
            return
        changed: list[dict[str, Any]] = []
        if payload.get("thesis_state") == ThesisState.INVALIDATED.value:
            changed.extend(book.invalidate_setup(
                str(payload["model_id"]), payload.get("setup_episode_id"),
                payload.get("invalidation_reason") or "SETUP_INVALIDATED",
            ))
        row, _created = book.sync_decision(payload)
        if row is not None:
            changed.append(row)
        if changed:
            # One key can be touched by invalidation and the selected-row sync;
            # publish only its final state.
            self._publish_signal_rows(list({item["id"]: item for item in changed}.values()))

    @staticmethod
    def _age_ms(stamp: str | None, now: datetime | None = None) -> float | None:
        if not stamp:
            return None
        try:
            parsed = datetime.fromisoformat(str(stamp).replace("Z", "+00:00")).astimezone(timezone.utc)
        except (TypeError, ValueError):
            return None
        return max(0.0, ((now or datetime.now(timezone.utc)) - parsed).total_seconds() * 1000)

    @staticmethod
    def _option_return(entry_price: float | None, current_bid: float | None) -> float | None:
        """Conservative long-option mark: current executable bid / entry ask - 1."""
        try:
            entry = float(entry_price); bid = float(current_bid)
        except (TypeError, ValueError):
            return None
        if not math.isfinite(entry) or not math.isfinite(bid) or entry <= 0 or bid < 0:
            return None
        return bid / entry - 1.0

    def set_option_warmup(self, symbol: str, ready: bool, detail: str = "") -> None:
        """Track model readiness without misreporting provider transport health."""
        self.option_warm[symbol.upper()] = bool(ready)

    def update_provider_health(self, provider: str, *, status: str, age_ms: float | None,
                               detail: str = "", event_time: str | None = None,
                               receipt_time: str | None = None) -> None:
        if provider not in PROVIDER_HEALTH_ID_SET:
            raise ValueError(f"Provider is not in PREDICTIVE_PROVIDER_HEALTH_V1: {provider}")
        now = datetime.now(timezone.utc).isoformat()
        clock = self.provider_clocks.setdefault(provider, {})
        if receipt_time:
            clock["last_successful_request_time"] = receipt_time
        if event_time:
            clock["last_real_provider_event_time"] = event_time
        payload = {"provider": provider, "status": status, "age_ms": age_ms,
                   "detail": detail, "as_of": now, **clock}
        self.provider_health[provider] = payload
        self.recorder.submit("provider_health", payload)
        self.publisher.submit("predictive_provider_health_live", payload)

    def prepare_candidate(self, candidate: OptionPrint, *, cadence_seconds: int,
                          session_open_ms: int) -> PreparedCadenceCandidate:
        if cadence_seconds != 60:
            raise ValueError("Production inference requires frozen cadence_60s")
        valid, reason, _bounds = self.calendar.actionable_y30(candidate.event_time_ms)
        if not valid:
            raise ValueError(reason)
        if not self.option_warm[candidate.symbol]:
            raise FeatureUnavailable("MODEL_WARMUP")
        snapshots: dict[str, dict[str, Any]] = {}
        for model_id, futures_source in MODEL_FUTURES.items():
            if not model_id.startswith(candidate.symbol):
                continue
            try:
                if futures_source and len(self.features.futures[futures_source].completed) < 120:
                    raise FeatureUnavailable(f"MODEL_WARMUP_{futures_source}_120S")
                vector = self.features.build(candidate, cadence_seconds=60,
                    session_open_ms=session_open_ms, futures_source=futures_source,
                    allowlist=self.fleet.features_for(model_id))
                snapshots[model_id] = vector
            except (FeatureUnavailable, ValueError, RuntimeError) as exc:
                snapshots[model_id] = {"__error__": str(exc)}
        width = cadence_seconds * 1000
        bucket = (candidate.event_time_ms - session_open_ms) // width
        return PreparedCadenceCandidate(candidate, session_open_ms, bucket,
                                         session_open_ms + bucket * width, snapshots)

    def ingest_context(self, event: OptionPrint) -> None:
        if event.stock_price is not None and math.isfinite(float(event.stock_price)):
            self.latest_underlying[event.symbol] = float(event.stock_price)
            self.latest_underlying_time[event.symbol] = datetime.fromtimestamp(
                event.event_time_ms / 1000, timezone.utc).isoformat()
            self.latest_underlying_source[event.symbol] = "QUANT_OPTION_PRINT"
        self.features.record_candidate_event(event)
        greeks = event.fields.get("greeks") if isinstance(event.fields.get("greeks"), dict) else {}
        self.contract_context_cache[event.osi] = {
            "delta": event.delta, "gamma": greeks.get("gamma"), "theta": greeks.get("theta"),
            "vega": greeks.get("vega"), "vanna": greeks.get("vanna"), "charm": greeks.get("charm"),
            "iv": event.fields.get("impliedVolatility"),
            "greek_context_time": datetime.fromtimestamp(event.event_time_ms/1000, timezone.utc).isoformat(),
        }

    def _new_machine(self, model_id: str, direction: str, grade: str,
                     level: float | None, candidate: OptionPrint) -> InvalidationMachine:
        sequence = self.episode_sequence.get(model_id, 0) + 1
        self.episode_sequence[model_id] = sequence
        episode_id = hashlib.sha256(
            f"{model_id}|{candidate.event_time_ms}|{candidate.osi}|{sequence}".encode()
        ).hexdigest()[:20]
        machine = InvalidationMachine(direction, {"A": .25, "B": .15, "C": .10}[grade],
                                      level, setup_episode_id=episode_id)
        self.invalidations[model_id] = machine; self.rearm_ready[model_id] = False
        return machine

    def _refresh_pool_quotes(self, model_id: str, now: datetime) -> list[dict[str, Any]]:
        maximum_age = float(self.staleness["quant_option_event"])
        fresh: list[dict[str, Any]] = []
        for contract, row in tuple(self.candidate_pool[model_id].items()):
            if (now.timestamp() * 1000 - row["event_time_ms"]) / 1000 > maximum_age:
                del self.candidate_pool[model_id][contract]; continue
            quote = self.quotes.get(contract)
            okay, _reason = quote_valid(quote, max_age_seconds=float(self.staleness["webull_quote"]), now=now)
            row = dict(row); row["quote_valid"] = okay
            ladder = self.ladder_cache.get(contract, {})
            row["current_session_volume"] = ladder.get("volume")
            if okay:
                bid, ask = float(quote["bid"]), float(quote["ask"])
                row.update({"bid": bid, "ask": ask, "relative_spread": (ask-bid)/((ask+bid)/2) if ask+bid else math.inf,
                            "latest_quote_time": quote.get("quote_time")})
            self.candidate_pool[model_id][contract] = row; fresh.append(row)
        for side in ("CALL", "PUT"):
            self.best_sides[model_id][side] = choose_contract([row for row in fresh if row["direction"] == side])
        return fresh

    @staticmethod
    def _record_stamp(row: dict[str, Any] | None) -> str | None:
        if row is None:
            return None
        return datetime.fromtimestamp(int(row["event_time_ms"]) / 1000, timezone.utc).isoformat()

    def _evidence(self, model_id: str, direction: str, now: datetime) -> tuple[dict[str, Any] | None, float | None, bool]:
        row = self.latest_side_evidence[model_id][direction]
        age_ms = None if row is None else max(0.0, now.timestamp() * 1000 - int(row["event_time_ms"]))
        fresh = age_ms is not None and age_ms <= float(self.staleness["quant_option_event"]) * 1000
        return row, age_ms, fresh

    def _quoted_record(self, row: dict[str, Any], now: datetime) -> dict[str, Any]:
        result = dict(row)
        result["current_session_volume"] = self.ladder_cache.get(str(row["contract"]), {}).get("volume")
        quote = self.quotes.get(str(row["contract"]))
        okay, _reason = quote_valid(quote, max_age_seconds=float(self.staleness["webull_quote"]), now=now)
        result["quote_valid"] = okay
        if okay:
            bid, ask = float(quote["bid"]), float(quote["ask"])
            result.update({"bid": bid, "ask": ask,
                           "relative_spread": (ask-bid)/((ask+bid)/2) if ask+bid else math.inf,
                           "latest_quote_time": quote.get("quote_time")})
        return result

    def _select_contract(self, model_id: str, direction: str,
                         incoming: dict[str, Any] | None, now: datetime,
                         rows: list[dict[str, Any]]) -> dict[str, Any] | None:
        current = self.selected_contracts.get(model_id)
        candidates: list[dict[str, Any]] = []
        if current is not None and current.get("direction") == direction:
            candidates.append(self._quoted_record(current, now))
        if incoming is not None and incoming.get("direction") == direction:
            candidates.append(self._quoted_record(incoming, now))
        if not candidates or not any(row.get("quote_valid") for row in candidates):
            candidates.extend(row for row in rows if row.get("direction") == direction)
        chosen = choose_contract(candidates)
        if chosen is None:
            return current if current is not None and current.get("direction") == direction else None
        if (current is None or current.get("contract") != chosen.get("contract") or
                int(current.get("event_time_ms", -1)) != int(chosen.get("event_time_ms", -2))):
            chosen = dict(chosen)
            chosen["selected_contract_probability_at_selection"] = float(chosen["model_probability"])
            chosen["contract_selection_reason"] = (
                "MODEL_PROBABILITY_1BP_EQUIVALENCE_THEN_RELATIVE_SPREAD_"
                "THEN_CURRENT_SESSION_VOLUME_THEN_DELTA_DISTANCE_TO_065_THEN_CONTRACT_ID"
            )
            self.selected_contracts[model_id] = chosen
        else:
            refreshed = dict(chosen)
            refreshed["selected_contract_probability_at_selection"] = current.get(
                "selected_contract_probability_at_selection", current["model_probability"]
            )
            refreshed["contract_selection_reason"] = current.get(
                "contract_selection_reason",
                "MODEL_PROBABILITY_1BP_EQUIVALENCE_THEN_RELATIVE_SPREAD_"
                "THEN_CURRENT_SESSION_VOLUME_THEN_DELTA_DISTANCE_TO_065_THEN_CONTRACT_ID",
            )
            chosen = refreshed
            self.selected_contracts[model_id] = chosen
        return chosen

    def update_structure_state(self, symbol: str, structure: dict[str, Any]) -> None:
        symbol = symbol.upper()
        self.structure_state[symbol] = dict(structure)
        provider = f"V2_STRUCTURE_{symbol}"
        stamp = structure.get("as_of")
        age_ms = self._age_ms(stamp)
        verified = (structure.get("source") == "TRUSTED_DETERMINISTIC_V2_READ_ONLY"
                    and age_ms is not None)
        live = verified and age_ms <= float(self.staleness.get("v2_structure", 5)) * 1000
        self.update_provider_health(provider, status="LIVE" if live else "STALE" if verified else "UNAVAILABLE",
                                    age_ms=age_ms,
                                    detail="" if live else "V2_STRUCTURE_STALE" if verified else "V2_STRUCTURE_UNAVAILABLE",
                                    event_time=stamp if verified else None,
                                    receipt_time=datetime.now(timezone.utc).isoformat())

    def _dependencies_live(self, model_id: str, symbol: str) -> bool:
        dependencies = ["QUANT_DATA", "WEBULL", f"V2_STRUCTURE_{symbol}"]
        if MODEL_FUTURES[model_id]:
            dependencies.append(f"NINJATRADER_{MODEL_FUTURES[model_id]}")
        return all(self.provider_health.get(name, {}).get("status") in {"LIVE", "VERIFIED"}
                   for name in dependencies)

    def _guidance_from_current_health(self, model_id: str, symbol: str, *,
                                      quote_ok: bool, quote_reason: str | None,
                                      same_side_fresh: bool) -> tuple[str, str | None]:
        """Return one stable data/guidance state for quote and sweep paths."""
        if not same_side_fresh:
            return "STALE", "LATEST_SAME_SIDE_MODEL_EVIDENCE_STALE_OR_UNAVAILABLE"
        if not quote_ok:
            reason = str(quote_reason or "OPTION_QUOTE_INVALID")
            return ("STALE" if "STALE" in reason.upper() else "BLOCKED"), reason
        dependencies = ["QUANT_DATA", "WEBULL", f"V2_STRUCTURE_{symbol}"]
        if MODEL_FUTURES[model_id]:
            dependencies.append(f"NINJATRADER_{MODEL_FUTURES[model_id]}")
        unhealthy = [self.provider_health.get(name, {}).get("status") for name in dependencies
                     if self.provider_health.get(name, {}).get("status") not in {"LIVE", "VERIFIED"}]
        if not unhealthy:
            return "LIVE", None
        state = "STALE" if all(status == "STALE" for status in unhealthy) else "BLOCKED"
        return state, "REQUIRED_PROVIDER_OR_STRUCTURE_STALE"

    def _structure_live(self, structure: dict[str, Any], now: datetime) -> bool:
        age_ms = self._age_ms(structure.get("as_of"), now)
        if age_ms is None and structure.get("age_ms") is not None:
            age_ms = float(structure["age_ms"])
        return (structure.get("source") == "TRUSTED_DETERMINISTIC_V2_READ_ONLY" and
                age_ms is not None and age_ms <= float(self.staleness.get("v2_structure", 5)) * 1000)

    def _decision_from_record(self, model_id: str, selected: dict[str, Any],
                              structure: dict[str, Any], receive_ns: int,
                              incoming: dict[str, Any] | None = None) -> ModelDecision:
        now = datetime.now(timezone.utc)
        machine = self.invalidations.get(model_id)
        direction = machine.direction if machine is not None else str(selected["direction"])
        same, same_age_ms, same_fresh = self._evidence(model_id, direction, now)
        opposite_direction = "PUT" if direction == "CALL" else "CALL"
        opposite, opposite_age_ms, opposite_fresh = self._evidence(model_id, opposite_direction, now)
        probability = float(same["model_probability"]) if same is not None else None
        grade = grade_for_probability(probability) if probability is not None else None
        quote = self.quotes.get(selected["contract"])
        quote_ok, quote_reason = quote_valid(quote, max_age_seconds=float(self.staleness["webull_quote"]), now=now)
        level = structure.get("call_invalidation_level" if direction == "CALL" else "put_invalidation_level")
        if machine is None and grade and quote_ok and same is not None:
            machine = self._new_machine(model_id, direction, grade, level, same["event"])
        previous_thesis = machine.state if machine else ThesisState.HOLD
        structure_live = self._structure_live(structure, now)
        evidence_key = None if same is None else (int(same["event_time_ms"]), str(same["contract"]))
        advance_weak = (incoming is not None and incoming.get("direction") == direction and
                        evidence_key is not None and self.last_thesis_same_event.get(model_id) != evidence_key)
        if machine and quote_ok and same_fresh and structure_live and probability is not None:
            machine.support_or_resistance = level
            accepted = bool(structure.get("accepted_below" if direction == "CALL" else "accepted_above"))
            machine.update(current_probability=probability,
                           opposite_probability=float(opposite["model_probability"]) if opposite is not None and opposite_fresh else None,
                           structure_bias=str(structure.get("structure_bias") or "TRANSITION / MIXED"),
                           accepted_structure_break=accepted, wick_only=False, data_valid=True,
                           advance_weak_count=advance_weak)
            if advance_weak and evidence_key is not None:
                self.last_thesis_same_event[model_id] = evidence_key
            if previous_thesis != ThesisState.INVALIDATED and machine.state == ThesisState.INVALIDATED:
                self.invalidated_at_event_ms[model_id] = int(incoming["event_time_ms"] if incoming else same["event_time_ms"])
                self.rearm_ready[model_id] = False
            if machine.state != previous_thesis:
                self.recorder.submit("invalidation_events", {
                    "model_id": model_id, "setup_episode_id": machine.setup_episode_id,
                    "previous_state": previous_thesis.value, "state": machine.state.value,
                    "reason": machine.reason, "current_score": probability,
                    "opposite_score": float(opposite["model_probability"]) if opposite is not None and opposite_fresh else None,
                    "same_side_event_time": self._record_stamp(same),
                    "opposite_side_event_time": self._record_stamp(opposite),
                    "timestamp": now.isoformat(),
                })
        thesis = machine.state if machine else ThesisState.HOLD
        guidance = "LIVE" if quote_ok else "BLOCKED"
        if not structure_live:
            guidance = "BLOCKED"; quote_reason = "V2_STRUCTURE_UNAVAILABLE_OR_STALE"
        if not same_fresh:
            guidance = "STALE"; quote_reason = "LATEST_SAME_SIDE_MODEL_EVIDENCE_STALE_OR_UNAVAILABLE"
        if not self._dependencies_live(model_id, selected["symbol"]):
            guidance = "BLOCKED"; quote_reason = "REQUIRED_PROVIDER_OR_STRUCTURE_STALE"
        if MODEL_FUTURES[model_id]:
            health = self.provider_health.get(f"NINJATRADER_{MODEL_FUTURES[model_id]}", {})
            if health.get("status") != "LIVE":
                guidance = "BLOCKED"; quote_reason = f"NINJATRADER_{MODEL_FUTURES[model_id]}_STALE"
        state = thesis.value if guidance == "LIVE" else guidance
        ladder = same["ladder"] if same is not None else selected["ladder"]
        evidence = same or selected
        raw_surface = dict(evidence["raw_probability_surface"])
        display_surface = dict(evidence["display_probability_surface"])
        uncalibrated_surface = dict(evidence["uncalibrated_probability_surface"])
        raw_aims = dict(evidence["raw_aim_for_by_horizon"])
        display_aims = dict(evidence["display_aim_for_percent_by_horizon"])
        actionable = grade is not None and quote_ok and guidance == "LIVE" and thesis != ThesisState.INVALIDATED
        bid = float(quote["bid"]) if quote_ok else None; ask = float(quote["ask"]) if quote_ok else None
        entry = self.setup_entries.get(model_id)
        entry_matches = bool(
            entry and machine and entry.get("setup_episode_id") == machine.setup_episode_id and
            entry.get("contract") == selected["contract"]
        )
        if not entry_matches:
            self.setup_entries.pop(model_id, None)
            entry = None
            if actionable and machine is not None and ask is not None:
                entry = {
                    "setup_episode_id": machine.setup_episode_id,
                    "contract": selected["contract"],
                    "price": ask,
                    "time": now.isoformat(),
                }
                self.setup_entries[model_id] = entry
        timings = dict((same or selected)["latency_ms"])
        timings["full_local_decision"] = (time.perf_counter_ns() - receive_ns) / 1e6
        return ModelDecision(
            model_id=model_id, model_version=self.fleet.versions[model_id], symbol=selected["symbol"],
            state=state, guidance_state=guidance, thesis_state=thesis.value,
            setup_episode_id=machine.setup_episode_id if machine else None,
            direction=direction if machine is not None or grade else "NO SETUP", grade=grade, probability=probability,
            grade_probability=probability, surface_contract=SURFACE_CONTRACT,
            uncalibrated_probability_surface=uncalibrated_surface,
            raw_probability_surface=raw_surface, display_probability_surface=display_surface,
            raw_aim_for_by_horizon=raw_aims,
            aim_for_percent_by_horizon=display_aims if actionable else None,
            selected_contract_probability_at_selection=float(selected.get("selected_contract_probability_at_selection",
                                                                          selected["model_probability"])),
            selected_contract_event_time=self._record_stamp(selected),
            latest_same_side_probability=probability,
            latest_same_side_event_time=self._record_stamp(same),
            latest_same_side_age_ms=same_age_ms, latest_same_side_fresh=same_fresh,
            latest_opposite_side_probability=float(opposite["model_probability"]) if opposite is not None else None,
            latest_opposite_side_event_time=self._record_stamp(opposite),
            latest_opposite_side_age_ms=opposite_age_ms, latest_opposite_side_fresh=opposite_fresh,
            probability_language="P(historical proxy observed-bid MFE >= target by horizon)",
            aim_for_percent=display_aims["30"] if actionable else None,
            target_premium=target_premium(ask, ladder) if actionable and ask else None,
            ladder={str(key): value for key, value in ladder.items()},
            ladder_language="Direct historical proxy probability of observed-bid MFE by target and horizon",
            candidate_contract=selected["contract"], expiration=selected["expiration"], strike=selected["strike"],
            delta=selected["delta"], bid=bid, ask=ask, relative_spread=selected.get("relative_spread"),
            model_event_time=self._record_stamp(same), model_age_ms=same_age_ms,
            latest_quote_time=quote.get("quote_time") if quote_ok else None,
            quote_age_ms=self._age_ms(quote.get("quote_time"), now) if quote_ok else None,
            invalid_if=machine.invalid_if_text() if machine else None,
            invalidation_reason=machine.reason if thesis == ThesisState.INVALIDATED else None if quote_ok else quote_reason,
            feature_hash=(same or selected)["feature_hash"], latency_ms=timings,
            score_band=(same or selected)["score_band"], mapping_effective_n=(same or selected)["mapping_effective_n"],
            candidate_delta_band=candidate_delta_band(float(selected["delta"])),
            current_session_volume=(None if selected.get("current_session_volume") is None else
                                    float(selected["current_session_volume"])),
            contract_selection_reason=selected.get("contract_selection_reason"),
            option_entry_price=None if entry is None else float(entry["price"]),
            option_entry_time=None if entry is None else str(entry["time"]),
            current_option_return=self._option_return(None if entry is None else entry["price"], bid),
        )

    def process_cadence_candidate(self, prepared: PreparedCadenceCandidate,
                                  structure: dict[str, Any]) -> list[ModelDecision]:
        receive_ns = time.perf_counter_ns(); event = prepared.event
        if event.stock_price is not None and math.isfinite(float(event.stock_price)):
            self.latest_underlying[event.symbol] = float(event.stock_price)
            self.latest_underlying_time[event.symbol] = datetime.fromtimestamp(
                event.event_time_ms / 1000, timezone.utc).isoformat()
            self.latest_underlying_source[event.symbol] = "QUANT_OPTION_PRINT"
        valid, reason, _bounds = self.calendar.actionable_y30(event.event_time_ms)
        if not valid:
            return []
        incoming_rows: dict[str, dict[str, Any]] = {}
        for model_id, vector in prepared.snapshots.items():
            if "__error__" in vector:
                continue
            started = time.perf_counter_ns(); prediction = self.fleet.predict_surface(model_id, vector)
            inference_ms = (time.perf_counter_ns() - started) / 1e6
            probability = prediction.grade_probability
            display = prediction.display_probability_surface
            ladder = {target / 100.0: display[f"p{target}_30"] for target in (5, 10, 15, 20, 25, 30)}
            row = {
                "event": event, "contract": event.osi, "symbol": event.symbol,
                "direction": event.contract_type.upper(), "model_probability": probability,
                "delta": float(event.delta), "dte": 1, "expiration": event.fields.get("expiration"),
                "candidate_delta_band": candidate_delta_band(float(event.delta)),
                "strike": float(event.fields["strikePrice"]), "event_time_ms": event.event_time_ms,
                "feature_hash": self._feature_hash(vector), "ladder": ladder,
                "uncalibrated_probability_surface": prediction.uncalibrated_probability_surface,
                "raw_probability_surface": prediction.raw_probability_surface,
                "display_probability_surface": prediction.display_probability_surface,
                "raw_aim_for_by_horizon": prediction.raw_aim_for_by_horizon,
                "display_aim_for_percent_by_horizon": prediction.display_aim_for_percent_by_horizon,
                "score_band": None, "mapping_effective_n": None,
                "relative_spread": float(vector["contract_spread_rel"]),
                "latency_ms": {"feature_snapshot": 0.0, "model_inference": inference_ms},
            }
            self.candidate_pool[model_id][event.osi] = row
            incoming_rows[model_id] = row
            direction = row["direction"]
            prior = self.latest_side_evidence[model_id][direction]
            prior_key = (-1, "") if prior is None else (int(prior["event_time_ms"]), str(prior["contract"]))
            current_key = (int(row["event_time_ms"]), str(row["contract"]))
            if current_key >= prior_key:
                self.latest_side_evidence[model_id][direction] = row
        decisions: list[ModelDecision] = []
        for model_id in prepared.snapshots:
            incoming = incoming_rows.get(model_id)
            if incoming is None:
                continue
            now = datetime.now(timezone.utc)
            rows = self._refresh_pool_quotes(model_id, now)
            machine = self.invalidations.get(model_id)
            if machine is not None and machine.state == ThesisState.INVALIDATED:
                invalidated_at = self.invalidated_at_event_ms.get(model_id, int(incoming["event_time_ms"]))
                can_rearm = (int(incoming["event_time_ms"]) > invalidated_at and
                             grade_for_probability(float(incoming["model_probability"])) is not None and
                             self._quoted_record(incoming, now).get("quote_valid") and
                             self._structure_live(structure, now) and
                             self._dependencies_live(model_id, incoming["symbol"]))
                if can_rearm:
                    previous_episode_id = machine.setup_episode_id
                    self.rearm_ready[model_id] = True
                    level = structure.get("call_invalidation_level" if incoming["direction"] == "CALL"
                                          else "put_invalidation_level")
                    machine = self._new_machine(model_id, incoming["direction"],
                                                grade_for_probability(float(incoming["model_probability"])),
                                                level, incoming["event"])
                    self.selected_contracts.pop(model_id, None)
                    self.recorder.submit("invalidation_events", {
                        "model_id": model_id, "previous_setup_episode_id": previous_episode_id,
                        "setup_episode_id": machine.setup_episode_id, "previous_state": "INVALIDATED",
                        "state": "LIVE", "reason": "NEW_COMPLETED_CADENCE_SETUP_REARMED",
                        "direction": incoming["direction"],
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    })
            active_direction = machine.direction if machine is not None else incoming["direction"]
            selected = self._select_contract(model_id, active_direction, incoming, now, rows)
            if selected is None:
                continue
            decision = self._decision_from_record(model_id, selected, structure, receive_ns, incoming)
            self.decisions[model_id] = decision; payload = asdict(decision)
            self.recorder.submit("model_events", payload)
            self.recorder.submit("latency", {"model_id": model_id, **decision.latency_ms})
            enqueue_start = time.perf_counter_ns()
            self.publisher.submit("predictive_model_state_live", payload)
            self._sync_signal_decision(payload)
            decision.latency_ms["publish_enqueue"] = (time.perf_counter_ns()-enqueue_start)/1e6
            if getattr(self, "telegram", None) is not None:
                self.telegram.observe_decision(payload,
                    underlying=self.latest_underlying.get(decision.symbol))
            decisions.append(decision)
        return decisions

    def on_quant_candidate(self, candidate: OptionPrint, *, cadence_seconds: int,
                           session_open_ms: int, structure_bias: str,
                           invalidation_level: float | None = None) -> list[ModelDecision]:
        """Compatibility/replay entry point; production runtime uses cadence buffering."""
        self.option_warm[candidate.symbol] = True
        prepared = self.prepare_candidate(candidate, cadence_seconds=cadence_seconds,
                                          session_open_ms=session_open_ms)
        decisions = self.process_cadence_candidate(prepared, {
            "structure_bias": structure_bias, "call_invalidation_level": invalidation_level,
            "put_invalidation_level": invalidation_level,
        })
        self.ingest_context(candidate)
        return decisions

    def on_webull_quote(self, contract: str, quote: dict[str, Any]) -> None:
        valid, reason = quote_valid(quote, max_age_seconds=float(self.staleness["webull_quote"]))
        payload = {"contract": contract, **quote, "valid": valid, "reason": reason}
        self.quotes[contract] = payload; self.recorder.submit("option_quotes", payload)
        self.patch_option_quote(contract, payload)
        for decision in self.decisions.values():
            if decision.candidate_contract != contract:
                continue
            decision.latest_quote_time = quote.get("quote_time")
            decision.quote_age_ms = self._age_ms(decision.latest_quote_time)
            decision.latest_same_side_age_ms = self._age_ms(decision.latest_same_side_event_time)
            decision.latest_same_side_fresh = (decision.latest_same_side_age_ms is not None and
                decision.latest_same_side_age_ms <= float(self.staleness["quant_option_event"]) * 1000)
            decision.bid = float(quote["bid"]) if valid else None
            decision.ask = float(quote["ask"]) if valid else None
            decision.current_option_return = self._option_return(
                decision.option_entry_price, decision.bid
            )
            guidance, data_reason = self._guidance_from_current_health(
                decision.model_id, decision.symbol, quote_ok=valid, quote_reason=reason,
                same_side_fresh=decision.latest_same_side_fresh)
            if decision.thesis_state == ThesisState.INVALIDATED.value:
                decision.guidance_state = "BLOCKED"; decision.state = ThesisState.INVALIDATED.value
            else:
                decision.guidance_state = guidance
                decision.state = decision.thesis_state if guidance == "LIVE" else guidance
                if guidance != "LIVE":
                    decision.invalidation_reason = data_reason
                elif decision.thesis_state not in {ThesisState.WARNING.value, ThesisState.INVALIDATED.value}:
                    decision.invalidation_reason = None
            if guidance != "LIVE" or decision.thesis_state == ThesisState.INVALIDATED.value:
                decision.aim_for_percent = None; decision.aim_for_percent_by_horizon = None; decision.target_premium = None
            else:
                decision.aim_for_percent_by_horizon = rounded_aim_for_by_horizon(decision.display_probability_surface) if decision.grade else None
                decision.aim_for_percent = decision.aim_for_percent_by_horizon["30"] if decision.aim_for_percent_by_horizon else None
                ladder = {float(key): value for key, value in decision.ladder.items()}
                decision.target_premium = target_premium(decision.ask, ladder) if decision.grade else None
            self.publisher.submit("predictive_model_state_live", asdict(decision))
            self._sync_signal_decision(asdict(decision))
        book = getattr(self, "signal_episodes", None)
        if book is not None:
            changed = book.update_quote(
                contract, bid=quote.get("bid") if valid else None,
                ask=quote.get("ask") if valid else None,
                quote_time=quote.get("quote_time"),
            )
            self._publish_signal_rows(changed)
        if getattr(self, "telegram", None) is not None:
            self.telegram.observe_quote(contract,
                bid=float(quote["bid"]) if valid else None,
                quote_time=quote.get("quote_time"), quote_fresh=valid,
                underlying_by_symbol=self.latest_underlying)

    def patch_option_quote(self, contract: str, quote: dict[str, Any]) -> None:
        row = self.ladder_cache.get(contract)
        if row is None:
            return
        for key in ("bid", "ask", "bid_size", "ask_size", "last", "quote_time", "quote_age_ms"):
            if key in quote:
                row[key] = quote[key]
        self.update_option_ladder([row])

    def update_market_context(self, symbol: str, *, option_context: dict[str, float],
                              structure: dict[str, Any], as_of: str) -> dict[str, Any]:
        condition = market_condition(option_context, structure)
        regime = gamma_regime(self.gex[symbol].current, scope=self.gex[symbol].scope) if self.gex[symbol].current else {"label":"UNAVAILABLE","gamma_balance":None,"scope":"0DTE"}
        gex_state = self.gex[symbol]
        common = set(gex_state.current) & set(gex_state.baseline or {})
        delta = {strike: gex_state.current[strike] - gex_state.baseline[strike]
                 for strike in sorted(common)}
        engines = getattr(self, "gamma_read_engines", None)
        if engines is None:
            engines = self.gamma_read_engines = {
                name: GammaReadEngine(name) for name in ("SPY", "QQQ")
            }
        spot = self.latest_underlying.get(symbol)
        spot_as_of = self.latest_underlying_time.get(symbol)
        spot_source = self.latest_underlying_source.get(symbol)
        source_thresholds = {
            "WEBULL_CASH": float(self.staleness.get("webull_quote", 5)),
            "QUANT_OPTION_PRINT": float(self.staleness.get("quant_option_event", 90)),
            "QUANT_GEX_SPOT": float(self.staleness.get("quant_context", 180)),
        }
        spot_stale_seconds = source_thresholds.get(
            spot_source, float(self.staleness.get("webull_quote", 5))
        )
        spot_age = self._age_ms(spot_as_of)
        if spot_age is None or spot_age > spot_stale_seconds * 1000:
            fallback_spot = getattr(self, "latest_gex_spot", {}).get(symbol)
            fallback_time = getattr(self, "latest_gex_spot_time", {}).get(symbol)
            fallback_age = self._age_ms(fallback_time)
            fallback_limit = float(self.staleness.get("quant_context", 180))
            if (fallback_spot is not None and math.isfinite(float(fallback_spot))
                    and fallback_age is not None and fallback_age <= fallback_limit * 1000):
                spot = float(fallback_spot)
                spot_as_of = fallback_time
                spot_source = "QUANT_GEX_SPOT"
                spot_stale_seconds = fallback_limit
        gamma_read = engines[symbol].update(
            gex_state.current, delta, spot,
            current_as_of=gex_state.current_time,
            delta_as_of=gex_state.current_time if gex_state.baseline_time and delta else None,
            spot_as_of=spot_as_of,
            gex_stale_seconds=float(self.staleness.get("quant_context", 180)),
            spot_stale_seconds=spot_stale_seconds,
            scope=gex_state.scope,
        )
        gamma_read["spot_source"] = spot_source
        gamma_read["spot_stale_after_ms"] = spot_stale_seconds * 1000
        gamma_read["gex_stale_after_ms"] = float(self.staleness.get("quant_context", 180)) * 1000
        prior = self.market_context.get(symbol, {}).get("gamma_read")
        if gamma_read["regime"] == "DATA STALE" and prior and prior.get("regime") != "DATA STALE":
            gamma_read["last_valid_read"] = {
                key: prior.get(key) for key in ("regime", "key_zone", "read", "current_gex_as_of")
            }
        session = self.calendar.market_state(datetime.now(timezone.utc))
        payload = {"symbol": symbol, "gamma_regime": regime["label"], "gamma_balance": regime["gamma_balance"],
                   "gamma_scope": regime["scope"], "market_condition": condition["label"],
                   "reasons": condition["reasons"], "option_context": option_context,
                   "structure": structure, "session": session, "gamma_read": gamma_read,
                   "spot_source": spot_source, "as_of": as_of}
        self.market_context[symbol] = payload; self.recorder.submit("market_context", payload)
        self.publisher.submit("predictive_market_context_live", payload); return payload

    def update_gex(self, symbol: str, *, timestamp: datetime,
                   signed_by_strike: dict[float, float], scope: str,
                   spot: float | None) -> dict[str, Any]:
        stamp = timestamp.astimezone(timezone.utc).isoformat()
        if spot is not None and math.isfinite(float(spot)):
            if not hasattr(self, "latest_gex_spot"):
                self.latest_gex_spot = {}
                self.latest_gex_spot_time = {}
            self.latest_gex_spot[symbol] = float(spot)
            self.latest_gex_spot_time[symbol] = stamp
            source = self.latest_underlying_source.get(symbol)
            source_limit = {
                "WEBULL_CASH": float(self.staleness.get("webull_quote", 5)),
                "QUANT_OPTION_PRINT": float(self.staleness.get("quant_option_event", 90)),
                "QUANT_GEX_SPOT": float(self.staleness.get("quant_context", 180)),
            }.get(source, float(self.staleness.get("webull_quote", 5)))
            source_age = self._age_ms(self.latest_underlying_time.get(symbol))
            if source_age is None or source_age > source_limit * 1000:
                self.latest_underlying[symbol] = float(spot)
                self.latest_underlying_time[symbol] = stamp
                self.latest_underlying_source[symbol] = "QUANT_GEX_SPOT"
        snapshot = self.gex[symbol].update(timestamp=timestamp, signed_by_strike=signed_by_strike, scope=scope)
        for kind, field in (("CURRENT","current"),("INTRADAY_DELTA","delta_from_rth_open")):
            payload = {"symbol":symbol,"surface_kind":kind,"scope":scope,"spot":spot,
                       "points":[{"strike":strike,"value":value} for strike,value in snapshot[field].items()],
                       "as_of":snapshot["as_of"],"baseline_time":snapshot["baseline_time"],
                       "unmatched_current_strikes":snapshot["unmatched_current_strikes"],
                       "unmatched_baseline_strikes":snapshot["unmatched_baseline_strikes"]}
            self.recorder.submit("gex", payload); self.publisher.submit("predictive_gex_surface_live", payload)
        return snapshot

    def update_option_ladder(self, rows: list[dict[str, Any]]) -> None:
        publish_rows: list[dict[str, Any]] = []
        for patch in rows:
            contract = str(patch["contract_key"]); symbol = str(patch["symbol"])
            expiration = str(patch.get("expiration") or "")
            prior_expiration = self.active_expiration.get(symbol)
            if expiration and prior_expiration and expiration != prior_expiration:
                for key, old in tuple(self.ladder_cache.items()):
                    if old.get("symbol") == symbol and old.get("expiration") != expiration and old.get("active", True):
                        old = {**old, "active": False}; self.ladder_cache[key] = old
                        publish_rows.append(old)
            if expiration:
                self.active_expiration[symbol] = expiration
            context = self.contract_context_cache.get(contract, {})
            gex = self.gex.get(symbol).current.get(float(patch.get("strike"))) if self.gex.get(symbol) and patch.get("strike") is not None else None
            merged = {**self.ladder_cache.get(contract, {}), **context, **patch,
                      "gex": gex, "active": True}
            merged["greek_age_ms"] = self._age_ms(merged.get("greek_context_time"))
            self.ladder_cache[contract] = merged
            self.recorder.submit("option_ladder", merged)
            publish_rows.append(merged)
        if publish_rows:
            self.publisher.submit("predictive_option_ladder_live", {"_batch": publish_rows})

    def get_pinned_contracts(self) -> list[str]:
        telegram = self.telegram.pinned_contracts() if getattr(self, "telegram", None) is not None else []
        signals = (self.signal_episodes.active_contracts()
                   if getattr(self, "signal_episodes", None) is not None else [])
        selected = [row["contract"] for row in self.selected_contracts.values() if row.get("contract")]
        latest_evidence = [row["contract"] for sides in self.latest_side_evidence.values()
                           for row in sides.values() if row]
        opposite = [row["contract"] for sides in self.best_sides.values() for row in sides.values() if row]
        high = [row["contract"] for pool in self.candidate_pool.values() for row in pool.values()
                if float(row.get("model_probability", 0)) >= .10]
        return list(dict.fromkeys([*signals, *telegram, *selected, *latest_evidence, *opposite, *high]))

    def update_invalidation(self, model_id: str, *, current_probability: float,
                            opposite_probability: float | None, structure_bias: str,
                            accepted_structure_break: bool = False,
                            wick_only: bool = False, data_valid: bool = True) -> ThesisState:
        machine = self.invalidations[model_id]; previous = machine.state
        state = machine.update(current_probability=current_probability,
            opposite_probability=opposite_probability, structure_bias=structure_bias,
            accepted_structure_break=accepted_structure_break, wick_only=wick_only,
            data_valid=data_valid)
        decision = self.decisions.get(model_id)
        if decision:
            decision.thesis_state = state.value
            decision.state = state.value if decision.guidance_state == "LIVE" else decision.guidance_state
            decision.invalidation_reason = machine.reason
            if state == ThesisState.INVALIDATED or decision.guidance_state != "LIVE":
                decision.aim_for_percent = None; decision.aim_for_percent_by_horizon = None; decision.target_premium = None
            if state != previous:
                self.recorder.submit("invalidation_events", {
                    "model_id":model_id,"setup_episode_id":machine.setup_episode_id,
                    "previous_state":previous.value,"state":state.value,"reason":machine.reason,
                    "previous_grade":decision.grade,"current_score":current_probability,
                    "timestamp":datetime.now(timezone.utc).isoformat()})
            self.publisher.submit("predictive_model_state_live", asdict(decision))
            self._sync_signal_decision(asdict(decision))
            if getattr(self, "telegram", None) is not None:
                self.telegram.observe_decision(asdict(decision),
                    underlying=self.latest_underlying.get(decision.symbol))
        return state

    def sweep_freshness(self, now: datetime | None = None) -> None:
        now = now or datetime.now(timezone.utc)
        threshold_map = {"QUANT_DATA":"quant_option_event", "WEBULL":"webull_quote",
                         "NINJATRADER_ES":"ninjatrader_futures", "NINJATRADER_NQ":"ninjatrader_futures",
                         "QUANT_CONTEXT":"quant_context", "V2_STRUCTURE_SPY":"v2_structure",
                         "V2_STRUCTURE_QQQ":"v2_structure"}
        for provider, setting in threshold_map.items():
            clock = self.provider_clocks.get(provider, {})
            stamp = clock.get("last_real_provider_event_time")
            age_ms = self._age_ms(stamp, now)
            if age_ms is None:
                continue
            status = "LIVE" if age_ms <= float(self.staleness[setting])*1000 else "STALE"
            if self.provider_health.get(provider, {}).get("status") != status or int(age_ms/1000) != int((self.provider_health.get(provider,{}).get("age_ms") or 0)/1000):
                self.update_provider_health(provider, status=status, age_ms=age_ms,
                    detail="" if status=="LIVE" else "MARKET_EVENT_STALE",
                    event_time=stamp, receipt_time=clock.get("last_successful_request_time"))
        for decision in self.decisions.values():
            decision.model_age_ms = self._age_ms(decision.model_event_time, now)
            decision.latest_same_side_age_ms = self._age_ms(decision.latest_same_side_event_time, now)
            decision.latest_same_side_fresh = (decision.latest_same_side_age_ms is not None and
                decision.latest_same_side_age_ms <= float(self.staleness["quant_option_event"]) * 1000)
            decision.latest_opposite_side_age_ms = self._age_ms(decision.latest_opposite_side_event_time, now)
            decision.latest_opposite_side_fresh = (decision.latest_opposite_side_age_ms is not None and
                decision.latest_opposite_side_age_ms <= float(self.staleness["quant_option_event"]) * 1000)
            decision.quote_age_ms = self._age_ms(decision.latest_quote_time, now)
            quote = self.quotes.get(decision.candidate_contract or "")
            quote_ok, quote_reason = quote_valid(quote, max_age_seconds=float(self.staleness["webull_quote"]), now=now)
            decision.current_option_return = self._option_return(
                decision.option_entry_price, decision.bid
            ) if quote_ok else None
            guidance, data_reason = self._guidance_from_current_health(
                decision.model_id, decision.symbol, quote_ok=quote_ok, quote_reason=quote_reason,
                same_side_fresh=decision.latest_same_side_fresh)
            if guidance != "LIVE":
                decision.guidance_state = guidance; decision.state = guidance
                if decision.thesis_state == ThesisState.INVALIDATED.value:
                    decision.state = ThesisState.INVALIDATED.value
                else:
                    decision.invalidation_reason = data_reason
                decision.aim_for_percent = None; decision.aim_for_percent_by_horizon = None; decision.target_premium = None
            elif decision.thesis_state == ThesisState.INVALIDATED.value:
                decision.guidance_state = "BLOCKED"; decision.state = ThesisState.INVALIDATED.value
                decision.aim_for_percent = None; decision.aim_for_percent_by_horizon = None; decision.target_premium = None
            elif decision.guidance_state in {"STALE", "BLOCKED"}:
                decision.guidance_state = "LIVE"; decision.state = decision.thesis_state
                if decision.thesis_state not in {ThesisState.WARNING.value, ThesisState.INVALIDATED.value}:
                    decision.invalidation_reason = None
                decision.aim_for_percent_by_horizon = rounded_aim_for_by_horizon(decision.display_probability_surface) if decision.grade else None
                decision.aim_for_percent = decision.aim_for_percent_by_horizon["30"] if decision.aim_for_percent_by_horizon else None
                ladder = {float(key): value for key, value in decision.ladder.items()}
                decision.target_premium = target_premium(decision.ask, ladder) if decision.grade and decision.ask else None
            self.publisher.submit("predictive_model_state_live", asdict(decision))
        book = getattr(self, "signal_episodes", None)
        if book is not None:
            self._publish_signal_rows(book.sweep(now))
        if getattr(self, "telegram", None) is not None:
            self.telegram.sweep(underlying_by_symbol=self.latest_underlying,
                quotes=self.quotes,
                quote_stale_seconds=float(self.staleness["webull_quote"]), now=now)

    def current_state(self) -> dict[str, Any]:
        return {"models":{key:asdict(value) for key,value in self.decisions.items()},
                "providers":dict(self.provider_health),"fleet":self.fleet.health(),
                "forward_recorder":self.recorder.health(),"publisher":self.publisher.health(),
                "warmup":dict(self.option_warm),"calendar":self.calendar.VERSION,
                "signal_episodes":self.signal_episodes.snapshot() if getattr(self, "signal_episodes", None) else [],
                "telegram":self.telegram.health() if getattr(self, "telegram", None) is not None else {"status":"DISABLED"}}
