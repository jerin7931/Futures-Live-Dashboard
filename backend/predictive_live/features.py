"""Incremental feature state reproducing the frozen event/tape and futures contracts."""

from __future__ import annotations

import math
from collections import defaultdict, deque
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

import numpy as np


OPTION_WINDOWS = (1, 5, 15, 30, 60, 120)
FUTURES_WINDOWS = (5, 15, 30, 60, 120)
BUY_CODES = {"ASK", "ABOVE_ASK"}
SELL_CODES = {"BID", "BELOW_BID"}
FLOW_KEYS = ("call_buy", "call_sell", "put_buy", "put_sell")
REPORTED_SIDE_KEYS = ("call_ask", "call_bid", "put_ask", "put_bid")


class FeatureUnavailable(RuntimeError):
    pass


def _side_key(event: "OptionPrint", directional: bool = True) -> str | None:
    contract = event.contract_type.upper()
    side = event.trade_side.upper()
    if contract not in {"CALL", "PUT"}:
        return None
    if side in BUY_CODES:
        suffix = "buy" if directional else "ask"
    elif side in SELL_CODES:
        suffix = "sell" if directional else "bid"
    else:
        return None
    return f"{contract.lower()}_{suffix}"


@dataclass(frozen=True)
class OptionPrint:
    symbol: str
    event_time_ms: int
    osi: str
    contract_type: str
    trade_side: str
    premium: float
    size: float
    delta: float | None
    stock_price: float | None
    is_complex: bool = False
    is_tied: bool = False
    trade_type: str = "UNKNOWN"
    fields: dict[str, Any] = field(default_factory=dict)
    provider_id: str = ""


class IncrementalOptionFeatures:
    """Bounded rolling state; the candidate event is scored before it is inserted."""

    def __init__(self) -> None:
        self.events: deque[OptionPrint] = deque()
        self.stock_events: deque[tuple[int, float]] = deque()
        self.contract_times: dict[str, deque[int]] = defaultdict(deque)
        self.last_event_time_ms = -1

    def reset(self) -> None:
        self.events.clear()
        self.stock_events.clear()
        self.contract_times.clear()
        self.last_event_time_ms = -1

    @property
    def oldest_event_time_ms(self) -> int | None:
        return self.events[0].event_time_ms if self.events else None

    def context_summary(self, now_ms: int) -> dict[str, float]:
        """Real causal option-tape context for the dashboard, never model input."""
        self._expire(now_ms)
        selected = [event for event in self.events if event.event_time_ms < now_ms and event.event_time_ms >= now_ms - 60_000]
        simple = [event for event in selected if bool(event.fields.get("is_simple_directional"))]
        bullish = 0.0
        for event in simple:
            side = _side_key(event, True)
            sign = 1 if side in {"call_buy", "put_sell"} else -1 if side in {"call_sell", "put_buy"} else 0
            bullish += sign * float(event.premium)
        result: dict[str, float] = {}
        if simple:
            result["directional_flow"] = bullish
            result["simple_print_count_60s"] = float(len(simple))
        ivs = []
        for event in selected:
            value = event.fields.get("impliedVolatility")
            try:
                value = float(value)
            except (TypeError, ValueError):
                continue
            if math.isfinite(value):
                ivs.append(value)
        if ivs:
            result["iv_level"] = sum(ivs) / len(ivs)
        return result

    def ingest(self, event: OptionPrint) -> None:
        if event.event_time_ms < self.last_event_time_ms:
            raise FeatureUnavailable("Severe option-event timestamp disorder")
        self.last_event_time_ms = event.event_time_ms
        self.events.append(event)
        if event.stock_price is not None and event.stock_price > 0:
            self.stock_events.append((event.event_time_ms, float(event.stock_price)))
        self.contract_times[event.osi].append(event.event_time_ms)
        self._expire(event.event_time_ms)

    def _expire(self, now_ms: int) -> None:
        while self.events and self.events[0].event_time_ms < now_ms - 121_000:
            self.events.popleft()
        while self.stock_events and self.stock_events[0][0] < now_ms - 241_000:
            self.stock_events.popleft()
        threshold = now_ms - 30 * 60 * 1000
        for osi in tuple(self.contract_times):
            values = self.contract_times[osi]
            while values and values[0] < threshold:
                values.popleft()
            if not values:
                del self.contract_times[osi]

    @staticmethod
    def _base_candidate(candidate: OptionPrint, cadence_seconds: int, session_open_ms: int) -> dict[str, Any]:
        output = dict(candidate.fields)
        bid = float(output.get("bidPrice", math.nan))
        ask = float(output.get("askPrice", math.nan))
        if not np.isfinite(bid) or not np.isfinite(ask) or bid < 0 or ask <= 0 or bid > ask:
            raise FeatureUnavailable("Candidate quote is missing, crossed, or impossible")
        mid = (bid + ask) / 2
        spread = ask - bid
        output.update({
            "bidPrice": bid,
            "askPrice": ask,
            "bidAskSpread": output.get("bidAskSpread", spread),
            "cadence_seconds": cadence_seconds,
            "contract_mid": mid,
            "contract_spread_abs": spread,
            "contract_spread_rel": spread / mid if mid > 0 else math.nan,
            "contract_target_burden": spread / (0.30 * ask),
            "stockPrice": candidate.stock_price,
            "greek_delta": candidate.delta,
            "optionPrice": output.get("optionPrice", output.get("lastPrice", math.nan)),
        })
        greeks = output.get("greeks", {}) or {}
        for name in ("delta", "gamma", "theta", "vega", "rho", "vanna", "charm", "vomma", "veta", "speed", "zomma", "color", "ultima", "omega", "sigma"):
            output.setdefault(f"greek_{name}", greeks.get(name))
        moneyness = output.get("moneyness", {}) or {}
        output.setdefault("moneyness_degree", moneyness.get("degree"))
        output.setdefault("moneyness_percent", moneyness.get("degreeInPercent"))
        output.setdefault("money_type", moneyness.get("moneyType", "UNKNOWN"))
        minute = (candidate.event_time_ms - session_open_ms) / 60_000.0
        output["minute_of_session"] = minute
        output["session_phase"] = "OPEN" if minute < 60 else "MIDDAY" if minute < 300 else "CLOSE"
        output["day_of_week"] = datetime.fromtimestamp(candidate.event_time_ms / 1000).weekday()
        output["is_call"] = int(candidate.contract_type.upper() == "CALL")
        return output

    def snapshot(self, candidate: OptionPrint, *, cadence_seconds: int, session_open_ms: int) -> dict[str, Any]:
        self._expire(candidate.event_time_ms)
        t = candidate.event_time_ms
        output = self._base_candidate(candidate, cadence_seconds, session_open_ms)
        prior_events = [event for event in self.events if event.event_time_ms < t]
        for window in OPTION_WINDOWS:
            selected = [event for event in prior_events if event.event_time_ms >= t - window * 1000]
            simple = [event for event in selected if bool(event.fields.get("is_simple_directional"))]
            complex_tied = [event for event in selected if event.is_complex or event.is_tied]
            ambiguous = [event for event in selected if bool(event.fields.get("is_ambiguous"))]
            for key in FLOW_KEYS:
                subset = [event for event in simple if _side_key(event, True) == key]
                output[f"simple_directional_flow_{key}_premium_{window}s"] = sum(float(event.premium) for event in subset)
                output[f"simple_directional_flow_{key}_count_{window}s"] = len(subset)
                output[f"simple_directional_flow_{key}_delta_premium_{window}s"] = sum(float(event.premium) * abs(float(event.delta or 0.0)) for event in subset)
            for key in REPORTED_SIDE_KEYS:
                subset = [event for event in complex_tied if _side_key(event, False) == key]
                output[f"complex_tied_flow_reported_{key}_premium_{window}s"] = sum(float(event.premium) for event in subset)
                output[f"complex_tied_flow_reported_{key}_count_{window}s"] = len(subset)
            output[f"complex_tied_flow_total_premium_{window}s"] = sum(float(event.premium) for event in complex_tied)
            output[f"complex_tied_flow_total_count_{window}s"] = len(complex_tied)
            for key in REPORTED_SIDE_KEYS:
                subset = [event for event in ambiguous if _side_key(event, False) == key]
                output[f"ambiguous_flow_reported_{key}_premium_{window}s"] = sum(float(event.premium) for event in subset)
                output[f"ambiguous_flow_reported_{key}_count_{window}s"] = len(subset)
            output[f"ambiguous_flow_total_premium_{window}s"] = sum(float(event.premium) for event in ambiguous)
            output[f"ambiguous_flow_total_count_{window}s"] = len(ambiguous)
            call_buy = output[f"simple_directional_flow_call_buy_premium_{window}s"]
            call_sell = output[f"simple_directional_flow_call_sell_premium_{window}s"]
            put_buy = output[f"simple_directional_flow_put_buy_premium_{window}s"]
            put_sell = output[f"simple_directional_flow_put_sell_premium_{window}s"]
            output[f"simple_directional_flow_underlying_bullish_premium_{window}s"] = call_buy + put_sell - call_sell - put_buy
            output[f"simple_directional_flow_total_premium_{window}s"] = call_buy + call_sell + put_buy + put_sell
            half = max(1, window // 2)
            classified = [event for event in simple if _side_key(event, True) is not None]
            recent = [event for event in classified if event.event_time_ms >= t - half * 1000]
            prior = [event for event in classified if event.event_time_ms < t - half * 1000]
            output[f"simple_directional_flow_acceleration_premium_{window}s"] = sum(event.premium for event in recent) - sum(event.premium for event in prior)

        current_price = candidate.stock_price
        for window in OPTION_WINDOWS:
            target = t - window * 1000
            past = next(((stamp, price) for stamp, price in reversed(self.stock_events) if stamp <= target), None)
            if current_price and current_price > 0 and past and target - past[0] <= max(60, window) * 1000:
                output[f"underlying_event_return_{window}s"] = float(current_price) / past[1] - 1
                output[f"underlying_event_return_staleness_{window}s"] = (target - past[0]) / 1000
            else:
                output[f"underlying_event_return_{window}s"] = math.nan
                output[f"underlying_event_return_staleness_{window}s"] = math.nan
        alignment = 1 if candidate.contract_type.upper() == "CALL" else -1
        for window in OPTION_WINDOWS:
            output[f"candidate_aligned_simple_flow_premium_{window}s"] = alignment * output[f"simple_directional_flow_underlying_bullish_premium_{window}s"]
            raw_return = output[f"underlying_event_return_{window}s"]
            output[f"candidate_aligned_underlying_return_{window}s"] = alignment * raw_return

        side = str(candidate.fields.get("trade_side_code") or candidate.trade_side).upper()
        normalized_side = candidate.trade_side.upper()
        demand = 1 if normalized_side in BUY_CODES else -1 if normalized_side in SELL_CODES else 0
        output.update({
            "entry_trade_side": side,
            "entry_option_demand_side": demand,
            "entry_underlying_direction": alignment * demand,
            "entry_trade_size": candidate.size,
            "entry_premium": candidate.premium,
            "entry_trade_type": candidate.trade_type,
            "entry_is_complex": int(candidate.is_complex),
            "entry_is_tied": int(candidate.is_tied),
            "entry_trade_class": candidate.fields.get("trade_class", "AMBIGUOUS_NON_DIRECTIONAL"),
            "entry_is_simple_directional": int(bool(candidate.fields.get("is_simple_directional"))),
            "entry_is_ambiguous": int(bool(candidate.fields.get("is_ambiguous"))),
            "entry_is_excluded_bad_trade": int(bool(candidate.fields.get("is_excluded_bad_trade"))),
            "trade_classifier_version": candidate.fields.get("trade_classifier_version"),
        })
        contract_times = [stamp for stamp in self.contract_times.get(candidate.osi, ()) if stamp < t]
        output["time_since_previous_contract_print_seconds"] = (t - contract_times[-1]) / 1000 if contract_times else math.nan
        for minutes in (5, 15, 30):
            observed = [stamp for stamp in contract_times if stamp >= t - minutes * 60 * 1000]
            output[f"prior_contract_print_count_{minutes}m"] = len(observed)
            output[f"prior_contract_print_max_gap_seconds_{minutes}m"] = max(((right - left) / 1000 for left, right in zip(observed, observed[1:])), default=math.nan)
        return output


@dataclass
class _SecondBucket:
    second: int
    last_open: float | None = None
    last_high: float | None = None
    last_low: float | None = None
    last_close: float | None = None
    bid: float | None = None
    ask: float | None = None
    volume: float = 0.0
    trade_count: int = 0
    large_trade_count: int = 0
    trade_seen: bool = False
    quote_seen: bool = False


class IncrementalFuturesFeatures:
    """Completed-one-second Level-1 features for one ES or NQ contract."""

    def __init__(self, instrument: str):
        self.instrument = instrument.lower()
        self.current: _SecondBucket | None = None
        self.completed: deque[dict[str, float]] = deque(maxlen=242)
        self.last_bid: float | None = None
        self.last_ask: float | None = None
        self.last_trade: float | None = None
        self.last_trade_event_second: int | None = None
        self.last_quote_event_second: int | None = None
        self.last_event_ms = -1

    def reset(self) -> None:
        self.__init__(self.instrument)

    def ingest(self, *, event_time_ms: int, kind: str, price: float, volume: float = 0.0) -> None:
        if event_time_ms < self.last_event_ms:
            raise FeatureUnavailable(f"Severe {self.instrument.upper()} timestamp disorder")
        self.last_event_ms = event_time_ms
        second = event_time_ms // 1000
        self._advance_to(second)
        assert self.current is not None
        kind = kind.upper()
        if kind == "LAST":
            bucket = self.current
            bucket.last_open = price if bucket.last_open is None else bucket.last_open
            bucket.last_high = price if bucket.last_high is None else max(bucket.last_high, price)
            bucket.last_low = price if bucket.last_low is None else min(bucket.last_low, price)
            bucket.last_close = price
            bucket.volume += max(0.0, float(volume))
            bucket.trade_count += 1
            bucket.large_trade_count += int(volume >= 50)
            bucket.trade_seen = True
        elif kind == "BID":
            self.current.bid = price; self.current.quote_seen = True
        elif kind == "ASK":
            self.current.ask = price; self.current.quote_seen = True
        else:
            raise ValueError(f"Unknown futures event kind: {kind}")

    def ingest_second_summary(
        self,
        *,
        second: int,
        last_open: float | None = None,
        last_high: float | None = None,
        last_low: float | None = None,
        last_close: float | None = None,
        bid: float | None = None,
        ask: float | None = None,
        volume: float = 0.0,
        trade_count: int = 0,
        large_trade_count: int = 0,
        trade_seen: bool | None = None,
        quote_seen: bool | None = None,
    ) -> None:
        """Accept a provider-normalized, completed one-second Level-1 bucket.

        NinjaTrader source rows are normalized upstream using the immutable
        research duplicate/collision policy.  Keeping that source-specific
        normalization outside this rolling engine avoids treating two distinct
        same-timestamp ticks as duplicates and makes replay/live semantics
        identical after the provider boundary.
        """
        if self.current is not None and second <= self.current.second:
            raise FeatureUnavailable(f"Non-increasing {self.instrument.upper()} second summary")
        self._advance_to(second)
        assert self.current is not None
        values = (last_open, last_high, last_low, last_close, bid, ask)
        clean = [float(value) if value is not None and np.isfinite(value) else None for value in values]
        (
            self.current.last_open,
            self.current.last_high,
            self.current.last_low,
            self.current.last_close,
            self.current.bid,
            self.current.ask,
        ) = clean
        self.current.volume = max(0.0, float(volume))
        self.current.trade_count = max(0, int(trade_count))
        self.current.large_trade_count = max(0, int(large_trade_count))
        self.current.trade_seen = self.current.last_close is not None if trade_seen is None else bool(trade_seen)
        self.current.quote_seen = (
            self.current.bid is not None or self.current.ask is not None
            if quote_seen is None else bool(quote_seen)
        )
        # A completed empty bucket is a clock boundary, not fresh market data.
        if self.current.trade_seen or self.current.quote_seen:
            self.last_event_ms = max(self.last_event_ms, second * 1000)

    def _advance_to(self, second: int) -> None:
        if self.current is None:
            self.current = _SecondBucket(second)
            return
        while self.current.second < second:
            self._finalize_current()
            self.current = _SecondBucket(self.current.second + 1)

    def _finalize_current(self) -> None:
        assert self.current is not None
        bucket = self.current
        if bucket.quote_seen:
            self.last_quote_event_second = bucket.second
        if bucket.trade_seen:
            self.last_trade_event_second = bucket.second
        self.last_bid = bucket.bid if bucket.bid is not None else self.last_bid
        self.last_ask = bucket.ask if bucket.ask is not None else self.last_ask
        previous_trade = self.last_trade
        self.last_trade = bucket.last_close if bucket.last_close is not None else self.last_trade
        mid = (self.last_bid + self.last_ask) / 2 if self.last_bid is not None and self.last_ask is not None else math.nan
        spread = self.last_ask - self.last_bid if self.last_bid is not None and self.last_ask is not None else math.nan
        if bucket.trade_seen and self.last_trade is not None:
            sign = 1 if self.last_trade > mid else -1 if self.last_trade < mid else np.sign(self.last_trade - previous_trade) if previous_trade is not None else 0
        else:
            sign = 0
        self.completed.append({
            "second": float(bucket.second), "last": float(self.last_trade) if self.last_trade is not None else math.nan,
            "mid": float(mid), "spread": float(spread), "volume": bucket.volume,
            "trade_count": float(bucket.trade_count), "large_trade_count": float(bucket.large_trade_count),
            "signed_volume": float(sign * bucket.volume),
            "trade_staleness": float(bucket.second - self.last_trade_event_second) if self.last_trade_event_second is not None else math.nan,
            "quote_staleness": float(bucket.second - self.last_quote_event_second) if self.last_quote_event_second is not None else math.nan,
        })

    def snapshot(self, *, candidate_time_ms: int, is_call: bool, etf_returns: dict[int, float]) -> dict[str, Any]:
        # Only seconds whose bucket has closed are available.
        self._advance_to(candidate_time_ms // 1000)
        if not self.completed:
            raise FeatureUnavailable(f"No completed {self.instrument.upper()} futures bucket")
        rows = list(self.completed)
        latest = rows[-1]
        prefix = self.instrument
        output: dict[str, Any] = {
            f"{prefix}_spread_abs": latest["spread"],
            f"{prefix}_spread_rel": latest["spread"] / latest["mid"] if latest["mid"] else math.nan,
            f"{prefix}_trade_staleness_seconds": latest["trade_staleness"],
            f"{prefix}_quote_staleness_seconds": latest["quote_staleness"],
        }
        alignment = 1 if is_call else -1
        for window in FUTURES_WINDOWS:
            selected = rows[-window:]
            start = rows[-window - 1] if len(rows) > window else None
            latest_last = latest["last"]; latest_mid = latest["mid"]
            raw_return = latest_last / start["last"] - 1 if start and start["last"] > 0 else math.nan
            quote_move = latest_mid / start["mid"] - 1 if start and start["mid"] > 0 else math.nan
            return_rows = rows[-(window + 1):]
            logs = np.diff(np.log([row["last"] for row in return_rows if np.isfinite(row["last"]) and row["last"] > 0]))
            realized = float(np.std(logs, ddof=1)) if len(logs) >= max(2, window // 3) else math.nan
            volume = sum(row["volume"] for row in selected)
            signed = sum(row["signed_volume"] for row in selected)
            output.update({
                f"{prefix}_return_{window}s": raw_return,
                f"{prefix}_quote_move_{window}s": quote_move,
                f"{prefix}_realized_vol_{window}s": realized,
                f"{prefix}_trade_count_{window}s": sum(row["trade_count"] for row in selected),
                f"{prefix}_volume_{window}s": volume,
                f"{prefix}_signed_volume_{window}s": signed,
                f"{prefix}_flow_imbalance_{window}s": signed / volume if volume else math.nan,
                f"{prefix}_large_trade_count_{window}s": sum(row["large_trade_count"] for row in selected),
                f"{prefix}_spread_mean_{window}s": float(np.nanmean([row["spread"] for row in selected])),
            })
            for name in ("return", "quote_move", "signed_volume", "flow_imbalance"):
                output[f"candidate_aligned_{prefix}_{name}_{window}s"] = alignment * output[f"{prefix}_{name}_{window}s"]
            etf = etf_returns.get(window, math.nan)
            output[f"{prefix}_minus_etf_return_{window}s"] = raw_return - etf
            output[f"candidate_aligned_{prefix}_minus_etf_return_{window}s"] = alignment * output[f"{prefix}_minus_etf_return_{window}s"]
        return output


class LiveFeatureEngine:
    def __init__(self) -> None:
        self.options = {"SPY": IncrementalOptionFeatures(), "QQQ": IncrementalOptionFeatures()}
        self.futures = {"ES": IncrementalFuturesFeatures("ES"), "NQ": IncrementalFuturesFeatures("NQ")}
        self.context: dict[str, dict[str, Any]] = {"SPY": {}, "QQQ": {}}

    def update_context(self, symbol: str, values: dict[str, Any]) -> None:
        self.context[symbol].update(values)

    def update_futures(self, instrument: str, **event: Any) -> None:
        self.futures[instrument].ingest(**event)

    def build(self, candidate: OptionPrint, *, cadence_seconds: int, session_open_ms: int, futures_source: str | None, allowlist: tuple[str, ...]) -> dict[str, Any]:
        values = dict(self.context[candidate.symbol])
        values.update(self.options[candidate.symbol].snapshot(candidate, cadence_seconds=cadence_seconds, session_open_ms=session_open_ms))
        if futures_source:
            futures = self.futures[futures_source]
            if futures.last_event_ms < 0 or candidate.event_time_ms - futures.last_event_ms > 3_000:
                raise FeatureUnavailable(f"Required {futures_source} state unavailable or stale")
            etf = {window: values.get(f"underlying_event_return_{window}s", math.nan) for window in FUTURES_WINDOWS}
            values.update(futures.snapshot(candidate_time_ms=candidate.event_time_ms, is_call=candidate.contract_type.upper() == "CALL", etf_returns=etf))
        # Explicit allowlist only. No numeric passthrough is possible.
        vector = {name: values[name] for name in allowlist if name in values}
        missing = [name for name in allowlist if name not in vector]
        if missing:
            raise FeatureUnavailable(f"Unresolvable frozen feature schema: {missing[:8]}")
        return vector

    def record_candidate_event(self, candidate: OptionPrint) -> None:
        self.options[candidate.symbol].ingest(candidate)
