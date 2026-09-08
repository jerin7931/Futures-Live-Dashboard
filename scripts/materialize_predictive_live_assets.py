"""Materialize immutable production assets from approved research artifacts.

This script copies and verifies only. It contains no model fitting or tuning path.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path


MODEL_LAYOUT = {
    "SPY_OPTIONS_ONLY": {
        "symbol": "SPY", "futures_source": None, "model_kind": "xgboost",
        "manifest": "SPY_1DTE_OPTIONS_MODEL_V2_PREFINAL_FREEZE_MANIFEST.json",
        "source_dir": "SPY_1DTE_OPTIONS_MODEL_V2_PREFINAL", "destination": "SPY_OPTIONS_ONLY",
        "model_name": "model.json", "preprocessor_name": "preprocessor.joblib.gz", "calibrator_name": None,
    },
    "SPY_OPTIONS_PLUS_ES": {
        "symbol": "SPY", "futures_source": "ES", "model_kind": "xgboost",
        "manifest": "SPY_1DTE_OPTIONS_ES_FIXED_MODEL_V1_PREFINAL_FREEZE_MANIFEST.json",
        "source_dir": "SPY_1DTE_OPTIONS_ES_FIXED_MODEL_V1_PREFINAL", "destination": "SPY_OPTIONS_PLUS_ES",
        "model_name": "model.json", "preprocessor_name": "preprocessor.joblib.gz", "calibrator_name": None,
    },
    "QQQ_OPTIONS_ONLY": {
        "symbol": "QQQ", "futures_source": None, "model_kind": "sklearn_pipeline",
        "manifest": "QQQ_1DTE_OPTIONS_MODEL_V2_PREFINAL_FREEZE_MANIFEST.json",
        "source_dir": "QQQ_1DTE_OPTIONS_MODEL_V2_PREFINAL", "destination": "QQQ_OPTIONS_ONLY",
        "model_name": "model.joblib.gz", "preprocessor_name": None, "calibrator_name": "calibrator.joblib.gz",
    },
    "QQQ_OPTIONS_PLUS_NQ": {
        "symbol": "QQQ", "futures_source": "NQ", "model_kind": "sklearn_pipeline",
        "manifest": "QQQ_1DTE_OPTIONS_NQ_FIXED_MODEL_V1_PREFINAL_FREEZE_MANIFEST.json",
        "source_dir": "QQQ_1DTE_OPTIONS_NQ_FIXED_MODEL_V1_PREFINAL", "destination": "QQQ_OPTIONS_PLUS_NQ",
        "model_name": "model.joblib.gz", "preprocessor_name": None, "calibrator_name": "calibrator.joblib.gz",
    },
}

BANDS = ("<5%", "5% to <10%", "10% to <15%", "15% to <20%", "20% to <25%", ">=25%")
TARGETS = (5, 10, 15, 20, 25, 30)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def copy_verified(source: Path, destination: Path, expected: str) -> None:
    if not source.is_file() or sha256_file(source) != expected:
        raise RuntimeError(f"Source hash mismatch: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_file() and sha256_file(destination) == expected:
        return
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    shutil.copy2(source, temporary)
    if sha256_file(temporary) != expected:
        temporary.unlink(missing_ok=True)
        raise RuntimeError(f"Copied hash mismatch: {destination}")
    temporary.replace(destination)


def event_tape_features(research: Path) -> list[str]:
    source = research / "manifests" / "model_feature_allowlist_v2_quant.csv"
    with source.open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    return [row["feature_name"] for row in rows if row["model_enabled"].lower() == "true" and row["feature_group"] == "event_tape_baseline"]


def materialize_models(research: Path, live: Path) -> dict:
    common = event_tape_features(research)
    registry_rows = []
    for model_id, layout in MODEL_LAYOUT.items():
        manifest_source = research / "models" / layout["manifest"]
        manifest = json.loads(manifest_source.read_text(encoding="utf-8"))
        manifest_hash = sha256_file(manifest_source)
        manifest_destination = live / "models" / "manifests" / layout["manifest"]
        copy_verified(manifest_source, manifest_destination, manifest_hash)
        source_dir = research / "models" / layout["source_dir"]
        destination_dir = live / "models" / "frozen" / layout["destination"]
        model_source = source_dir / layout["model_name"]
        model_hash = manifest["artifact_sha256"]
        copy_verified(model_source, destination_dir / layout["model_name"], model_hash)

        preprocessor_hash = manifest.get("preprocessor_sha256") if layout["preprocessor_name"] else None
        if layout["preprocessor_name"]:
            copy_verified(source_dir / layout["preprocessor_name"], destination_dir / layout["preprocessor_name"], preprocessor_hash)
        calibrator_hash = manifest.get("calibrator_sha256") if layout["calibrator_name"] else None
        if layout["calibrator_name"]:
            copy_verified(source_dir / layout["calibrator_name"], destination_dir / layout["calibrator_name"], calibrator_hash)

        if model_id.endswith("OPTIONS_ONLY"):
            features = common
        else:
            features = [line.strip() for line in (source_dir / "features.txt").read_text(encoding="utf-8").splitlines() if line.strip()]
        feature_semantic_hash = hashlib.sha256("\n".join(features).encode("utf-8")).hexdigest()
        if model_id.endswith("OPTIONS_ONLY") and feature_semantic_hash != manifest["feature_list_sha256"]:
            raise RuntimeError(f"{model_id}: reconstructed feature-list hash mismatch")
        features_destination = destination_dir / "features.txt"
        features_destination.write_text("\n".join(features), encoding="utf-8")

        registry_rows.append({
            "model_id": model_id, "symbol": layout["symbol"], "futures_source": layout["futures_source"],
            "model_kind": layout["model_kind"],
            "model_path": (destination_dir / layout["model_name"]).relative_to(live).as_posix(),
            "preprocessor_path": (destination_dir / layout["preprocessor_name"]).relative_to(live).as_posix() if layout["preprocessor_name"] else None,
            "calibrator_path": (destination_dir / layout["calibrator_name"]).relative_to(live).as_posix() if layout["calibrator_name"] else None,
            "features_path": features_destination.relative_to(live).as_posix(),
            "model_sha256": model_hash, "preprocessor_sha256": preprocessor_hash,
            "calibrator_sha256": calibrator_hash, "features_sha256": feature_semantic_hash,
            "features_file_sha256": sha256_file(features_destination),
            "feature_count": len(features),
            "source_manifest_path": manifest_destination.relative_to(live).as_posix(),
            "source_manifest_sha256": manifest_hash,
            "target": "BASE_SYMMETRIC_SILVER_Y30",
            "probability_language": "P(proxy +30% event within 30m)",
        })
    payload = {"schema_version": 1, "live_root": str(live), "models": registry_rows}
    registry = live / "models" / "manifests" / "artifact_registry.json"
    registry.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return payload


def materialize_mapping(research: Path, live: Path) -> dict:
    source = research / "evaluation" / "target_ladder_supplemental" / "four_model_target_ladder_score_bands.csv"
    source_hash = sha256_file(source)
    raw_copy = live / "mappings" / "four_model_target_ladder_score_bands_RAW_APPROVED.csv"
    copy_verified(source, raw_copy, source_hash)
    with source.open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    output: dict[str, dict[str, dict[str, float | int]]] = {}
    for model_id in MODEL_LAYOUT:
        output[model_id] = {}
        for band in BANDS:
            selected = [row for row in rows if row["model_id"] == model_id and row["model_probability_band"] == band]
            by_target = {int(round(float(row["target_return"]) * 100)): row for row in selected}
            if set(by_target) != set(TARGETS):
                raise RuntimeError(f"Incomplete ladder: {model_id} {band}")
            values = [float(by_target[target]["ipcw_probability"]) for target in TARGETS]
            if any(left < right for left, right in zip(values, values[1:])):
                raise RuntimeError(f"Non-nested raw ladder: {model_id} {band}")
            output[model_id][band] = {
                **{f"p_ge_{target}": float(by_target[target]["ipcw_probability"]) for target in TARGETS},
                "candidate_rows": int(by_target[5]["candidate_rows"]),
                "effective_n": float(by_target[5]["effective_n"]),
                "probability_min": float(by_target[5]["probability_min"]),
                "probability_max": float(by_target[5]["probability_max"]),
            }
    payload = {
        "mapping_version": "TARGET_LADDER_IPCW_SCORE_BAND_V1",
        "source_path": str(source), "source_sha256": source_hash,
        "probability_language": "Historical proxy probability of observed option-bid MFE within 30 minutes",
        "smoothing": "NONE_RAW_IPCW_EMPIRICAL_SCORE_BANDS",
        "models": output,
    }
    path = live / "mappings" / "target_ladder_production_v1.json"
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return payload


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--research-root", type=Path, required=True)
    parser.add_argument("--live-root", type=Path, required=True)
    args = parser.parse_args()
    research, live = args.research_root.resolve(), args.live_root.resolve()
    models = materialize_models(research, live)
    mapping = materialize_mapping(research, live)
    for relative in ("manifests/modeling_environment.json", "requirements-modeling-lock.txt"):
        source = research / relative
        destination = live / "models" / "manifests" / Path(relative).name
        copy_verified(source, destination, sha256_file(source))
    now = datetime.now(timezone.utc).isoformat()
    state = {
        "project": "Tradytics Predictive Live Dashboard / Forward Validation V1",
        "phase": "LOCAL_PRECOMMIT_IMPLEMENTATION", "status": "IN_PROGRESS",
        "base_commit": "d5290dc947513c55229540566e19426045e82ac2",
        "feature_branch": "predictive-live-dashboard-v1", "production_changes_committed": False,
        "production_deployed": False, "supabase_migration_applied": False,
        "startup_persistence_changed": False, "model_count": len(models["models"]),
        "mapping_version": mapping["mapping_version"], "updated_at": now,
        "resume_next": "validate frozen fleet, implement/test local service and predictive dashboard",
    }
    (live / "state" / "research_state.json").write_text(json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"models": len(models["models"]), "mapping": mapping["mapping_version"], "live_root": str(live)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
