"""Local Predictive Live V1 entry point. No training code is imported."""

from __future__ import annotations

import argparse
import json
import os
import signal
import time
from pathlib import Path

from predictive_live.artifacts import FrozenModelFleet
from predictive_live.features import LiveFeatureEngine
from predictive_live.forward_store import AsyncForwardRecorder, AsyncPublishQueue
from predictive_live.mapping import TargetLadderMapping
from predictive_live.service import PredictiveLiveService
from predictive_live.supabase_publish import PredictiveCurrentStatePublisher
from predictive_live.runtime import PredictiveProviderRuntime


def build(config_path: Path) -> PredictiveLiveService:
    config = json.loads(config_path.read_text(encoding="utf-8"))
    root = Path(config["live_root"]).resolve()
    fleet = FrozenModelFleet(root / config["artifact_registry"])
    mapping = TargetLadderMapping(root / config["target_ladder_mapping"])
    recorder = AsyncForwardRecorder(root / "forward_data", int(config["forward_data"]["queue_capacity"]))
    publish = PredictiveCurrentStatePublisher() if config["publisher"]["enabled"] else None
    return PredictiveLiveService(fleet, mapping, LiveFeatureEngine(), recorder,
                                 AsyncPublishQueue(publish), config=config, live_root=root)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--run-providers", action="store_true")
    args = parser.parse_args()
    service = build(args.config.resolve())
    if args.verify_only:
        print(json.dumps(service.current_state(), indent=2)); service.recorder.close(); service.publisher.close(); return 0
    runtime = PredictiveProviderRuntime(service) if args.run_providers else None
    if runtime:
        runtime.start()
    stopping = False
    def stop(*_args: object) -> None:
        nonlocal stopping; stopping = True
    signal.signal(signal.SIGINT, stop); signal.signal(signal.SIGTERM, stop)
    while not stopping:
        time.sleep(0.25)
    if runtime:
        runtime.stop()
    service.recorder.close(); service.publisher.close()
    return 0


if __name__ == "__main__":
    os.environ.setdefault("OMP_NUM_THREADS", "1")
    os.environ.setdefault("MKL_NUM_THREADS", "1")
    os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
    raise SystemExit(main())
