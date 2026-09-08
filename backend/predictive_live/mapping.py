"""Versioned model-score to historical proxy MFE mapping."""

from __future__ import annotations

import json
from pathlib import Path

from .policies import TARGETS, validate_ladder


class TargetLadderMapping:
    def __init__(self, path: Path):
        payload = json.loads(path.read_text(encoding="utf-8"))
        self.version = payload["mapping_version"]
        self.language = payload["probability_language"]
        self.source_sha256 = payload["source_sha256"]
        self._models = payload["models"]

    @staticmethod
    def _band(probability: float) -> str:
        if probability < 0.05:
            return "<5%"
        if probability < 0.10:
            return "5% to <10%"
        if probability < 0.15:
            return "10% to <15%"
        if probability < 0.20:
            return "15% to <20%"
        if probability < 0.25:
            return "20% to <25%"
        return ">=25%"

    def lookup(self, model_id: str, probability: float) -> dict[float, float]:
        band = self._band(probability)
        source = self._models[model_id][band]
        ladder = {float(target): float(source[f"p_ge_{int(float(target) * 100)}"]) for target in TARGETS}
        validate_ladder(ladder)
        return ladder

    def metadata(self, model_id: str, probability: float) -> dict[str, object]:
        band = self._band(probability)
        row = self._models[model_id][band]
        return {"score_band": band, "candidate_rows": row["candidate_rows"], "effective_n": row["effective_n"]}
