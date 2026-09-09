"""Hash-verified, load-once access to the four frozen prediction artifacts."""

from __future__ import annotations

import gzip
import hashlib
import json
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd
import scipy.sparse as sp
import xgboost as xgb

# Importing this module makes the exact historical pickle module path available.
import run_options_model_evaluation  # noqa: F401

from .direct_mfe import (DirectMfePrediction, HORIZON_MINUTES, SharedCalibrator,
                         SURFACE_CONTRACT, TARGET_PCTS, aim_for_by_horizon,
                         project_surface, rounded_aim_for_by_horizon, surface_dict)


class ArtifactIntegrityError(RuntimeError):
    """A frozen artifact is absent, changed, or internally inconsistent."""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


@dataclass(frozen=True)
class ModelSpec:
    model_id: str
    symbol: str
    futures_source: str | None
    model_kind: str
    model_path: Path
    preprocessor_path: Path | None
    calibrator_path: Path | None
    features_path: Path
    model_sha256: str
    preprocessor_sha256: str | None
    calibrator_sha256: str | None
    features_sha256: str
    source_manifest_path: Path
    source_manifest_sha256: str
    target: str = "DIRECT_TIME_CONDITIONED_MFE"
    probability_language: str = "P(historical proxy observed-bid MFE >= target by horizon)"
    surface_contract: str = SURFACE_CONTRACT


class FrozenPredictor:
    """Immutable inference wrapper. Files are loaded once during construction."""

    def __init__(self, spec: ModelSpec):
        self.spec = spec
        self.features = tuple(
            line.strip() for line in spec.features_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        )
        feature_hash = hashlib.sha256("\n".join(self.features).encode("utf-8")).hexdigest()
        if feature_hash != spec.features_sha256:
            raise ArtifactIntegrityError(f"{spec.model_id}: feature-list hash mismatch")

        if spec.model_kind == "xgboost_direct_mfe":
            self.model: Any = xgb.Booster()
            self.model.load_model(spec.model_path)
            if spec.preprocessor_path is None:
                raise ArtifactIntegrityError(f"{spec.model_id}: preprocessor required")
            with gzip.open(spec.preprocessor_path, "rb") as handle:
                self.preprocessor = joblib.load(handle)
        else:
            raise ArtifactIntegrityError(f"{spec.model_id}: unsupported model kind")

        self.calibrator = None
        if spec.calibrator_path is not None:
            # The immutable research pickle records ``__main__.SharedCalibrator``.
            # Register only its inference-only compatibility class; no training
            # implementation exists in this production package.
            setattr(sys.modules["__main__"], "SharedCalibrator", SharedCalibrator)
            with gzip.open(spec.calibrator_path, "rb") as handle:
                self.calibrator = joblib.load(handle)
        self._prediction_count = 0
        self._lock = threading.Lock()

    @property
    def prediction_count(self) -> int:
        return self._prediction_count

    def predict_surface(self, values: dict[str, Any]) -> DirectMfePrediction:
        missing = [name for name in self.features if name not in values]
        if missing:
            raise ValueError(f"{self.spec.model_id}: missing allowlisted features: {missing[:8]}")
        frame = pd.DataFrame([{name: values[name] for name in self.features}], columns=self.features)
        with self._lock:
            base = sp.csr_matrix(self.preprocessor.transform(frame), dtype=np.float32)
            # One vectorized sparse assembly keeps the 18-query surface math
            # identical while avoiding 18 separate sparse concatenations.
            repeated = sp.vstack([base] * 18, format="csr")
            query = sp.csr_matrix(np.asarray([
                (target / 30.0, horizon / 30.0)
                for horizon in HORIZON_MINUTES for target in TARGET_PCTS
            ], dtype=np.float32))
            matrix = sp.hstack((repeated, query), format="csr")
            names = [str(value) for value in self.preprocessor.get_feature_names_out()]
            names += ["query_target_pct_scaled", "query_horizon_scaled"]
            uncalibrated = np.asarray(self.model.predict(xgb.DMatrix(matrix, feature_names=names)), dtype=float)
            calibrated = np.asarray(self.calibrator.predict(uncalibrated), dtype=float) if self.calibrator else uncalibrated
            display = project_surface(calibrated)
            self._prediction_count += 1
        if len(uncalibrated) != 18 or not np.isfinite(uncalibrated).all() or not np.isfinite(calibrated).all():
            raise RuntimeError(f"{self.spec.model_id}: invalid Direct-MFE surface")
        raw_surface = surface_dict(calibrated)
        display_surface = surface_dict(display)
        return DirectMfePrediction(
            uncalibrated_probability_surface=surface_dict(uncalibrated),
            raw_probability_surface=raw_surface,
            display_probability_surface=display_surface,
            raw_aim_for_by_horizon=aim_for_by_horizon(raw_surface, require_monotone=False),
            display_aim_for_percent_by_horizon=rounded_aim_for_by_horizon(display_surface),
        )


class FrozenModelFleet:
    """Singleton-like fleet with an immutable four-model registry."""

    REQUIRED_MODELS = {
        "SPY_OPTIONS_ONLY",
        "SPY_OPTIONS_PLUS_ES",
        "QQQ_OPTIONS_ONLY",
        "QQQ_OPTIONS_PLUS_NQ",
    }

    def __init__(self, registry_path: Path):
        registry_path = registry_path.resolve()
        payload = json.loads(registry_path.read_text(encoding="utf-8"))
        root = Path(payload["live_root"]).resolve()
        specs: dict[str, ModelSpec] = {}
        for row in payload["models"]:
            def p(key: str) -> Path | None:
                value = row.get(key)
                return root / value if value else None

            spec = ModelSpec(
                model_id=row["model_id"], symbol=row["symbol"], futures_source=row.get("futures_source"),
                model_kind=row["model_kind"], model_path=p("model_path"),
                preprocessor_path=p("preprocessor_path"), calibrator_path=p("calibrator_path"),
                features_path=p("features_path"), model_sha256=row["model_sha256"],
                preprocessor_sha256=row.get("preprocessor_sha256"),
                calibrator_sha256=row.get("calibrator_sha256"), features_sha256=row["features_sha256"],
                source_manifest_path=p("source_manifest_path"),
                source_manifest_sha256=row["source_manifest_sha256"],
                target=row.get("target", "DIRECT_TIME_CONDITIONED_MFE"),
                probability_language=row.get("probability_language", "P(historical proxy observed-bid MFE >= target by horizon)"),
                surface_contract=row.get("surface_contract", ""),
            )
            self._verify(spec)
            specs[spec.model_id] = spec
        if set(specs) != self.REQUIRED_MODELS:
            raise ArtifactIntegrityError("Registry must contain exactly the four approved models")
        if payload.get("contract") != "DIRECT_MFE_MODELS_FROZEN_V2":
            raise ArtifactIntegrityError("Registry is not the approved Direct-MFE V2 fleet")
        self._registry_path = registry_path
        self._registry_sha256 = sha256_file(registry_path)
        self._predictors = {model_id: FrozenPredictor(spec) for model_id, spec in specs.items()}
        self._versions = {model_id: spec.model_sha256[:12] for model_id, spec in specs.items()}

    @staticmethod
    def _verify(spec: ModelSpec) -> None:
        if spec.surface_contract != SURFACE_CONTRACT:
            raise ArtifactIntegrityError(f"{spec.model_id}: Direct-MFE surface contract mismatch")
        checks = [
            (spec.model_path, spec.model_sha256, "model"),
            (spec.features_path, None, "features-file"),
            (spec.source_manifest_path, spec.source_manifest_sha256, "source manifest"),
        ]
        if spec.preprocessor_path is not None:
            checks.append((spec.preprocessor_path, spec.preprocessor_sha256, "preprocessor"))
        if spec.calibrator_path is not None:
            checks.append((spec.calibrator_path, spec.calibrator_sha256, "calibrator"))
        for path, expected, label in checks:
            if path is None or not path.is_file():
                raise ArtifactIntegrityError(f"{spec.model_id}: missing {label}")
            if expected and sha256_file(path) != expected:
                raise ArtifactIntegrityError(f"{spec.model_id}: {label} hash mismatch")

    @property
    def model_ids(self) -> tuple[str, ...]:
        return tuple(sorted(self._predictors))

    @property
    def versions(self) -> dict[str, str]:
        return dict(self._versions)

    def features_for(self, model_id: str) -> tuple[str, ...]:
        return self._predictors[model_id].features

    def predict_surface(self, model_id: str, values: dict[str, Any]) -> DirectMfePrediction:
        return self._predictors[model_id].predict_surface(values)

    def predict(self, model_id: str, values: dict[str, Any]) -> float:
        """Compatibility score: displayed P(+30% by 30m), never a lookup."""
        return self.predict_surface(model_id, values).grade_probability

    def health(self) -> dict[str, Any]:
        return {
            "status": "VERIFIED",
            "registry_sha256": self._registry_sha256,
            "models": {
                model_id: {
                    "version": self._versions[model_id],
                    "prediction_count": predictor.prediction_count,
                }
                for model_id, predictor in self._predictors.items()
            },
        }
