"""Frozen Direct-MFE surface contract and deterministic display projection.

The functions in this module never estimate model parameters.  The two-axis
projection is the production transcription of the approved research PAVA
projection: target probabilities decrease with target size and increase with
the available horizon.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable

import numpy as np


TARGET_PCTS = (5, 10, 15, 20, 25, 30)
HORIZON_MINUTES = (10, 20, 30)
SURFACE_KEYS = tuple(f"p{target}_{horizon}" for horizon in HORIZON_MINUTES for target in TARGET_PCTS)
SURFACE_CONTRACT = "DIRECT_TIME_CONDITIONED_MFE_SURFACE_V1"


def _pava(values: Iterable[float], *, increasing: bool) -> np.ndarray:
    """Equal-weight pool-adjacent-violators projection without model fitting."""
    source = np.asarray(tuple(values), dtype=float)
    if source.ndim != 1 or not len(source) or not np.isfinite(source).all():
        raise ValueError("PAVA requires a finite one-dimensional vector")
    working = source if increasing else -source
    means: list[float] = []
    weights: list[int] = []
    for value in working:
        means.append(float(value)); weights.append(1)
        while len(means) >= 2 and means[-2] > means[-1]:
            weight = weights[-2] + weights[-1]
            mean = (means[-2] * weights[-2] + means[-1] * weights[-1]) / weight
            means[-2:] = [mean]; weights[-2:] = [weight]
    projected = np.concatenate([np.full(weight, mean) for mean, weight in zip(means, weights)])
    return projected if increasing else -projected


def project_surface(probabilities: Iterable[float]) -> np.ndarray:
    """Apply the approved alternating 2D monotone projection to 18 cells.

    Input/output order is horizon-major, then target-major: 10m P5..P30,
    followed by 20m and 30m.
    """
    grid = np.asarray(tuple(probabilities), dtype=float).reshape(len(HORIZON_MINUTES), len(TARGET_PCTS)).copy()
    if not np.isfinite(grid).all() or np.any((grid < 0) | (grid > 1)):
        raise ValueError("Direct-MFE probabilities must be finite and in [0, 1]")
    for _ in range(20):
        prior = grid.copy()
        for row in range(len(HORIZON_MINUTES)):
            grid[row, :] = _pava(grid[row, :], increasing=False)
        for column in range(len(TARGET_PCTS)):
            grid[:, column] = _pava(grid[:, column], increasing=True)
        if float(np.max(np.abs(grid - prior))) < 1e-12:
            break
    return np.clip(grid.reshape(-1), 0.0, 1.0)


def surface_dict(probabilities: Iterable[float]) -> dict[str, float]:
    values = tuple(float(value) for value in probabilities)
    if len(values) != len(SURFACE_KEYS):
        raise ValueError("Direct-MFE surface must contain exactly 18 cells")
    return dict(zip(SURFACE_KEYS, values))


def validate_surface(surface: dict[str, float], *, monotone: bool = False) -> None:
    if set(surface) != set(SURFACE_KEYS):
        raise ValueError("Direct-MFE surface keys do not match the frozen 6x3 grid")
    values = np.asarray([float(surface[key]) for key in SURFACE_KEYS]).reshape(3, 6)
    if not np.isfinite(values).all() or np.any((values < 0) | (values > 1)):
        raise ValueError("Direct-MFE surface contains an invalid probability")
    if monotone:
        if np.any(np.diff(values, axis=1) > 1e-12):
            raise ValueError("Target-axis monotonicity violated")
        if np.any(np.diff(values, axis=0) < -1e-12):
            raise ValueError("Horizon-axis monotonicity violated")


def aim_for_by_horizon(surface: dict[str, float], *, require_monotone: bool = True) -> dict[str, float]:
    validate_surface(surface, monotone=require_monotone)
    return {
        str(horizon): max(0.0, min(0.30, 0.05 * sum(float(surface[f"p{target}_{horizon}"]) for target in TARGET_PCTS)))
        for horizon in HORIZON_MINUTES
    }


def rounded_aim_for_by_horizon(surface: dict[str, float]) -> dict[str, int]:
    return {horizon: int(round(value * 100)) for horizon, value in aim_for_by_horizon(surface).items()}


class SharedCalibrator:
    """Inference-only compatibility class for the frozen research pickle.

    The research artifacts were serialized from ``__main__.SharedCalibrator``.
    Artifact loading registers this class under that historical path.  There is
    deliberately no training method in production.
    """

    method: str
    model: Any

    def predict(self, probability: Iterable[float]) -> np.ndarray:
        values = np.clip(np.asarray(tuple(probability), dtype=float), 1e-6, 1 - 1e-6)
        if self.method == "none":
            return values
        if self.method == "platt":
            logits = np.log(values / (1 - values)).reshape(-1, 1)
            return np.asarray(self.model.predict_proba(logits)[:, 1], dtype=float)
        if self.method == "isotonic":
            return np.asarray(self.model.predict(values), dtype=float)
        raise RuntimeError(f"Unsupported frozen calibration method: {self.method}")


@dataclass(frozen=True)
class DirectMfePrediction:
    uncalibrated_probability_surface: dict[str, float]
    raw_probability_surface: dict[str, float]
    display_probability_surface: dict[str, float]
    raw_aim_for_by_horizon: dict[str, float]
    display_aim_for_percent_by_horizon: dict[str, int]

    @property
    def grade_probability(self) -> float:
        return float(self.display_probability_surface["p30_30"])
