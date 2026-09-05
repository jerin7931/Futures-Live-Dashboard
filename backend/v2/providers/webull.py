from __future__ import annotations

import logging
import os
import re
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from ..math_utils import utc_iso


WEBULL_OPTION_MODE = "SNAPSHOT"
_SDK_LOG_LOCK = threading.Lock()


def _credentials() -> tuple[str, str]:
    app_key = os.environ.get("WEBULL_APP_KEY", "").strip()
    app_secret = os.environ.get("WEBULL_APP_SECRET", "").strip()
    if not app_key or not app_secret:
        path = Path.home() / "Documents" / "Api keys" / "Webull api.txt"
        if path.is_file():
            for raw in path.read_text(encoding="utf-8-sig").splitlines():
                if ":" not in raw:
                    continue
                label, value = raw.split(":", 1)
                normalized = re.sub(r"[^a-z]", "", label.lower())
                if normalized == "appkey":
                    app_key = value.strip()
                elif normalized == "appsecret":
                    app_secret = value.strip()
    if len(app_key) != 35 or len(app_secret) != 32:
        raise RuntimeError("Webull app credential is missing or malformed")
    return app_key, app_secret


def _disable_sdk_logging() -> None:
    for name in ("webull", "webull.core", "webull.core.client", "webull.core.http.response"):
        logger = logging.getLogger(name)
        logger.disabled = True
        logger.handlers.clear()
        logger.propagate = False


@dataclass
class WebullResult:
    data: Any
    provider_event_time: str | None
    local_receive_time: str
    latency_ms: float
    status: str
    error_code: str | None = None
    error_message: str | None = None


class WebullMarketDataClient:
    """Official market-data SDK only. No trading client or order request is imported."""

    option_mode = WEBULL_OPTION_MODE
    stock_mode = "SNAPSHOT_REST"
    l2_mode = "SNAPSHOT_REST"

    def __init__(self, app_key: str | None = None, app_secret: str | None = None) -> None:
        global_disable = logging.root.manager.disable
        logging.disable(logging.CRITICAL)
        try:
            from webull.core.client import ApiClient
            from webull.data.data_client import DataClient
            key, secret = (app_key, app_secret) if app_key and app_secret else _credentials()
            api_client = ApiClient(key, secret, "us")
            # DataClient creates a local file/console handler unless these
            # flags are set. Do this before construction so a sensitive log
            # file is never opened, even for one request.
            api_client._stream_logger_set = True
            api_client._file_logger_set = True
            self.client = DataClient(api_client)
            self.api_client = api_client
            _disable_sdk_logging()
        finally:
            logging.disable(global_disable)
        self.last_good: dict[str, WebullResult] = {}
        self.l2_retry_after: dict[str, float] = {}

    def _call(self, name: str, operation: Callable[[], Any]) -> WebullResult:
        started = time.perf_counter()
        try:
            # Some SDK releases log signed headers on HTTP errors. Suppress
            # all SDK logging for the complete request lifetime.
            with _SDK_LOG_LOCK:
                prior_disable = logging.root.manager.disable
                logging.disable(logging.CRITICAL)
                _disable_sdk_logging()
                try:
                    response = operation()
                finally:
                    logging.disable(prior_disable)
            body = response.json() if getattr(response, "content", b"") else None
            result = WebullResult(body, extract_provider_time(body), utc_iso(), (time.perf_counter() - started) * 1000.0, "LIVE")
            self.last_good[name] = result
            return result
        except Exception as exc:
            cached = self.last_good.get(name)
            status = "DEGRADED" if cached else "UNAVAILABLE"
            data = cached.data if cached else None
            event_time = cached.provider_event_time if cached else None
            return WebullResult(
                data,
                event_time,
                utc_iso(),
                (time.perf_counter() - started) * 1000.0,
                status,
                re.sub(r"[^A-Za-z0-9_\-]", "", str(getattr(exc, "error_code", type(exc).__name__)))[:80],
                # Exception text is intentionally discarded because affected
                # SDK versions may embed request metadata in it.
                None,
            )

    def stock_snapshot(self, symbols: list[str]) -> WebullResult:
        from webull.data.common.category import Category
        # Regular-session/extended quote entitlement. Requesting the separate
        # overnight product causes MARKET_DATA_NOT_SUBSCRIBED even when Nasdaq
        # TotalView and OPRA are active.
        return self._call("stock_snapshot", lambda: self.client.market_data.get_snapshot(symbols, Category.US_ETF.name, True, False))

    def cash_depth(self, symbol: str, depth: int = 10) -> WebullResult:
        from webull.data.common.category import Category
        if time.monotonic() < self.l2_retry_after.get(symbol, 0.0):
            return WebullResult(None, None, utc_iso(), 0.0, "DEGRADED", "NASDAQ_L2_UNAVAILABLE")
        result = self._call(f"{symbol}:depth:v3", lambda: self._current_depth_response(symbol, Category.US_ETF.name, depth))
        if result.status == "LIVE" or depth <= 1:
            return result
        # Reconfirm available L1 once, then back off L2 entitlement retries for
        # five minutes. The stock snapshot already carries the hot-path BBO.
        fallback = self._call(f"{symbol}:depth:l1", lambda: self._current_depth_response(symbol, Category.US_ETF.name, 1))
        self.l2_retry_after[symbol] = time.monotonic() + 300.0
        if fallback.status == "LIVE":
            fallback.status = "DEGRADED"
            fallback.error_code = "NASDAQ_L2_UNAVAILABLE_L1_ONLY"
        return fallback

    def _current_depth_response(self, symbol: str, category: str, depth: int) -> Any:
        """Call the current documented v3 path absent from SDK 2.0.19."""
        from webull.core.request import ApiRequest
        request = ApiRequest(
            "/market-data/stocks/depths/list",
            version="v3",
            method="GET",
            query_params={
                "symbol": symbol,
                "category": category,
                "depth": str(depth),
                "overnight_required": "false",
            },
        )
        return self.api_client.get_response(request)

    def option_contracts(self, symbol: str, expiration: str, low_strike: float, high_strike: float) -> WebullResult:
        from webull.data.common.category import Category
        return self._call(
            f"{symbol}:contracts:{expiration}",
            lambda: self.client.instrument.get_option_contracts(
                Category.US_OPTION.name,
                symbol,
                status="LISTING",
                start_date=expiration,
                end_date=expiration,
                style="AMERICAN",
                strike_price_gte=low_strike,
                strike_price_lte=high_strike,
                page_size=1000,
            ),
        )

    def option_snapshots(self, option_symbols: list[str]) -> WebullResult:
        from webull.data.common.category import Category
        symbols = option_symbols[:20]
        return self._call("option_snapshots", lambda: self.client.option_market_data.get_option_snapshot(symbols, Category.US_OPTION.name))


def extract_provider_time(value: Any) -> str | None:
    candidates: list[Any] = []

    def visit(item: Any) -> None:
        if isinstance(item, dict):
            for key, child in item.items():
                if str(key).lower() in {"timestamp", "time", "quote_time", "trade_time", "updated_at"}:
                    candidates.append(child)
                visit(child)
        elif isinstance(item, list):
            for child in item:
                visit(child)

    visit(value)
    from datetime import datetime, timezone
    iso_values: list[datetime] = []
    for item in candidates:
        if not isinstance(item, str):
            continue
        try:
            parsed = datetime.fromisoformat(item.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            iso_values.append(parsed.astimezone(timezone.utc))
        except ValueError:
            continue
    if iso_values:
        return max(iso_values).isoformat()
    numbers = [float(item) for item in candidates if isinstance(item, (int, float))]
    if not numbers:
        return None
    newest = max(numbers)
    if newest > 10_000_000_000:
        newest /= 1000.0
    try:
        return datetime.fromtimestamp(newest, timezone.utc).isoformat()
    except (OSError, OverflowError, ValueError):
        return None
