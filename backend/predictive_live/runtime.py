"""Resilient provider orchestration outside the frozen inference hot path."""

from __future__ import annotations

import math
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from .cadence import FrozenCandidateCadence, PreparedCadenceCandidate
from .calendar import ExchangeSessionCalendar
from .features import FeatureUnavailable
from .providers.contracts import quant_candidate_eligible, quant_context_eligible
from .providers.event_adapter import normalize_option_snapshot, option_print_from_quant, signed_gex
from .providers.ninjatrader_live import PredictiveLevel1Receiver
from .providers.quantdata_live import QuantDataLiveClient
from .providers.webull_live import PredictiveWebullMarketData
from .service import PredictiveLiveService
from .structure_adapter import V2StructureAdapter


def _rows(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [row for row in value if isinstance(row, dict)]
    if isinstance(value, dict):
        for key in ("data", "list", "items"):
            result = _rows(value.get(key))
            if result:
                return result
    return []


def startup_option_history_ready(now: datetime, session: Any) -> bool:
    """Whether a complete frozen 120-second RTH context can exist."""
    return now.astimezone(timezone.utc) >= session.open_utc + timedelta(seconds=120)


class PredictiveProviderRuntime:
    def __init__(self, service: PredictiveLiveService, *, quant: QuantDataLiveClient | None = None,
                 webull: PredictiveWebullMarketData | None = None,
                 structure: V2StructureAdapter | None = None,
                 receiver: PredictiveLevel1Receiver | None = None) -> None:
        self.service = service
        self.quant = quant or QuantDataLiveClient(state_path=service.live_root / "state" / "quant_watermarks.json")
        self.webull = webull or PredictiveWebullMarketData()
        self.structure_adapter = structure or V2StructureAdapter()
        self.calendar = service.calendar
        self.stop_event = threading.Event(); self.thread: threading.Thread | None = None
        self.receiver = receiver or PredictiveLevel1Receiver(self._futures_second)
        self.cadence = FrozenCandidateCadence(60)
        self.active_contracts: dict[str, float] = {}
        self.active_expiration: dict[str, str] = {}
        self.latest_spot: dict[str, float] = {}
        self.term_surfaces: dict[str, Any] = {}
        self.structures: dict[str, dict[str, Any]] = {}
        self.option_context_extra: dict[str, dict[str, float]] = {"SPY": {}, "QQQ": {}}
        self.last_gex = 0.0; self.last_webull = 0.0; self.last_ladder = 0.0
        self.last_structure = 0.0; self.last_context = 0.0; self.last_health = 0.0
        self.warmup_complete = False

    def start(self) -> None:
        if self.thread and self.thread.is_alive():
            return
        self.receiver.start()
        self.thread = threading.Thread(target=self._run, name="predictive-provider-runtime", daemon=True)
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set(); self.receiver.stop()

    def _futures_second(self, row: dict[str, Any]) -> None:
        instrument = str(row["instrument"]).upper()
        try:
            self.service.features.futures[instrument].ingest_second_summary(
                second=int(row["second"]), last_open=row.get("last_open"), last_high=row.get("last_high"),
                last_low=row.get("last_low"), last_close=row.get("last_close"), bid=row.get("bid"), ask=row.get("ask"),
                volume=float(row.get("volume") or 0), trade_count=int(row.get("trade_count") or 0),
                large_trade_count=int(row.get("large_trade_count") or 0),
                trade_seen=row.get("trade_seen"), quote_seen=row.get("quote_seen"),
            )
            event_second = row.get("provider_event_second")
            event_time = datetime.fromtimestamp(int(event_second), timezone.utc).isoformat() if event_second is not None else None
            age_ms = max(0.0, time.time()*1000-int(event_second)*1000) if event_second is not None else None
            threshold = float(self.service.staleness["ninjatrader_futures"])*1000
            status = "LIVE" if age_ms is not None and age_ms <= threshold else "STALE"
            self.service.update_provider_health(f"NINJATRADER_{instrument}", status=status,
                age_ms=age_ms, event_time=event_time, receipt_time=datetime.now(timezone.utc).isoformat())
        except Exception as exc:
            self.service.update_provider_health(f"NINJATRADER_{instrument}", status="DEGRADED",
                age_ms=None, detail=type(exc).__name__)

    def _structure_for(self, symbol: str) -> dict[str, Any]:
        return self.structures.get(symbol, {"structure_bias":"TRANSITION / MIXED","transition":True,
                                             "source":"V2_STRUCTURE_UNAVAILABLE"})

    def _score_completed(self, items: list[PreparedCadenceCandidate]) -> None:
        for prepared in items:
            self.service.process_cadence_candidate(prepared, self._structure_for(prepared.event.symbol))

    def _consume_print(self, row: dict[str, Any], *, warmup: bool = False) -> None:
        context_ok, _reason = quant_context_eligible(row)
        candidate_ok, _candidate_reason = quant_candidate_eligible(row)
        if not context_ok and not candidate_ok:
            return
        event = option_print_from_quant(row, candidate=candidate_ok and not context_ok)
        bounds = self.calendar.for_timestamp(datetime.fromtimestamp(event.event_time_ms/1000, timezone.utc))
        if bounds is None or not (bounds.open_utc.timestamp()*1000 <= event.event_time_ms < bounds.close_utc.timestamp()*1000):
            return
        self.active_contracts[event.osi] = time.monotonic()
        self.active_expiration[event.symbol] = str(event.fields["expiration"])
        if event.stock_price is not None:
            self.latest_spot[event.symbol] = float(event.stock_price)
        if candidate_ok and not warmup:
            actionable, _reason, session = self.calendar.actionable_y30(event.event_time_ms)
            if actionable and session is not None:
                prepared = self.service.prepare_candidate(event, cadence_seconds=60,
                    session_open_ms=int(session.open_utc.timestamp()*1000))
                self._score_completed(self.cadence.observe(prepared))
        # Candidate and non-candidate context enters strictly after any snapshot.
        if context_ok:
            self.service.ingest_context(event)

    def _warmup(self) -> None:
        now = datetime.now(timezone.utc); session = self.calendar.for_timestamp(now)
        if session is None or now < session.open_utc:
            return
        # Before two full minutes of RTH have elapsed, the frozen 120-second
        # tape window cannot yet exist.  A complete backfill query thereafter
        # proves the available session history, including an honest absence of
        # prints, and restores up to 30 minutes of per-contract timestamps.
        if not startup_option_history_ready(now, session):
            for symbol in ("SPY", "QQQ"):
                self.service.set_option_warmup(symbol, False, "MODEL_WARMUP_120S")
            return
        target = max(session.open_utc, now - timedelta(minutes=30))
        ready: list[bool] = []
        for symbol in ("SPY", "QQQ"):
            self.service.set_option_warmup(symbol, False, "MODEL_WARMUP_BACKFILL")
            rows = self.quant.backfill_option_prints(symbol, since_ms=int(target.timestamp()*1000),
                                                      session_date=session.session_date)
            # A service that was already running at the RTH open may have seen
            # live rows during the initial 120-second warmup interval. Rebuild
            # the bounded option state from the complete chronological backfill
            # instead of attempting to prepend older rows to that newer state.
            # This also makes a retry deterministic after a partially consumed
            # warmup attempt.
            self.service.features.options[symbol].reset()
            processed: list[dict[str, Any]] = []
            for row in rows:
                self._consume_print(row, warmup=True); processed.append(row)
            self.quant.acknowledge_many(symbol, session.session_date, processed)
            self.service.set_option_warmup(symbol, True)
            ready.append(True)
        self.warmup_complete = len(ready) == 2

    def _poll_quant(self) -> None:
        now = datetime.now(timezone.utc); session = self.calendar.for_timestamp(now)
        if session is None:
            return
        for symbol in ("SPY", "QQQ"):
            rows = self.quant.poll_option_prints(symbol, session_date=session.session_date)
            processed: list[dict[str, Any]] = []
            try:
                for row in rows:
                    if not self.warmup_complete:
                        # Preserve the durable provider watermark while the
                        # one-time chronological backfill owns feature-state
                        # construction. The since_ms backfill intentionally
                        # replays acknowledged rows, so none are lost.
                        processed.append(row)
                        continue
                    try:
                        self._consume_print(row); processed.append(row)
                    except (FeatureUnavailable, ValueError):
                        # A valid provider row can be non-model-eligible; it is still
                        # durably consumed after conservative filtering.
                        processed.append(row)
            finally:
                # An unexpected later-row failure must not make already consumed
                # rows replay after restart. The failing row remains unacknowledged.
                if processed:
                    self.quant.acknowledge_many(symbol, session.session_date, processed)
            receipt = self.quant.last_successful_request_time.get(symbol)
            event_ms = self.quant.last_real_provider_event_time.get(symbol)
            event_time = datetime.fromtimestamp(event_ms/1000, timezone.utc).isoformat() if event_ms else None
            age_ms = max(0.0, time.time()*1000-event_ms) if event_ms else None
            threshold = float(self.service.staleness["quant_option_event"])*1000
            status = "LIVE" if age_ms is not None and age_ms <= threshold else "STALE"
            detail = "API_OK_EMPTY_RESPONSE" if not rows else f"API_OK_{len(rows)}_NEW_EVENTS"
            self.service.update_provider_health("QUANT_DATA", status=status, age_ms=age_ms,
                detail=detail, event_time=event_time, receipt_time=receipt)

    def _poll_webull(self) -> None:
        cash = self.webull.cash_quotes()
        cash_event_times: list[str] = []
        for symbol, row in cash.items():
            price = row.get("price")
            stamp = row.get("provider_event_time")
            if isinstance(price, (int, float)) and math.isfinite(float(price)) and stamp:
                self.latest_spot[symbol] = float(price)
                self.service.latest_underlying[symbol] = float(price)
                self.service.latest_underlying_time[symbol] = str(stamp)
                self.service.latest_underlying_source[symbol] = "WEBULL_CASH"
                cash_event_times.append(str(stamp))
        cutoff = time.monotonic() - 300.0
        self.active_contracts = {contract:seen for contract,seen in self.active_contracts.items() if seen >= cutoff}
        pinned = self.service.get_pinned_contracts()
        recent = [contract for contract,_seen in sorted(self.active_contracts.items(),
                  key=lambda item:(-item[1],item[0]))]
        symbols = list(dict.fromkeys([*pinned, *recent]))[:20]
        if not symbols:
            event_time = max(cash_event_times) if cash_event_times else self.service.provider_clocks.get("WEBULL",{}).get("last_real_provider_event_time")
            age_ms = self.service._age_ms(event_time)
            status = "LIVE" if age_ms is not None and age_ms <= float(self.service.staleness["webull_quote"])*1000 else "STALE"
            receipt = datetime.now(timezone.utc).isoformat()
            self.service.update_provider_health("WEBULL",status=status,age_ms=age_ms,
                detail="CASH_QUOTE_ONLY",event_time=event_time,receipt_time=receipt)
            return
        result = self.webull.client.option_snapshots(symbols)
        receipt = datetime.now(timezone.utc).isoformat()
        if result.status != "LIVE":
            self.service.update_provider_health("WEBULL", status=result.status, age_ms=None,
                                                detail=result.error_code or "", receipt_time=receipt)
            return
        event_times: list[str] = list(cash_event_times)
        for row in _rows(result.data):
            contract = str(row.get("symbol") or "")
            if contract:
                quote = normalize_option_snapshot(row); self.service.on_webull_quote(contract, quote)
                if quote.get("quote_time"):
                    event_times.append(str(quote["quote_time"]))
        event_time = max(event_times) if event_times else self.service.provider_clocks.get("WEBULL",{}).get("last_real_provider_event_time")
        age_ms = self.service._age_ms(event_time)
        status = "LIVE" if age_ms is not None and age_ms <= float(self.service.staleness["webull_quote"])*1000 else "STALE"
        self.service.update_provider_health("WEBULL", status=status, age_ms=age_ms,
            detail="API_OK_EMPTY_RESPONSE" if not event_times else "", event_time=event_time, receipt_time=receipt)

    def _refresh_ladders(self) -> None:
        for symbol, expiration in sorted(self.active_expiration.items()):
            spot = self.latest_spot.get(symbol)
            if spot is None:
                continue
            rows = self.webull.option_ladder(symbol=symbol, expiration=expiration,
                low_strike=spot*.97, high_strike=spot*1.03,
                quant_surface=self.term_surfaces.get(symbol), spot=spot)
            selected = {decision.candidate_contract for decision in self.service.decisions.values()}
            for row in rows:
                row["selected"] = row["contract_key"] in selected
                row["selected_models"] = [decision.model_id for decision in self.service.decisions.values()
                                                  if decision.candidate_contract == row["contract_key"]]
                matching = [decision for decision in self.service.decisions.values()
                            if decision.candidate_contract == row["contract_key"]]
                if matching:
                    primary = max(matching, key=lambda decision:decision.probability or 0)
                    row.update({"model_probability":primary.probability,"grade":primary.grade,
                                "p30_30":primary.grade_probability,
                                "aim_for_percent":primary.aim_for_percent,
                                "aim_for_percent_by_horizon":primary.aim_for_percent_by_horizon,
                                "display_probability_surface":primary.display_probability_surface})
            self.service.update_option_ladder(rows)

    @staticmethod
    def _latest_bucket(body: dict[str, Any]) -> dict[str, Any] | None:
        data = body.get("data") if isinstance(body, dict) else None
        if not isinstance(data, dict) or not data:
            return None
        value = data[sorted(data, key=lambda key:int(key) if str(key).isdigit() else -1)[-1]]
        return value if isinstance(value, dict) else None

    def _poll_gex_context(self) -> None:
        session = self.calendar.for_timestamp(datetime.now(timezone.utc))
        if session is None:
            return
        successful_symbols = 0
        for symbol in ("SPY", "QQQ"):
            try:
                self.term_surfaces[symbol] = self.quant.term_structure(symbol)
                values, provider_spot = signed_gex(
                    self.quant.exposure_by_strike(
                        symbol, expiration_dates=[session.session_date]
                    ), symbol
                )
                if not values:
                    raise RuntimeError("EMPTY_GEX_CONTEXT")
                self.service.update_gex(symbol, timestamp=datetime.now(timezone.utc),
                                        signed_by_strike=values, scope="0DTE",
                                        spot=provider_spot)
                drift = self._latest_bucket(self.quant.net_drift(symbol, session.session_date))
                if drift:
                    values_to_sum = [drift.get("netCallPremium"), drift.get("netPutPremium")]
                    if all(isinstance(value,(int,float)) and math.isfinite(float(value)) for value in values_to_sum):
                        self.option_context_extra[symbol]["net_drift"] = sum(float(value) for value in values_to_sum)
                successful_symbols += 1
            except Exception as exc:
                self.service.update_provider_health("QUANT_CONTEXT", status="DEGRADED", age_ms=None,
                                                    detail=f"gex_context_{symbol}:{type(exc).__name__}")
        if successful_symbols == 2:
            now = datetime.now(timezone.utc).isoformat()
            self.service.update_provider_health("QUANT_CONTEXT", status="LIVE", age_ms=0,
                                                detail="SPY_QQQ_CONTEXT_CURRENT",
                                                event_time=now, receipt_time=now)

    def _poll_structure(self) -> None:
        for symbol in ("SPY","QQQ"):
            try:
                self.structures[symbol] = self.structure_adapter.snapshot(symbol)
            except Exception as exc:
                self.structures[symbol] = {"source":"TRUSTED_V2_UNAVAILABLE", "age_ms":None,
                                           "transition":True, "error":type(exc).__name__}
            self.service.update_structure_state(symbol, self.structures[symbol])

    def _refresh_market_context(self) -> None:
        now = datetime.now(timezone.utc)
        for symbol in ("SPY","QQQ"):
            option = self.service.features.options[symbol].context_summary(int(now.timestamp()*1000))
            option.update(self.option_context_extra[symbol])
            self.service.update_market_context(symbol, option_context=option,
                structure=self._structure_for(symbol), as_of=now.isoformat())

    def _safe(self, name: str, function: Callable[[], None], provider: str | None = None) -> None:
        try:
            function()
        except Exception as exc:
            if provider:
                self.service.update_provider_health(provider, status="DEGRADED", age_ms=None,
                                                    detail=f"{name}:{type(exc).__name__}")

    def _run(self) -> None:
        self._safe("startup_warmup", self._warmup, "QUANT_DATA")
        backoff = 0.25
        while not self.stop_event.is_set():
            begun = time.monotonic()
            try:
                if not self.warmup_complete:
                    self._safe("startup_warmup", self._warmup, "QUANT_DATA")
                self._safe("quant_poll", self._poll_quant, "QUANT_DATA")
                now_ms = int(time.time()*1000)
                self._safe("cadence_flush", lambda:self._score_completed(self.cadence.flush_due(now_ms)))
                if begun-self.last_webull >= 1.5:
                    self._safe("webull_poll", self._poll_webull, "WEBULL"); self.last_webull=begun
                if begun-self.last_structure >= 1.0:
                    self._safe("v2_structure", self._poll_structure); self.last_structure=begun
                if begun-self.last_gex >= 30:
                    self._safe("quant_context", self._poll_gex_context, "QUANT_DATA"); self.last_gex=begun
                if begun-self.last_context >= 2:
                    self._safe("market_context", self._refresh_market_context); self.last_context=begun
                if begun-self.last_ladder >= 60:
                    self._safe("ladder_refresh", self._refresh_ladders, "WEBULL"); self.last_ladder=begun
                if begun-self.last_health >= .5:
                    self.service.sweep_freshness(); self.last_health=begun
                    publisher_health=self.service.publisher.health()
                    publish_status = ("LIVE" if publisher_health["status"] == "LIVE" else
                                      "UNAVAILABLE" if publisher_health["status"] == "DISABLED" else "DEGRADED")
                    self.service.update_provider_health("SUPABASE",
                        status=publish_status, age_ms=0,
                        detail="CURRENT_STATE_QUEUE_OK" if publish_status == "LIVE" else
                               "PUBLISH_DISABLED" if publish_status == "UNAVAILABLE" else "PUBLISH_ERRORS")
                backoff=.25
            except Exception as exc:
                # Last-resort containment: a provider bug cannot terminate the
                # runtime thread or prevent other providers from recovering.
                self.service.update_provider_health("QUANT_DATA",status="DEGRADED",age_ms=None,
                                                    detail=f"RUNTIME_LOOP:{type(exc).__name__}")
                backoff=min(5.0,backoff*2)
            self.stop_event.wait(max(backoff,1.0-(time.monotonic()-begun)))
