"""Copy and hash-verify the approved Direct-MFE V2 artifacts for production.

This is a copy-only operation.  It never reads model labels, the locked
Aug-Sep reserve, or any training dataset, and contains no fitting path.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path


CLASSIFIER_SHA256 = "3d537d227ebd2198c99d230dff11b108f18e079570f759f07b2975ceada3296f"
SURFACE_CONTRACT = "DIRECT_TIME_CONDITIONED_MFE_SURFACE_V1"
MODEL_MAP = {
    "SPY_OPTIONS_ONLY": ("SPY_OPTIONS_ONLY", "SPY", None),
    "SPY_OPTIONS_PLUS_ES": ("SPY_ES", "SPY", "ES"),
    "QQQ_OPTIONS_ONLY": ("QQQ_OPTIONS_ONLY", "QQQ", None),
    "QQQ_OPTIONS_PLUS_NQ": ("QQQ_NQ", "QQQ", "NQ"),
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def copy_verified(source: Path, destination: Path, expected: str) -> None:
    if not source.is_file() or sha256_file(source) != expected:
        raise RuntimeError(f"Frozen source hash mismatch: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_file() and sha256_file(destination) == expected:
        return
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    shutil.copy2(source, temporary)
    if sha256_file(temporary) != expected:
        temporary.unlink(missing_ok=True)
        raise RuntimeError(f"Copied artifact hash mismatch: {destination}")
    temporary.replace(destination)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--study-root", required=True, type=Path)
    parser.add_argument("--research-root", required=True, type=Path)
    parser.add_argument("--live-root", required=True, type=Path)
    args = parser.parse_args()
    study = args.study_root.resolve(); research = args.research_root.resolve(); live = args.live_root.resolve()

    state = json.loads((study / "state/research_state.json").read_text(encoding="utf-8"))
    holdout = state["locked_corrected_holdout"]
    if holdout != {
        "start": "2026-08-17", "end": "2026-09-04", "status": "LOCKED_UNACCESSED",
        "feature_access_allowed": False, "target_access_allowed": False, "outcomes_inspected": False,
    }:
        raise PermissionError("Locked Direct-MFE holdout guard failed")
    fleet_freeze_path = study / "state/DIRECT_MFE_MODELS_FROZEN_V2.json"
    fleet_freeze = json.loads(fleet_freeze_path.read_text(encoding="utf-8"))
    if fleet_freeze.get("contract") != "DIRECT_MFE_MODELS_FROZEN_V2" or fleet_freeze.get("locked_holdout_accessed") is not False:
        raise RuntimeError("Approved Direct-MFE V2 freeze contract is unavailable")

    classifier_source = research / "src/trade_classification.py"
    if sha256_file(classifier_source) != CLASSIFIER_SHA256:
        raise RuntimeError("Canonical trade classifier hash mismatch")
    classifier_destination = live / "models/manifests/QUANT_TRADETYPE_COMPLEX_TIED_V1.py"
    copy_verified(classifier_source, classifier_destination, CLASSIFIER_SHA256)

    rows = []
    for production_id, (research_id, symbol, futures_source) in MODEL_MAP.items():
        source_dir = study / f"models/DIRECT_MFE_TIME_V1/{research_id}"
        source_manifest = source_dir / "FREEZE_MANIFEST.json"
        expected_manifest_hash = fleet_freeze["models"][research_id]["manifest_sha256"]
        if sha256_file(source_manifest) != expected_manifest_hash:
            raise RuntimeError(f"{research_id}: freeze-manifest hash mismatch")
        manifest = json.loads(source_manifest.read_text(encoding="utf-8"))
        if manifest["classifier_sha256"] != CLASSIFIER_SHA256:
            raise RuntimeError(f"{research_id}: classifier contract mismatch")
        if manifest["target_grid_pct"] != [5, 10, 15, 20, 25, 30] or manifest["horizon_grid_minutes"] != [10, 20, 30]:
            raise RuntimeError(f"{research_id}: Direct-MFE grid mismatch")

        destination_dir = live / f"models/frozen/{production_id}"
        manifest_destination = live / f"models/manifests/{production_id}_DIRECT_MFE_FREEZE_MANIFEST.json"
        copy_verified(source_manifest, manifest_destination, expected_manifest_hash)
        copied: dict[str, Path] = {}
        for name in ("model.json", "preprocessor.joblib.gz", "calibrator.joblib.gz"):
            expected = manifest["artifacts"][name]
            copied[name] = destination_dir / name
            copy_verified(source_dir / name, copied[name], expected)
        feature_source = source_dir / "features.txt"
        if sha256_file(feature_source) != manifest["feature_list_sha256"]:
            raise RuntimeError(f"{research_id}: feature-list artifact hash mismatch")
        feature_destination = destination_dir / "features.txt"
        copy_verified(feature_source, feature_destination, manifest["feature_list_sha256"])
        features = [line.strip() for line in feature_source.read_text(encoding="utf-8").splitlines() if line.strip()]
        semantic_hash = hashlib.sha256("\n".join(features).encode("utf-8")).hexdigest()
        expected_count = 167 + (79 if futures_source else 0)
        if len(features) != expected_count or len(set(features)) != expected_count:
            raise RuntimeError(f"{research_id}: unexpected frozen feature count")
        rows.append({
            "model_id": production_id, "research_model_id": research_id, "symbol": symbol,
            "futures_source": futures_source, "model_kind": "xgboost_direct_mfe",
            "model_path": copied["model.json"].relative_to(live).as_posix(),
            "preprocessor_path": copied["preprocessor.joblib.gz"].relative_to(live).as_posix(),
            "calibrator_path": copied["calibrator.joblib.gz"].relative_to(live).as_posix(),
            "features_path": feature_destination.relative_to(live).as_posix(),
            "model_sha256": manifest["artifacts"]["model.json"],
            "preprocessor_sha256": manifest["artifacts"]["preprocessor.joblib.gz"],
            "calibrator_sha256": manifest["artifacts"]["calibrator.joblib.gz"],
            "features_sha256": semantic_hash, "features_file_sha256": manifest["feature_list_sha256"],
            "feature_count": len(features),
            "source_manifest_path": manifest_destination.relative_to(live).as_posix(),
            "source_manifest_sha256": expected_manifest_hash,
            "target": "DIRECT_TIME_CONDITIONED_MFE", "surface_contract": SURFACE_CONTRACT,
            "target_grid_pct": manifest["target_grid_pct"], "horizon_grid_minutes": manifest["horizon_grid_minutes"],
            "calibration": manifest["calibration"],
            "probability_language": "P(historical proxy observed-bid MFE >= target by horizon)",
            "locked_2026_08_17_2026_09_04_accessed": False,
        })

    registry = {
        "schema_version": 2, "contract": "DIRECT_MFE_MODELS_FROZEN_V2",
        "surface_contract": SURFACE_CONTRACT, "live_root": str(live),
        "classifier_sha256": CLASSIFIER_SHA256,
        "source_fleet_freeze_path": str(fleet_freeze_path),
        "source_fleet_freeze_sha256": sha256_file(fleet_freeze_path),
        "locked_holdout": {**holdout}, "models": rows,
        "materialized_at": datetime.now(timezone.utc).isoformat(),
    }
    registry_path = live / "models/manifests/artifact_registry_direct_mfe_v2.json"
    registry_path.write_text(json.dumps(registry, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    implementation_state = {
        "project": "Options Dashboard - Direct Time-Conditioned MFE Production Integration V1",
        "phase": "LOCAL_PRECOMMIT_IMPLEMENTATION", "status": "IN_PROGRESS",
        "production_changes_committed": False, "production_deployed": False,
        "service_started": False, "startup_persistence_changed": False,
        "new_migration_applied": False, "zero_dte_collection_enabled": False,
        "frozen_fleet_contract": "DIRECT_MFE_MODELS_FROZEN_V2",
        "registry": str(registry_path), "registry_sha256": sha256_file(registry_path),
        "locked_holdout": {**holdout}, "updated_at": datetime.now(timezone.utc).isoformat(),
        "resume_next": "finish local Direct-MFE adapter, parity, UI, tests, and precommit package",
    }
    state_path = live / "state/options_dashboard_direct_mfe_precommit_state.json"
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps(implementation_state, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"models": len(rows), "registry": str(registry_path), "locked_holdout_accessed": False}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
