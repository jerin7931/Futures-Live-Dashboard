#!/usr/bin/env python3
"""Read-only provider connectivity probe with deliberately redacted output."""
from __future__ import annotations

import json
import argparse
import logging
import re
import sys
import time
from pathlib import Path
from typing import Any, Callable

import requests


KEY_DIR = Path.home() / "Documents" / "Api keys"


def _token(path: Path, pattern: str) -> str:
    text = path.read_text(encoding="utf-8-sig")
    match = re.search(pattern, text)
    if not match:
        raise RuntimeError(f"No matching credential was found in {path.name}")
    return match.group(0)


def _webull_credentials() -> tuple[str, str]:
    text = (KEY_DIR / "Webull api.txt").read_text(encoding="utf-8-sig")
    values: dict[str, str] = {}
    for raw in text.splitlines():
        if ":" not in raw:
            continue
        label, value = raw.split(":", 1)
        normalized = re.sub(r"[^a-z]", "", label.lower())
        if normalized in {"appkey", "appsecret"}:
            values[normalized] = value.strip()
    app_key, app_secret = values.get("appkey", ""), values.get("appsecret", "")
    if len(app_key) != 35 or len(app_secret) != 32:
        raise RuntimeError("Webull credential labels exist but their expected lengths do not match")
    return app_key, app_secret


def _shape(value: Any) -> dict[str, Any]:
    """Return field names and benign timestamp/identifier samples, never headers/tokens."""
    result: dict[str, Any] = {"type": type(value).__name__}
    if isinstance(value, dict):
        keys = sorted(str(key) for key in value.keys())
        result["key_count"] = len(keys)
        result["keys"] = keys[:25]
        for key, item in value.items():
            lower = str(key).lower()
            if any(part in lower for part in ("time", "date", "symbol", "strike", "style", "type", "side")):
                if isinstance(item, (str, int, float, bool)) or item is None:
                    result.setdefault("samples", {})[str(key)] = item
        for key, item in value.items():
            if isinstance(item, list) and item:
                result["first_list_key"] = str(key)
                result["first_item"] = _shape(item[0])
                break
            if isinstance(item, dict) and item:
                result.setdefault("nested", {})[str(key)] = _shape(item)
                if len(result["nested"]) >= 2:
                    break
    elif isinstance(value, list):
        result["count"] = len(value)
        if value:
            result["first_item"] = _shape(value[0])
    return result


def _timed(name: str, call: Callable[[], Any]) -> tuple[dict[str, Any], Any]:
    started = time.perf_counter()
    try:
        response = call()
        latency_ms = round((time.perf_counter() - started) * 1000.0, 3)
        body = response.json() if getattr(response, "content", b"") else None
        return {
            "name": name,
            "ok": 200 <= response.status_code < 300,
            "status_code": response.status_code,
            "latency_ms": latency_ms,
            "rate_limit": {
                key: value
                for key, value in response.headers.items()
                if key.lower() in {"retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"}
            },
            "shape": _shape(body),
        }, body
    except Exception as exc:  # output only exception type, not possibly sensitive request text
        failure = {
            "name": name,
            "ok": False,
            "latency_ms": round((time.perf_counter() - started) * 1000.0, 3),
            "error_type": type(exc).__name__,
        }
        for source, target in (("error_code", "error_code"), ("http_status", "status_code")):
            value = getattr(exc, source, None)
            if isinstance(value, (str, int, float, bool)):
                failure[target] = value
        return failure, None


def _find_option_symbol(value: Any) -> str | None:
    if isinstance(value, dict):
        for key, item in value.items():
            if str(key).lower() in {"symbol", "option_symbol", "ticker"} and isinstance(item, str):
                if re.fullmatch(r"[A-Z]{1,6}\d{6}[CP]\d{8}", item):
                    return item
        for item in value.values():
            found = _find_option_symbol(item)
            if found:
                return found
    elif isinstance(value, list):
        for item in value:
            found = _find_option_symbol(item)
            if found:
                return found
    return None


def probe_webull() -> list[dict[str, Any]]:
    # The official SDK's default ERROR logger serializes signed request headers.
    # Disable all SDK logging before construction so credentials cannot reach logs.
    logging.disable(logging.CRITICAL)
    from webull.core.client import ApiClient
    from webull.core.request import ApiRequest
    from webull.data.common.category import Category
    from webull.data.data_client import DataClient

    app_key, app_secret = _webull_credentials()
    api_client = ApiClient(app_key, app_secret, "us")
    api_client._stream_logger_set = True
    api_client._file_logger_set = True
    client = DataClient(api_client)
    output: list[dict[str, Any]] = []

    def current_depth(symbol: str, depth: int):
        request = ApiRequest(
            "/market-data/stocks/depths/list", version="v3", method="GET",
            query_params={"symbol": symbol, "category": Category.US_ETF.name, "depth": depth, "overnight_required": "false"},
        )
        return api_client.get_response(request)

    option_symbols: dict[str, str] = {}
    for name, call in (
        ("stock_instruments", lambda: client.instrument.get_instrument("SPY,QQQ", Category.US_STOCK.name)),
        ("stock_snapshot", lambda: client.market_data.get_snapshot("SPY,QQQ", Category.US_ETF.name, True, False)),
        ("spy_nasdaq_depth", lambda: current_depth("SPY", 10)),
        ("qqq_nasdaq_depth", lambda: current_depth("QQQ", 10)),
        ("spy_l1_depth", lambda: current_depth("SPY", 1)),
        ("qqq_l1_depth", lambda: current_depth("QQQ", 1)),
        ("spy_option_contracts", lambda: client.instrument.get_option_contracts(Category.US_OPTION.name, "SPY", page_size=20)),
        ("qqq_option_contracts", lambda: client.instrument.get_option_contracts(Category.US_OPTION.name, "QQQ", page_size=20)),
    ):
        summary, body = _timed(name, call)
        output.append(summary)
        if name.endswith("option_contracts"):
            option_symbol = _find_option_symbol(body)
            if option_symbol:
                option_symbols[name.split("_", 1)[0]] = option_symbol
    for symbol, option_symbol in sorted(option_symbols.items()):
        snapshot, _ = _timed(
            f"{symbol}_option_snapshot",
            lambda value=option_symbol: client.option_market_data.get_option_snapshot(value, Category.US_OPTION.name),
        )
        output.append(snapshot)
    return output


def probe_quantdata() -> list[dict[str, Any]]:
    api_key = _token(KEY_DIR / "API-key - quant data.txt", r"qd_[A-Za-z0-9_-]{32}")
    session = requests.Session()
    session.headers.update({"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"})

    def call(path: str, payload: dict[str, Any]) -> requests.Response:
        return session.post(f"https://api.quantdata.us{path}", json=payload, timeout=20)

    output: list[dict[str, Any]] = []
    probes = (
        ("gex_by_strike", "/v1/options/tool/exposure-by-strike", {
            "greekMode": "GAMMA",
            "representationMode": "PER_ONE_PERCENT_MOVE",
            "filter": {"ticker": "SPY"},
        }),
        ("net_drift", "/v1/options/tool/net-drift", {"filter": {"ticker": "SPY"}}),
        ("gainers_losers", "/v1/options/tool/gainers-losers", {"filter": {"ticker": "SPY"}}),
        ("order_flow", "/v1/options/tool/order-flow/unconsolidated", {
            "filter": {"ticker": "SPY"},
            "size": 25,
            "sort": {"field": "tradeTime", "direction": "DESCENDING"},
        }),
        ("term_structure", "/v1/options/tool/term-structure", {"filter": {"ticker": "SPY"}}),
        ("volatility_skew", "/v1/options/tool/volatility-skew", {"filter": {"ticker": "SPY"}}),
        ("open_interest", "/v1/options/tool/open-interest-by-strike", {"filter": {"ticker": "SPY"}}),
        ("dex_by_strike", "/v1/options/tool/exposure-by-strike", {
            "greekMode": "DELTA", "representationMode": "PER_ONE_PERCENT_MOVE", "filter": {"ticker": "SPY"},
        }),
        ("vanna_by_strike", "/v1/options/tool/exposure-by-strike", {
            "greekMode": "VANNA", "representationMode": "PER_ONE_PERCENT_MOVE", "filter": {"ticker": "SPY"},
        }),
        ("charm_by_strike", "/v1/options/tool/exposure-by-strike", {
            "greekMode": "CHARM", "representationMode": "PER_ONE_PERCENT_MOVE", "filter": {"ticker": "SPY"},
        }),
    )
    for name, path, payload in probes:
        summary, _ = _timed(name, lambda p=path, body=payload: call(p, body))
        output.append(summary)
    return output


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", choices=("all", "webull", "quantdata"), default="all")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    report: dict[str, Any] = {"redaction": "credential values and authorization headers are never emitted"}
    for name, probe in (("webull", probe_webull), ("quantdata", probe_quantdata)):
        if args.provider not in {"all", name}:
            continue
        try:
            report[name] = probe()
        except Exception as exc:
            report[name] = {"ok": False, "error_type": type(exc).__name__}
    payload = json.dumps(report, indent=2, sort_keys=True)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(payload + "\n", encoding="utf-8")
    print(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
