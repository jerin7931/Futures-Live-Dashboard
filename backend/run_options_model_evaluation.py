"""Compatibility shim for frozen research calibrators.

The joblib artifacts reference ``run_options_model_evaluation.Calibrator``.
Production exposes prediction only; no fitting or training API exists here.
"""

from __future__ import annotations

import numpy as np


class Calibrator:
    method: str
    model: object

    def predict(self, probability: np.ndarray) -> np.ndarray:
        values = np.clip(np.asarray(probability, dtype=float), 1e-6, 1 - 1e-6)
        if self.method == "platt":
            logits = np.log(values / (1 - values)).reshape(-1, 1)
            return self.model.predict_proba(logits)[:, 1]
        return np.asarray(self.model.predict(values), dtype=float)
