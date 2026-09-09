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
from predictive_live.service import PredictiveLiveService
from predictive_live.supabase_publish import PredictiveCurrentStatePublisher
from predictive_live.runtime import PredictiveProviderRuntime
from predictive_live.telegram import (AsyncTelegramNotifier, TelegramBotClient,
                                      load_telegram_credentials)


def build(config_path: Path) -> PredictiveLiveService:
    config = json.loads(config_path.read_text(encoding="utf-8"))
    root = Path(config["live_root"]).resolve()
    fleet = FrozenModelFleet(root / config["artifact_registry"])
    recorder = AsyncForwardRecorder(root / "forward_data", int(config["forward_data"]["queue_capacity"]))
    publish = PredictiveCurrentStatePublisher() if config["publisher"]["enabled"] else None
    telegram = None
    telegram_config = config.get("telegram", {})
    if telegram_config.get("enabled"):
        token, destination = load_telegram_credentials(Path(telegram_config["credentials_path"]))
        telegram = AsyncTelegramNotifier(
            TelegramBotClient(token, destination,
                              float(telegram_config.get("timeout_seconds", 8))),
            root / telegram_config.get("state_path", "state/telegram_options_dashboard_v1.json"),
            queue_capacity=int(telegram_config.get("queue_capacity", 256)),
            test_prefix=str(telegram_config.get("test_prefix") or ""),
            send_interval_seconds=float(telegram_config.get("send_interval_seconds", 1.1)),
        )
    return PredictiveLiveService(fleet, None, LiveFeatureEngine(), recorder,
                                 AsyncPublishQueue(publish), config=config, live_root=root,
                                 telegram=telegram)


def close(service: PredictiveLiveService) -> None:
    if service.telegram is not None:
        service.telegram.close()
    service.recorder.close()
    service.publisher.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--run-providers", action="store_true")
    args = parser.parse_args()
    service = build(args.config.resolve())
    if args.verify_only:
        print(json.dumps(service.current_state(), indent=2)); close(service); return 0
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
    close(service)
    return 0


if __name__ == "__main__":
    os.environ.setdefault("OMP_NUM_THREADS", "1")
    os.environ.setdefault("MKL_NUM_THREADS", "1")
    os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
    raise SystemExit(main())
