#!/usr/bin/env python3
"""Fetch bounded, sanitized Supabase rows for TVG2 and native-S/R audit evidence."""
from __future__ import annotations

import argparse
import csv
import json
import urllib.parse
import urllib.request
from pathlib import Path

SYMBOLS = ("SPX", "QQQ", "IWM", "SPY")


def fetch_all(base_url: str, secret: str, table: str, params: dict[str, str]) -> list[dict]:
    query = urllib.parse.urlencode(params, safe="(),.*:")
    rows: list[dict] = []
    start = 0
    while True:
        request = urllib.request.Request(
            f"{base_url.rstrip('/')}/rest/v1/{table}?{query}",
            headers={"apikey": secret, "Authorization": f"Bearer {secret}", "Range": f"{start}-{start + 999}"},
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            page = json.loads(response.read().decode("utf-8"))
        rows.extend(page)
        if len(page) < 1000:
            return rows
        start += 1000


def dynamic_sr(bars: list[dict]) -> tuple[float | None, float | None]:
    if not bars:
        return None, None
    highs = [float(row["high"]) for row in bars]
    lows = [float(row["low"]) for row in bars]
    close = float(bars[-1]["close"])
    pivot_highs: list[float] = []
    pivot_lows: list[float] = []
    for index in range(2, len(bars) - 2):
        if highs[index] == max(highs[index - 2 : index + 3]):
            pivot_highs.append(highs[index])
        if lows[index] == min(lows[index - 2 : index + 3]):
            pivot_lows.append(lows[index])
    supports = [value for value in pivot_lows if value <= close] or [min(lows)]
    resistances = [value for value in pivot_highs if value >= close] or [max(highs)]
    return max(supports), min(resistances)


def number(row: dict, *names: str):
    for name in names:
        if row.get(name) is not None:
            return float(row[name])
    return None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--credential", required=True)
    parser.add_argument("--owner-id", required=True)
    parser.add_argument("--session-date", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    credentials = json.loads(Path(args.credential).read_text(encoding="utf-8"))
    base_url, secret = credentials["supabase_url"], credentials["secret_key"]
    symbol_filter = "in.(" + ",".join(SYMBOLS) + ")"
    common = {"owner_id": f"eq.{args.owner_id}", "session_date": f"eq.{args.session_date}", "symbol": symbol_filter}
    gamma = fetch_all(base_url, secret, "fos_options_analysis_current", {**common, "select": "symbol,session_date,source_as_of,status,spot,payload", "order": "symbol.asc"})
    state = fetch_all(base_url, secret, "fos_lppc_state_current", {**common, "select": "symbol,session_date,lppc_as_of_1m,levels_as_of,updated_at,dynamic_support,dynamic_resistance,price", "order": "symbol.asc"})
    bars = fetch_all(base_url, secret, "fos_lppc_efficiency_current", {**common, "timeframe": "eq.M1", "select": "symbol,session_date,timeframe,observation_at,open,high,low,close", "order": "observation_at.asc"})
    sanitized = {"project_ref": "gbtjmhjhqhtnbswsylvd", "session_date": args.session_date, "symbols": list(SYMBOLS), "gamma": gamma, "state": state, "m1_bars": bars}
    (output / "live_supabase_rows_sanitized.json").write_text(json.dumps(sanitized, indent=2), encoding="utf-8")
    parity = []
    for symbol in SYMBOLS:
        current = next((row for row in state if row.get("symbol") == symbol), {})
        timestamp = current.get("levels_as_of") or current.get("lppc_as_of_1m") or current.get("updated_at")
        usable = [row for row in bars if row.get("symbol") == symbol and row.get("observation_at") and (not timestamp or row["observation_at"] <= timestamp)]
        pine_support, pine_resistance = dynamic_sr(usable)
        backend_support = number(current, "dynamic_support")
        backend_resistance = number(current, "dynamic_resistance")
        parity.append({
            "symbol": symbol,
            "timestamp": timestamp,
            "backend_support": backend_support,
            "pine_support": pine_support,
            "support_difference": None if backend_support is None or pine_support is None else pine_support - backend_support,
            "backend_resistance": backend_resistance,
            "pine_resistance": pine_resistance,
            "resistance_difference": None if backend_resistance is None or pine_resistance is None else pine_resistance - backend_resistance,
            "completed_m1_rows": len(usable),
        })
    (output / "sr_parity.json").write_text(json.dumps(parity, indent=2), encoding="utf-8")
    with (output / "sr_parity.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(parity[0]))
        writer.writeheader()
        writer.writerows(parity)
    inventory = {
        "gamma_rows": len(gamma),
        "state_rows": len(state),
        "m1_bar_rows": len(bars),
        "gamma_symbols": [row.get("symbol") for row in gamma],
        "state_symbols": [row.get("symbol") for row in state],
        "m1_by_symbol": {symbol: sum(row.get("symbol") == symbol for row in bars) for symbol in SYMBOLS},
        "m1_earliest": {symbol: min((row["observation_at"] for row in bars if row.get("symbol") == symbol), default=None) for symbol in SYMBOLS},
        "m1_latest": {symbol: max((row["observation_at"] for row in bars if row.get("symbol") == symbol), default=None) for symbol in SYMBOLS},
    }
    (output / "live_inventory.json").write_text(json.dumps(inventory, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
