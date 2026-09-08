"""Versioned provider-health identifiers shared by the live transport contract."""

from __future__ import annotations

import json
from pathlib import Path


PROVIDER_HEALTH_CONTRACT_PATH = (
    Path(__file__).resolve().parents[2]
    / "config"
    / "predictive_live"
    / "provider_health_contract_v1.json"
)


def _load_provider_ids() -> tuple[str, ...]:
    payload = json.loads(PROVIDER_HEALTH_CONTRACT_PATH.read_text(encoding="utf-8"))
    if payload.get("schema_version") != "PREDICTIVE_PROVIDER_HEALTH_V1":
        raise RuntimeError("Unsupported predictive provider-health contract")
    provider_ids = tuple(str(value) for value in payload.get("provider_ids", ()))
    if not provider_ids or len(provider_ids) != len(set(provider_ids)):
        raise RuntimeError("Predictive provider-health identifiers are empty or duplicated")
    return provider_ids


PROVIDER_HEALTH_IDS = _load_provider_ids()
PROVIDER_HEALTH_ID_SET = frozenset(PROVIDER_HEALTH_IDS)
