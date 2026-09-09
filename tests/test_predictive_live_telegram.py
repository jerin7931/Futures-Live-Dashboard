from __future__ import annotations

import json
import time
from datetime import datetime, timedelta, timezone

import pytest

from predictive_live.telegram import AsyncTelegramNotifier, load_telegram_credentials


class FakeSender:
    def __init__(self, fail: bool = False):
        self.messages = []
        self.fail = fail

    def send_message(self, text, *, reply_to=None):
        if self.fail:
            raise TimeoutError("injected")
        message_id = 1000 + len(self.messages)
        self.messages.append({"id": message_id, "text": text, "reply_to": reply_to})
        return message_id


def decision(*, episode="episode-1", thesis="LIVE", guidance="LIVE", reason=None):
    surface = {f"p{target}_{horizon}": .40 - target / 200 + horizon / 500
               for target in (5, 10, 15, 20, 25, 30) for horizon in (10, 20, 30)}
    return {
        "model_id": "SPY_OPTIONS_PLUS_ES", "model_version": "frozen", "symbol": "SPY",
        "setup_episode_id": episode, "direction": "CALL", "grade": "A",
        "guidance_state": guidance, "thesis_state": thesis,
        "candidate_contract": "SPY260910C00742000", "strike": 742.0,
        "expiration": "2026-09-10", "delta": .65, "bid": 2.10, "ask": 2.12,
        "display_probability_surface": surface,
        "aim_for_percent_by_horizon": {"10": 5, "20": 10, "30": 15},
        "invalid_if": "SPY accepts below 740.85 support",
        "invalidation_reason": reason,
        "model_event_time": datetime.now(timezone.utc).isoformat(),
        "latest_same_side_event_time": datetime.now(timezone.utc).isoformat(),
    }


def drain(notifier):
    while notifier.drain_once():
        pass


def test_option_a_root_includes_strike_surface_aims_and_setup_id(tmp_path):
    sender = FakeSender(); notifier = AsyncTelegramNotifier(sender, tmp_path / "state.json", autostart=False)
    notifier.observe_decision(decision(), underlying=742.50); drain(notifier)
    assert len(sender.messages) == 1 and sender.messages[0]["reply_to"] is None
    text = sender.messages[0]["text"]
    assert "SPY + ES · 742 CALL · GRADE A" in text
    assert all(token in text for token in ("SPY260910C00742000", "Delta 0.65", "Bid 2.10", "Ask 2.12",
                                           "+10%", "+20%", "+30%", "10m +5%", "20m +10%",
                                           "30m +15%", "episode-1", "INVALID IF", "CT "))


def test_extended_delta_candidate_receives_normal_root_alert(tmp_path):
    sender = FakeSender(); notifier = AsyncTelegramNotifier(sender, tmp_path / "state.json", autostart=False)
    row = decision(); row["delta"] = .52; row["candidate_delta_band"] = "EXTENDED_49_55"
    notifier.observe_decision(row, underlying=742.50); drain(notifier)
    assert len(sender.messages) == 1
    assert "Delta 0.52" in sender.messages[0]["text"]


def test_followups_reply_to_root_track_original_ask_and_do_not_invert_put(tmp_path):
    sender = FakeSender(); notifier = AsyncTelegramNotifier(sender, tmp_path / "state.json", autostart=False)
    row = decision(); row["direction"] = "PUT"
    notifier.observe_decision(row, underlying=742.50); drain(notifier)
    notifier.observe_quote(row["candidate_contract"], bid=2.44,
                           quote_time=datetime.now(timezone.utc).isoformat(), quote_fresh=True,
                           underlying_by_symbol={"SPY": 740.50}); drain(notifier)
    followups = sender.messages[1:]
    assert followups and all(message["reply_to"] == sender.messages[0]["id"] for message in followups)
    joined = "\n".join(message["text"] for message in followups)
    assert "SPY move -2.00" in joined and "return +15.1%" in joined
    assert sum("10m AIM" in row["text"] for row in followups) == 1
    assert sum("20m AIM" in row["text"] for row in followups) == 1
    assert sum("30m AIM" in row["text"] for row in followups) == 1


def test_warning_and_invalidation_are_threaded_once_and_close_episode(tmp_path):
    sender = FakeSender(); notifier = AsyncTelegramNotifier(sender, tmp_path / "state.json", autostart=False)
    notifier.observe_decision(decision(), underlying=742.0); drain(notifier)
    warning = decision(thesis="WARNING", reason="THESIS_WARNING")
    notifier.observe_decision(warning, underlying=741.5); notifier.observe_decision(warning, underlying=741.5)
    drain(notifier)
    invalid = decision(thesis="INVALIDATED", guidance="BLOCKED", reason="MODEL_REVERSAL_CONFIRMED")
    notifier.observe_decision(invalid, underlying=740.0); drain(notifier)
    notifier.observe_quote(invalid["candidate_contract"], bid=3.0,
                           quote_time=datetime.now(timezone.utc).isoformat(), quote_fresh=True,
                           underlying_by_symbol={"SPY": 739.0}); drain(notifier)
    assert sum("WARNING" in row["text"] for row in sender.messages) == 1
    assert sum("SETUP INVALIDATED" in row["text"] for row in sender.messages) == 1
    assert all(row["reply_to"] == sender.messages[0]["id"] for row in sender.messages[1:])
    assert notifier.episodes["SPY_OPTIONS_PLUS_ES"]["closed"] is True


def test_window_and_hold_are_once_and_stale_quote_is_suppressed(tmp_path):
    sender = FakeSender(); notifier = AsyncTelegramNotifier(sender, tmp_path / "state.json", autostart=False)
    row = decision(); start = datetime.now(timezone.utc) - timedelta(minutes=31)
    row["model_event_time"] = start.isoformat()
    notifier.observe_decision(row, underlying=742.0); drain(notifier)
    stale = (datetime.now(timezone.utc) - timedelta(seconds=10)).isoformat()
    quotes = {row["candidate_contract"]: {"bid": 2.20, "quote_time": stale}}
    notifier.sweep(underlying_by_symbol={"SPY": 743.0}, quotes=quotes,
                   quote_stale_seconds=5, now=datetime.now(timezone.utc)); drain(notifier)
    assert len(sender.messages) == 1
    fresh = datetime.now(timezone.utc).isoformat(); quotes[row["candidate_contract"]]["quote_time"] = fresh
    notifier.sweep(underlying_by_symbol={"SPY": 743.0}, quotes=quotes,
                   quote_stale_seconds=5, now=datetime.now(timezone.utc)); drain(notifier)
    notifier.sweep(underlying_by_symbol={"SPY": 743.0}, quotes=quotes,
                   quote_stale_seconds=5, now=datetime.now(timezone.utc)); drain(notifier)
    assert sum("30m WINDOW COMPLETE" in message["text"] for message in sender.messages) == 1


def test_optional_hold_heartbeats_are_limited_to_10m_and_20m(tmp_path):
    sender = FakeSender(); notifier = AsyncTelegramNotifier(sender, tmp_path / "state.json", autostart=False)
    row = decision(); start = datetime.now(timezone.utc) - timedelta(minutes=10, seconds=5)
    row["model_event_time"] = start.isoformat()
    notifier.observe_decision(row, underlying=742.0); drain(notifier)
    now = datetime.now(timezone.utc); quote = {"bid": 2.13, "quote_time": now.isoformat()}
    notifier.sweep(underlying_by_symbol={"SPY": 742.2}, quotes={row["candidate_contract"]: quote},
                   quote_stale_seconds=5, now=now); drain(notifier)
    later = now + timedelta(minutes=10); quote["quote_time"] = later.isoformat()
    notifier.sweep(underlying_by_symbol={"SPY": 742.3}, quotes={row["candidate_contract"]: quote},
                   quote_stale_seconds=5, now=later); drain(notifier)
    notifier.sweep(underlying_by_symbol={"SPY": 742.3}, quotes={row["candidate_contract"]: quote},
                   quote_stale_seconds=5, now=later); drain(notifier)
    assert sum("10m UPDATE" in message["text"] for message in sender.messages) == 1
    assert sum("20m UPDATE" in message["text"] for message in sender.messages) == 1


def test_restart_does_not_resend_root_or_milestones(tmp_path):
    state = tmp_path / "state.json"; sender = FakeSender()
    first = AsyncTelegramNotifier(sender, state, autostart=False)
    row = decision(); first.observe_decision(row, underlying=742.0); drain(first)
    first.observe_quote(row["candidate_contract"], bid=2.35,
                        quote_time=datetime.now(timezone.utc).isoformat(), quote_fresh=True,
                        underlying_by_symbol={"SPY": 743.0}); drain(first)
    count = len(sender.messages)
    second = AsyncTelegramNotifier(sender, state, autostart=False)
    second.observe_decision(row, underlying=742.0)
    second.observe_quote(row["candidate_contract"], bid=2.35,
                         quote_time=datetime.now(timezone.utc).isoformat(), quote_fresh=True,
                         underlying_by_symbol={"SPY": 743.0}); drain(second)
    assert len(sender.messages) == count
    persisted = json.loads(state.read_text())
    assert "bot_token" not in json.dumps(persisted).lower() and "chat_id" not in json.dumps(persisted).lower()


def test_new_episode_creates_new_root_and_outage_never_blocks_caller(tmp_path):
    sender = FakeSender(); notifier = AsyncTelegramNotifier(sender, tmp_path / "state.json", autostart=False)
    notifier.observe_decision(decision(), underlying=742.0); drain(notifier)
    notifier.observe_decision(decision(episode="episode-2"), underlying=743.0); drain(notifier)
    assert len(sender.messages) == 2 and all(row["reply_to"] is None for row in sender.messages)
    broken = AsyncTelegramNotifier(FakeSender(fail=True), tmp_path / "broken.json", autostart=False)
    started = time.perf_counter(); broken.observe_decision(decision(), underlying=742.0)
    assert (time.perf_counter() - started) < .05
    drain(broken)
    assert broken.health()["status"] == "DEGRADED"


def test_selected_contract_change_gets_new_root_and_followups_use_new_entry(tmp_path):
    sender = FakeSender(); notifier = AsyncTelegramNotifier(sender, tmp_path / "state.json", autostart=False)
    old = decision(); old["candidate_contract"] = "SPY260910P00764000"
    old["strike"] = 764.0; old["direction"] = "PUT"; old["ask"] = 2.54
    notifier.observe_decision(old, underlying=763.0); drain(notifier)

    new = decision(); new["candidate_contract"] = "SPY260910P00765000"
    new["strike"] = 765.0; new["direction"] = "PUT"; new["ask"] = 3.06
    new["model_event_time"] = (datetime.now(timezone.utc) + timedelta(minutes=1)).isoformat()
    notifier.observe_decision(new, underlying=763.0); drain(notifier)

    assert len(sender.messages) == 2
    assert all(message["reply_to"] is None for message in sender.messages)
    assert "764 PUT" in sender.messages[0]["text"]
    assert "765 PUT" in sender.messages[1]["text"]

    notifier.observe_quote(new["candidate_contract"], bid=3.30,
                           quote_time=datetime.now(timezone.utc).isoformat(), quote_fresh=True,
                           underlying_by_symbol={"SPY": 762.5}); drain(notifier)
    followups = sender.messages[2:]
    assert followups and all(message["reply_to"] == sender.messages[1]["id"] for message in followups)
    assert all("return +7.8%" in message["text"] for message in followups)


def test_queued_followup_for_replaced_contract_is_discarded(tmp_path):
    sender = FakeSender(); notifier = AsyncTelegramNotifier(sender, tmp_path / "state.json", autostart=False)
    old = decision(); old["candidate_contract"] = "SPY260910P00764000"; old["strike"] = 764.0
    notifier.observe_decision(old, underlying=763.0); drain(notifier)
    notifier.observe_quote(old["candidate_contract"], bid=2.44,
                           quote_time=datetime.now(timezone.utc).isoformat(), quote_fresh=True,
                           underlying_by_symbol={"SPY": 762.0})

    new = decision(); new["candidate_contract"] = "SPY260910P00765000"; new["strike"] = 765.0
    new["model_event_time"] = (datetime.now(timezone.utc) + timedelta(minutes=1)).isoformat()
    notifier.observe_decision(new, underlying=762.0); drain(notifier)

    assert not any(message["reply_to"] == sender.messages[0]["id"] for message in sender.messages[1:])
    assert any("765 CALL" in message["text"] and message["reply_to"] is None
               for message in sender.messages[1:])


def test_pinned_contract_and_external_credentials_contract(tmp_path):
    sender = FakeSender(); notifier = AsyncTelegramNotifier(sender, tmp_path / "state.json", autostart=False)
    row = decision(); notifier.observe_decision(row, underlying=742.0)
    assert notifier.pinned_contracts() == [row["candidate_contract"]]
    config = tmp_path / "telegram.json"
    config.write_text(json.dumps({"bot_token": "external-only", "chat_id": "destination"}))
    assert load_telegram_credentials(config) == ("external-only", "destination")
