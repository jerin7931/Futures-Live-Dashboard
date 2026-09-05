from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path
from typing import Any


DEFAULT_PATH = Path(__file__).resolve().parents[2] / "config" / "v2_engine.json"


def load_config(path: str | Path | None = None) -> dict[str, Any]:
    actual = Path(path) if path else DEFAULT_PATH
    data = json.loads(actual.read_text(encoding="utf-8"))
    if data.get("paper_trading_only") is not True or data.get("order_execution_enabled") is not False:
        raise ValueError("V2 requires paper_trading_only=true and order_execution_enabled=false")
    required = {"SPY_1DTE", "SPY_0DTE", "QQQ_1DTE", "QQQ_0DTE"}
    if set(data.get("markets", {})) != required:
        raise ValueError("V2 config must define exactly the four paper-decision markets")
    return data


def with_overrides(config: dict[str, Any], dotted: dict[str, Any]) -> dict[str, Any]:
    result = deepcopy(config)
    for path, value in dotted.items():
        cursor = result
        keys = path.split(".")
        for key in keys[:-1]:
            cursor = cursor[key]
        cursor[keys[-1]] = value
    return result
