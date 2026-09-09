"""Authorized non-trading Telegram smoke test. Real messages are prefixed TEST."""

from __future__ import annotations

import argparse
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from predictive_live.telegram import (AsyncTelegramNotifier, TelegramBotClient,
                                      load_telegram_credentials)


def payload(episode: str, *, thesis: str = "LIVE", guidance: str = "LIVE",
            reason: str | None = None) -> dict:
    surface = {f"p{target}_{horizon}": .46 - target / 200 + horizon / 500
               for target in (5, 10, 15, 20, 25, 30) for horizon in (10, 20, 30)}
    return {
        "model_id": "SPY_OPTIONS_PLUS_ES", "model_version": "SMOKE_ONLY",
        "symbol": "SPY", "setup_episode_id": episode, "direction": "CALL",
        "grade": "A", "guidance_state": guidance, "thesis_state": thesis,
        "candidate_contract": "TEST_SPY_1DTE_CALL", "strike": 742.0,
        "expiration": "TEST", "delta": .65, "bid": 2.10, "ask": 2.12,
        "display_probability_surface": surface,
        "aim_for_percent_by_horizon": {"10": 5, "20": 10, "30": 15},
        "invalid_if": "TEST only: SPY accepts below support",
        "invalidation_reason": reason,
        "model_event_time": datetime.now(timezone.utc).isoformat(),
        "latest_same_side_event_time": datetime.now(timezone.utc).isoformat(),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--credentials", type=Path, required=True)
    parser.add_argument("--state", type=Path, required=True)
    args = parser.parse_args()
    token, chat = load_telegram_credentials(args.credentials)
    notifier = AsyncTelegramNotifier(TelegramBotClient(token, chat), args.state,
                                     test_prefix="TEST", send_interval_seconds=1.1)
    episode = f"SMOKE-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    row = payload(episode)
    row["model_event_time"] = (datetime.now(timezone.utc) - timedelta(minutes=10, seconds=5)).isoformat()
    notifier.observe_decision(row, underlying=742.50)
    notifier.wait_idle(15)
    time.sleep(1.1)
    fresh = datetime.now(timezone.utc).isoformat()
    notifier.sweep(underlying_by_symbol={"SPY": 742.75},
                   quotes={row["candidate_contract"]: {"bid": 2.13, "quote_time": fresh}},
                   quote_stale_seconds=5, now=datetime.now(timezone.utc))
    notifier.wait_idle(15)
    time.sleep(1.1)
    notifier.observe_quote(row["candidate_contract"], bid=2.44,
                           quote_time=datetime.now(timezone.utc).isoformat(), quote_fresh=True,
                           underlying_by_symbol={"SPY": 743.25})
    notifier.wait_idle(15)
    time.sleep(1.1)
    warning = payload(episode, thesis="WARNING", reason="TEST_WARNING")
    notifier.observe_decision(warning, underlying=742.00)
    notifier.wait_idle(15)
    time.sleep(1.1)
    invalid = payload(episode, thesis="INVALIDATED", guidance="BLOCKED",
                      reason="TEST_MODEL_REVERSAL_CONFIRMED")
    notifier.observe_decision(invalid, underlying=741.50)
    notifier.wait_idle(15)
    time.sleep(1.1)
    notifier.observe_decision(payload(episode + "-NEW"), underlying=741.75)
    notifier.wait_idle(15)
    health = notifier.health(); notifier.close()
    if health["status"] != "LIVE":
        raise RuntimeError("Telegram smoke delivery did not remain healthy")
    print(f"PASS messages={health['sent']} episode={episode} threaded=true non_trading=true")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
