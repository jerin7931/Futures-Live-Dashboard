from __future__ import annotations

import math
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .cash import CashMicrostructure, tracking_error_bps
from .config import load_config
from .direction import agreement_quality, cross_domain_conflicts, directional_core, setup_archetype, setup_quality
from .futures import normalized_payload
from .math_utils import age_seconds, clamp, finite, parse_utc, sanitize_json, utc_iso
from .models import Candidate, DirectionState, Evidence, QuoteState
from .options import (
    ContractSelector,
    QuoteHysteresis,
    candidate_utility,
    delta_preference,
    greek_consistency,
    liquidity_quality,
    quote_quality,
    rank_candidates,
    surface_consistency,
    validate_candidate,
)
from .pricing import ScenarioInput, scenario_grid
from .profile import CausalVolumeProfile
from .regime import NEW_YORK, expiration_timestamp, market_is_open, minutes_to_expiration, realized_vol_regime, regime_adjustments, session_phase
from .state_machine import DirectionStateMachine
from .structure import CausalSwingDetector, ZoneBook, structure_evidence
from .validity import clock_skew_seconds, source_age, timestamp_lineage


class MarketEngine:
    """One deterministic stateful engine instance per symbol/DTE market."""

    def __init__(self, market_key: str, config: dict[str, Any] | None = None, state_root: Path | None = None) -> None:
        self.config = config or load_config()
        self.market_key = market_key
        self.market = self.config["markets"][market_key]
        self.symbol = self.market["symbol"]
        self.future_symbol = self.market["futures_symbol"]
        self.machine = DirectionStateMachine(self.market, self.config["direction"])
        self.selector = ContractSelector()
        self.quote_states: dict[str, QuoteHysteresis] = {}
        self.cash = CashMicrostructure(self.symbol)
        zone_path = state_root / f"{self.market_key.lower()}_zones.json" if state_root else None
        self.zones = ZoneBook(self.symbol, self.config["structure"], zone_path)
        self.swing = CausalSwingDetector(self.config["structure"]["causal_swing_atr_multiple"])
        self.profile = CausalVolumeProfile(0.01)
        self.future_prices: deque[tuple[float, float]] = deque()
        self.cash_changes: deque[float] = deque(maxlen=120)
        self.last_cash_price: float | None = None
        self.last_cash_event: float | None = None
        self.session_date: str | None = None
        self.last_day_volume: float | None = None
        self.vwap_numerator = 0.0
        self.vwap_denominator = 0.0
        self.last_profile_levels = 0.0
        self.last_zone_save = 0.0
        self.current_archetype = "CONTINUATION"
        self.last_decision: dict[str, Any] | None = None

    def add_structural_level(self, **kwargs: Any) -> None:
        self.zones.add_level(**kwargs)

    def _update_structure(self, *, cash_payload: dict[str, Any], cash_price: float, cash_time: datetime | None, now_monotonic: float) -> float | None:
        """Update only from newly timestamped observations; never from future bars."""
        if cash_price <= 0.0 or cash_time is None:
            return self.vwap_numerator / self.vwap_denominator if self.vwap_denominator > 0.0 else None
        stamp = cash_time.timestamp()
        if self.last_cash_event is not None and stamp <= self.last_cash_event:
            return self.vwap_numerator / self.vwap_denominator if self.vwap_denominator > 0.0 else None
        self.last_cash_event = stamp
        session_date = cash_time.astimezone(NEW_YORK).date().isoformat()
        if session_date != self.session_date:
            self.session_date = session_date
            self.profile = CausalVolumeProfile(0.01)
            self.last_day_volume = finite(cash_payload.get("day_volume"))
            self.vwap_numerator = 0.0
            self.vwap_denominator = 0.0
            previous_close = finite(cash_payload.get("previous_close"))
            if previous_close and previous_close > 0.0:
                self.zones.add_level(
                    price=previous_close, timestamp=stamp, source_type="PRIOR_CLOSE", timeframe="DAILY",
                    role="SUPPORT" if cash_price >= previous_close else "RESISTANCE",
                    atr_reference=max(cash_price * 0.005, 0.01), qualified_reaction=False,
                )

        if self.last_cash_price is not None:
            self.cash_changes.append(abs(cash_price - self.last_cash_price))
        sorted_changes = sorted(self.cash_changes)
        median_change = sorted_changes[len(sorted_changes) // 2] if sorted_changes else 0.0
        atr_reference = max(median_change * 8.0, cash_price * 0.0005, 0.01)
        swing = self.swing.update(stamp, cash_price, atr_reference)
        if swing:
            self.zones.add_level(
                price=swing["price"], timestamp=float(swing["time"]), source_type="CAUSAL_SWING",
                timeframe="INTRADAY", role=swing["role"], atr_reference=atr_reference,
                reaction_strength=0.50, qualified_reaction=True,
            )

        day_volume = finite(cash_payload.get("day_volume"))
        if day_volume is not None:
            if self.last_day_volume is not None and day_volume >= self.last_day_volume:
                incremental = day_volume - self.last_day_volume
                if incremental > 0.0:
                    self.profile.add(cash_price, incremental)
                    self.vwap_numerator += cash_price * incremental
                    self.vwap_denominator += incremental
            self.last_day_volume = day_volume

        self.zones.observe_price(timestamp=stamp, price=cash_price, atr_reference=atr_reference)
        if now_monotonic - self.last_profile_levels >= 30.0:
            levels = self.profile.levels()
            for name, role in (("poc", "NEUTRAL"), ("vah", "RESISTANCE"), ("val", "SUPPORT")):
                level = finite(levels.get(name))
                if level:
                    self.zones.add_level(
                        price=level, timestamp=stamp, source_type=f"SESSION_{name.upper()}", timeframe="DAILY",
                        role=role, atr_reference=atr_reference, profile_significance=0.65,
                        qualified_reaction=False,
                    )
            self.last_profile_levels = now_monotonic
        return self.vwap_numerator / self.vwap_denominator if self.vwap_denominator > 0.0 else None

    def _basis(self, now_seconds: float, cash_price: float, future_price: float) -> tuple[float | None, bool]:
        self.future_prices.append((now_seconds, future_price))
        while self.future_prices and self.future_prices[0][0] < now_seconds - 300.0:
            self.future_prices.popleft()
        future_old = next((price for stamp, price in reversed(self.future_prices) if stamp <= now_seconds - 30.0), None)
        cash_return = self.cash.clock_return(30.0)
        if future_old is None or cash_return is None:
            return None, False
        cash_old = cash_price / math.exp(cash_return)
        error = tracking_error_bps(cash_price, cash_old, future_price, future_old)
        return error, bool(error is not None and error > 20.0)

    def evaluate(
        self,
        *,
        now_monotonic: float,
        now_utc: datetime,
        futures_payload: dict[str, Any] | None,
        cash_payload: dict[str, Any] | None,
        cash_depth: dict[str, Any] | None,
        option_candidates: list[Candidate],
        expiration: str | None,
        quant_flow: dict[str, Any] | None = None,
        quant_status: str = "UNAVAILABLE",
        webull_status: str = "UNAVAILABLE",
        etf_vwap: float | None = None,
        context_ages: dict[str, float | None] | None = None,
        market_open_override: bool | None = None,
    ) -> dict[str, Any]:
        decision_started = time.perf_counter_ns()
        futures = normalized_payload(futures_payload or {})
        cash_payload = cash_payload or {}
        cash_depth = cash_depth or {}
        context_ages = context_ages or {}
        cash_price = finite(cash_payload.get("price"), 0.0) or 0.0
        cash_time = parse_utc(cash_payload.get("provider_event_time"))
        if cash_price > 0.0 and cash_time:
            self.cash.add_price(cash_time.timestamp(), cash_price)
        causal_vwap = self._update_structure(
            cash_payload=cash_payload,
            cash_price=cash_price,
            cash_time=cash_time,
            now_monotonic=now_monotonic,
        )
        if etf_vwap is None:
            etf_vwap = causal_vwap

        futures_age = source_age(
            "futures", futures.get("provider_event_time"), futures.get("local_receive_time"), now_utc,
            self.config["freshness_seconds"]["futures"],
        )
        cash_age = source_age(
            "cash", cash_payload.get("provider_event_time"), cash_payload.get("local_receive_time"), now_utc,
            self.config["freshness_seconds"]["cash"],
        )
        l2_age = source_age(
            "cash_l2", cash_depth.get("provider_event_time"), cash_depth.get("local_receive_time"), now_utc,
            self.config["freshness_seconds"]["cash_l2"],
        )

        bid = finite(cash_payload.get("bid"), 0.0) or 0.0
        ask = finite(cash_payload.get("ask"), 0.0) or 0.0
        cash_features = self.cash.evidence(
            bids=cash_depth.get("bids") or [],
            asks=cash_depth.get("asks") or [],
            bid=bid,
            ask=ask,
            bid_size=finite(cash_payload.get("bid_size"), 0.0) or 0.0,
            ask_size=finite(cash_payload.get("ask_size"), 0.0) or 0.0,
            l2_valid=bool(cash_depth.get("l2_valid") and l2_age.valid),
        )
        cash_evidence_value = cash_features["cash_evidence"] if cash_age.valid else 0.0

        returns = cash_features["returns"]
        phase = session_phase(now_utc)
        vol_regime = realized_vol_regime([value for value in returns.values() if value is not None])
        adjustments = regime_adjustments(self.market_key, phase, vol_regime)
        effective_market = dict(self.market)
        for key in ("enter_threshold", "hold_threshold", "flip_threshold", "reversal_flow_threshold"):
            effective_market[key] = min(0.99, self.market[key] * adjustments["threshold_multiplier"])
        for key in ("entry_persistence_seconds", "flip_persistence_seconds", "reversal_persistence_seconds"):
            effective_market[key] = self.market[key] * adjustments["persistence_multiplier"]
        self.machine.cfg = effective_market
        momentum_components = [clamp(value / 0.0015, -1.0, 1.0) for value in returns.values() if value is not None]
        vwap_component = None
        if etf_vwap and cash_price > 0.0:
            # Location is deliberately weak context, never a CALL/PUT gate.
            vwap_component = clamp((cash_price - etf_vwap) / max(cash_price * 0.003, 1e-9), -0.5, 0.5)
        nearest_support = self.zones.support_behind(cash_price) if cash_price > 0 else None
        nearest_resistance = self.zones.resistance_ahead(cash_price) if cash_price > 0 else None
        zone_component: float | None = None
        if cash_price > 0.0:
            distances: list[tuple[float, float]] = []
            if nearest_support:
                distances.append((abs(cash_price - nearest_support.center), nearest_support.zone_strength))
            if nearest_resistance:
                distances.append((abs(nearest_resistance.center - cash_price), -nearest_resistance.zone_strength))
            if distances:
                zone_component = min(distances, key=lambda item: item[0])[1]
        structure_value, structure_valid = structure_evidence([*momentum_components, vwap_component, zone_component])

        evidence = Evidence(
            futures=finite(futures.get("futures_flow_evidence"), 0.0) or 0.0,
            cash=cash_evidence_value,
            structure=structure_value,
            flow_persistence=finite(futures.get("flow_persistence"), 0.0) or 0.0,
            flow_active_fraction=finite(futures.get("flow_active_fraction"), 0.0) or 0.0,
            flow_sign_duration=finite(futures.get("flow_sign_duration"), 0.0) or 0.0,
        )
        core = directional_core(evidence, self.config["direction"])
        future_price = finite(futures.get("last")) or finite(futures.get("bid"), 0.0) or 0.0
        tracking_error, basis_unstable = self._basis(cash_time.timestamp() if cash_time else now_utc.timestamp(), cash_price, future_price) if cash_price > 0 and future_price > 0 else (None, False)
        quant_value = finite((quant_flow or {}).get("evidence"))
        conflicts = cross_domain_conflicts(
            evidence,
            threshold=self.config["direction"]["conflict_strength"],
            options_flow_evidence=quant_value,
            basis_unstable=basis_unstable,
            absorption=finite(futures.get("absorption")),
            book=finite(futures.get("book")),
            aggression=finite(futures.get("aggression")),
        )

        prior_cash = self.last_cash_price
        self.last_cash_price = cash_price if cash_price > 0 else self.last_cash_price
        support_tolerance = cash_price * 0.001 if cash_price > 0 else 0.0
        at_support = bool(nearest_support and abs(cash_price - nearest_support.center) <= support_tolerance)
        at_resistance = bool(nearest_resistance and abs(nearest_resistance.center - cash_price) <= support_tolerance)
        local_reclaim = bool(nearest_support and prior_cash is not None and prior_cash <= nearest_support.upper_bound < cash_price)
        local_rejection = bool(nearest_resistance and prior_cash is not None and prior_cash >= nearest_resistance.lower_bound > cash_price)
        observed_archetype = setup_archetype(
            core=core,
            at_support=at_support,
            at_resistance=at_resistance,
            local_reclaim=local_reclaim,
            local_rejection=local_rejection,
            absorption=finite(futures.get("absorption"), 0.0) or 0.0,
            bid_replenishment=finite(futures.get("bid_replenishment"), 0.0) or 0.0,
            ask_replenishment=finite(futures.get("ask_replenishment"), 0.0) or 0.0,
        )
        if "REVERSAL" in observed_archetype:
            self.current_archetype = observed_archetype
        elif self.machine.state in {DirectionState.NO_TRADE, DirectionState.BLOCKED}:
            self.current_archetype = observed_archetype
        archetype = self.current_archetype

        hard_vetoes: list[str] = []
        degraded: list[str] = []
        is_open = market_is_open(now_utc) if market_open_override is None else market_open_override
        if not is_open:
            hard_vetoes.append("MARKET_CLOSED")
        if not futures_age.valid:
            hard_vetoes.append("FUTURES_STALE")
        expected_contract = self.config["futures"]["es_contract" if self.future_symbol == "ES" else "nq_contract"]
        if futures.get("contract") and futures.get("contract") != expected_contract:
            hard_vetoes.append("FUTURES_ROLLOVER_MISMATCH")
        if not cash_age.valid:
            degraded.append("CASH_STALE")
        if not cash_depth.get("l2_valid") or not l2_age.valid:
            degraded.append("CASH_L2_STALE")
        skew = clock_skew_seconds(futures.get("provider_event_time"), futures.get("local_receive_time"))
        if skew is not None and abs(skew) > 5.0:
            hard_vetoes.append("CLOCK_SKEW")
        if structure_valid < 3:
            degraded.append("STRUCTURE_DEGRADED")

        transition = self.machine.step(
            now=now_monotonic,
            core=core,
            evidence=evidence,
            setup_type=archetype,
            hard_vetoes=hard_vetoes,
            conflicts=conflicts,
        )

        candidate_direction = transition.direction
        if candidate_direction == "NONE" and self.machine.state in {DirectionState.CALL_READY, DirectionState.PUT_READY}:
            candidate_direction = "CALL" if self.machine.state == DirectionState.CALL_READY else "PUT"
        expiry_utc = expiration_timestamp(expiration) if expiration else None
        tte_minutes = minutes_to_expiration(expiry_utc, now_utc) if expiry_utc else 0.0
        valid_candidates: list[Candidate] = []
        grids: dict[str, dict[str, Any]] = {}
        moves: dict[str, float | None] = {}
        candidate_reasons: list[str] = []
        observed_quote_states: dict[str, QuoteState] = {}
        if candidate_direction in {"CALL", "PUT"} and expiration:
            peers = [row for row in option_candidates if row.expiration == expiration]
            for candidate in peers:
                if candidate.option_type != candidate_direction:
                    continue
                reasons = validate_candidate(
                    candidate,
                    now_utc=now_utc,
                    seconds_to_expiration=tte_minutes * 60.0,
                    minimum_minutes_to_expiration=self.market["minimum_minutes_to_expiration"],
                    quote_stale_seconds=self.config["freshness_seconds"]["option_quote"],
                    eligible_delta_min=self.config["options"]["eligible_delta_min"],
                    eligible_delta_max=self.config["options"]["eligible_delta_max"],
                )
                if age_seconds(candidate.greeks_time, now_utc) > self.config["freshness_seconds"]["greeks"]:
                    reasons.append("GREEKS_DEGRADED")
                quote_age_seconds = source_age("option", candidate.quote_time, candidate.quote_time, now_utc, self.config["freshness_seconds"]["option_quote"]).age_seconds
                hysteresis = self.quote_states.setdefault(candidate.option_symbol, QuoteHysteresis())
                quote_state = hysteresis.update(
                    now=now_monotonic,
                    hard_invalid=bool(candidate.ask <= 0 or candidate.bid < 0 or candidate.bid > candidate.ask),
                    wide=bool(candidate.relative_spread > self.config["options"]["maximum_relative_spread"]),
                    degraded_seconds=self.config["options"]["quote_degraded_seconds"],
                    invalid_seconds=self.config["options"]["quote_invalid_seconds"],
                )
                observed_quote_states[candidate.option_symbol] = quote_state
                if quote_state == QuoteState.INVALID:
                    reasons.append("INVALID_OPTION_QUOTE")
                candidate.delta_preference = delta_preference(candidate.delta)
                candidate.quote_quality = quote_quality(candidate, quote_age_seconds, self.config["options"]["maximum_relative_spread"], self.config["freshness_seconds"]["option_quote"])
                candidate.liquidity = liquidity_quality(candidate)
                candidate.surface_consistency = surface_consistency(candidate, peers)
                _, _, greek_reasons = greek_consistency(
                    candidate,
                    current_spot=cash_price,
                    seconds_to_expiration=tte_minutes * 60.0,
                    rate=self.config["scenario"]["risk_free_rate"],
                    dividend=self.config["scenario"]["dividend_yield"],
                    move_tolerance=self.config["options"]["greeks_move_tolerance"],
                    delta_tolerance=self.config["options"]["greeks_delta_tolerance"],
                    gamma_relative_tolerance=self.config["options"]["greeks_gamma_relative_tolerance"],
                )
                reasons.extend(greek_reasons)
                if reasons:
                    candidate_reasons.extend(reasons)
                    continue
                grid = scenario_grid(
                    ScenarioInput(
                        option_type=candidate.option_type,
                        spot=cash_price,
                        strike=candidate.strike,
                        seconds_to_expiration=tte_minutes * 60.0,
                        iv=candidate.iv,
                        bid=candidate.bid,
                        ask=candidate.ask,
                        rate=self.config["scenario"]["risk_free_rate"],
                        dividend=self.config["scenario"]["dividend_yield"],
                        profit_objective=self.config["scenario"]["profit_objective"],
                        future_spread_multiplier=self.config["scenario"]["future_spread_multiplier"] * adjustments["future_spread_multiplier"],
                        maximum_root_move_pct=self.config["scenario"]["maximum_root_move_pct"],
                        bisection_tolerance=self.config["scenario"]["bisection_tolerance"],
                        minimum_iv=self.config["options"]["minimum_iv"],
                    ),
                    self.config["scenario"]["elapsed_minutes_0dte" if self.market["dte"] == 0 else "elapsed_minutes_1dte"],
                    self.config["scenario"]["iv_shocks"],
                    self.config["scenario"]["late_tte_spread_multiplier"],
                )
                neutral_now = next((row for row in grid["rows"] if row["elapsed_minutes"] == 0 and row["iv_shock"] == 0.0), None)
                target_underlying = neutral_now.get("required_underlying_price") if neutral_now else None
                if target_underlying is None:
                    candidate_reasons.append("SCENARIO_FRAGILE")
                    continue
                clearance, _, _ = self.zones.path_clearance(
                    now=now_utc.timestamp(), current_price=cash_price, target_price=target_underlying, direction=candidate.option_type,
                )
                candidate.path_clearance = clearance
                candidate.scenario_resilience = grid["scenario_resilience"]
                candidate.utility = candidate_utility(candidate)
                grids[candidate.option_symbol] = grid
                moves[candidate.option_symbol] = neutral_now.get("required_move_pct")
                valid_candidates.append(candidate)

        ranked = rank_candidates(valid_candidates, moves)
        selected = self.selector.choose(
            ranked,
            now=now_monotonic,
            switch_margin=self.market["switch_margin"],
            switch_persistence=self.market["switch_persistence_seconds"],
        )
        scenario = grids.get(selected.option_symbol) if selected else None
        next_obstacle = None
        active_path: list[Any] = []
        path_clearance_value = selected.path_clearance if selected else 0.0
        if selected and scenario:
            neutral_now = next((row for row in scenario["rows"] if row["elapsed_minutes"] == 0 and row["iv_shock"] == 0.0), None)
            if neutral_now and neutral_now.get("required_underlying_price") is not None:
                path_clearance_value, next_obstacle, active_path = self.zones.path_clearance(
                    now=now_utc.timestamp(), current_price=cash_price,
                    target_price=neutral_now["required_underlying_price"], direction=selected.option_type,
                )

        display_state = transition.display_state
        primary_reason = transition.primary_reason
        reasons = list(dict.fromkeys([*transition.reasons, *degraded]))
        selected_quote_state = observed_quote_states.get(selected.option_symbol) if selected else None
        executable = bool(
            selected
            and selected_quote_state == QuoteState.GOOD
            and webull_status == "LIVE"
            and cash_age.valid
            and not hard_vetoes
            and not conflicts
        )
        if selected and path_clearance_value < self.config["structure"]["path_abstain_threshold"]:
            display_state = "ABSTAIN"
            primary_reason = "TARGET_PATH_OBSTRUCTED"
            reasons.insert(0, primary_reason)
            executable = False
        elif transition.state in {DirectionState.CALL_READY, DirectionState.PUT_READY} and transition.display_state != "ABSTAIN":
            if executable:
                display_state = "READY EXECUTABLE"
            else:
                display_state = "READY DIAGNOSTIC"
                primary_reason = "OPTION_QUOTE_UNAVAILABLE" if not selected else "EXECUTION_LAYER_DEGRADED"
                reasons.insert(0, primary_reason)
        if transition.state in {DirectionState.CALL_READY, DirectionState.PUT_READY} and not selected:
            candidate_reasons.insert(0, "ALL_CANDIDATES_FAILED" if option_candidates else "NO_ELIGIBLE_DELTA")

        agreement = agreement_quality(evidence, core)
        quality, quality_components = setup_quality(core, evidence.flow_persistence, agreement, selected.utility if selected else 0.0)
        state_age = max(0.0, now_monotonic - transition.state_since)
        quote_age = source_age("option", selected.quote_time, selected.quote_time, now_utc, self.config["freshness_seconds"]["option_quote"]).age_seconds if selected else None
        option_payload = None if not selected else {
            "symbol": selected.option_symbol,
            "expiration": selected.expiration,
            "type": selected.option_type,
            "strike": selected.strike,
            "bid": selected.bid,
            "ask": selected.ask,
            "last": selected.last,
            "bid_size": selected.bid_size,
            "ask_size": selected.ask_size,
            "spread": selected.ask - selected.bid,
            "relative_spread": selected.relative_spread,
            "quote_age": quote_age,
            "delta": selected.delta,
            "gamma": selected.gamma,
            "iv": selected.iv,
            "open_interest": selected.open_interest,
            "volume": selected.volume,
            "entry_price": selected.ask,
            "entry_basis": "CURRENT_WEBULL_ASK",
            "target_option_price": selected.ask * 1.30,
            "quote_state": selected_quote_state.value if selected_quote_state else "QUOTE_INVALID",
        }
        data_health = {
            "status": "BLOCKED" if hard_vetoes else "DEGRADED" if degraded or not executable else "OK",
            "futures_age": futures_age.age_seconds,
            "cash_age": cash_age.age_seconds,
            "cash_l2_age": l2_age.age_seconds,
            "option_quote_age": quote_age,
            "quantdata_option_flow_age": source_age("quant_flow", (quant_flow or {}).get("provider_event_time"), (quant_flow or {}).get("provider_event_time"), now_utc, self.config["freshness_seconds"]["quantdata_option_flow"]).age_seconds,
            "quantdata_gex_age": context_ages.get("quantdata_gex_age"),
            "quantdata_skew_age": context_ages.get("quantdata_skew_age"),
            "quantdata_oi_age": context_ages.get("quantdata_oi_age"),
            "greeks_age": context_ages.get("greeks_age"),
            "rollover_status": futures.get("rollover_status") or "UNKNOWN",
            "clock_skew_seconds": skew,
        }
        decision_time = utc_iso(now_utc)
        result = sanitize_json({
            "market_key": self.market_key,
            "symbol": self.symbol,
            "cash_price": cash_price or None,
            "etf_vwap": etf_vwap,
            "dte": self.market["dte"],
            "state": transition.state.value,
            "display_state": display_state,
            "state_since_monotonic": transition.state_since,
            "state_age_seconds": state_age,
            "direction": candidate_direction if transition.state != DirectionState.BLOCKED else "NONE",
            "setup_type": archetype,
            "directional_core": core,
            "futures_flow_evidence": evidence.futures,
            "cash_evidence": evidence.cash,
            "structure_evidence": evidence.structure,
            "flow_persistence": evidence.flow_persistence,
            "flow_active_fraction": evidence.flow_active_fraction,
            "flow_sign_duration": evidence.flow_sign_duration,
            "setup_quality": quality,
            "setup_quality_is_probability": False,
            "setup_quality_components": quality_components,
            "candidate_utility": selected.utility if selected else 0.0,
            "quote_quality": selected.quote_quality if selected else 0.0,
            "scenario_resilience": selected.scenario_resilience if selected else 0.0,
            "path_clearance": path_clearance_value,
            "support_zone": nearest_support.as_dict() if nearest_support else None,
            "next_obstacle_zone": next_obstacle.as_dict() if next_obstacle else None,
            "active_path_zones": [zone.as_dict() for zone in active_path],
            "invalidation": self._invalidation(candidate_direction, nearest_support, nearest_resistance),
            "actual_tte_minutes": tte_minutes,
            "expiration_timestamp": expiry_utc.isoformat() if expiry_utc else None,
            "session_regime": phase,
            "vol_regime": vol_regime,
            "regime_adjustments": adjustments,
            "webull_option_mode": "SNAPSHOT",
            "webull_status": webull_status,
            "quantdata_status": quant_status,
            "ready_executable": executable,
            "primary_reason": primary_reason,
            "reason_codes": list(dict.fromkeys(reasons + candidate_reasons)),
            "contract_switch_state": "CHALLENGER_PENDING" if self.selector.challenger_symbol else "STABLE",
            "option": option_payload,
            "required_move_scenarios": scenario,
            "cash_features": cash_features,
            "tracking_error_bps": tracking_error,
            "data_health": data_health,
            "arming": {"elapsed_seconds": transition.armed_seconds, "required_seconds": transition.required_seconds},
            "what_would_make_ready": self._what_ready(transition, core),
            "what_kills_it": self._what_kills(candidate_direction, nearest_support, nearest_resistance),
            "timestamp_lineage": timestamp_lineage(
                provider_event_time=futures.get("provider_event_time"),
                local_receive_time=futures.get("local_receive_time"),
                feature_complete_time=futures.get("feature_complete_time"),
                signal_decision_time=decision_time,
            ),
            "latency": {
                "futures_feature_us": finite(futures.get("engine_us")),
                "decision_compute_us": (time.perf_counter_ns() - decision_started) / 1000.0,
            },
            "source_version": "TRADYTICS_DETERMINISTIC_V2_0_0",
            "paper_trading_only": True,
            "order_execution_enabled": False,
            "as_of": decision_time,
        })
        self.last_decision = result
        if self.zones.dirty and now_monotonic - self.last_zone_save >= 5.0:
            self.zones.save()
            self.last_zone_save = now_monotonic
        return result

    @staticmethod
    def _invalidation(direction: str, support: Any, resistance: Any) -> str:
        if direction == "CALL" and support:
            return f"Accepted below support zone {support.lower_bound:.2f}"
        if direction == "PUT" and resistance:
            return f"Accepted above resistance zone {resistance.upper_bound:.2f}"
        return "Persistent opposite reversal state or hard data veto"

    def _what_ready(self, transition: Any, core: float) -> list[str]:
        if transition.state == DirectionState.ARMING_CALL:
            return [f"Bullish evidence must persist for {transition.required_seconds:.1f}s", "Flow persistence and live cash/futures confirmation"]
        if transition.state == DirectionState.ARMING_PUT:
            return [f"Bearish evidence must persist for {transition.required_seconds:.1f}s", "Flow persistence and live cash/futures confirmation"]
        return [f"CALL requires core >= {self.market['enter_threshold']:.2f}", f"PUT requires core <= -{self.market['enter_threshold']:.2f}"]

    def _what_kills(self, direction: str, support: Any, resistance: Any) -> list[str]:
        if direction == "CALL":
            items = [f"Directional core below hold threshold for {self.market['neutral_persistence_seconds']:.1f}s"]
            if support:
                items.append(f"Acceptance below {support.lower_bound:.2f}")
            return items
        if direction == "PUT":
            items = [f"Directional core above negative hold threshold for {self.market['neutral_persistence_seconds']:.1f}s"]
            if resistance:
                items.append(f"Acceptance above {resistance.upper_bound:.2f}")
            return items
        return ["No READY state is active"]
