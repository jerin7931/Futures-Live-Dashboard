from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest


REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "backend"))

from predictive_live.forward_store import AsyncPublishQueue
from predictive_live.signal_episodes import (SignalEpisodeBook, signal_creation_allowed,
                                              signal_identity)
from predictive_live.supabase_publish import PredictiveCurrentStatePublisher


CT = ZoneInfo("America/Chicago")


def _at(hour: int, minute: int, second: int = 0) -> datetime:
    return datetime(2026, 9, 10, hour, minute, second, tzinfo=CT).astimezone(timezone.utc)


def _decision(stamp: datetime, *, strike: float = 759, strength: float = .18,
              status: str = "LIVE", contract: str | None = None) -> dict:
    contract = contract or f"SPY260911P{int(strike * 1000):08d}"
    surface = {f"p{target}_{horizon}": max(.01, strength + (30-target)*.004 - (30-horizon)*.002)
               for horizon in (10, 20, 30) for target in (5, 10, 15, 20, 25, 30)}
    return {
        "model_id": "SPY_OPTIONS_ONLY", "model_version": "frozen-test", "symbol": "SPY",
        "setup_episode_id": "setup-1", "direction": "PUT", "grade": "B",
        "probability": strength, "grade_probability": strength,
        "guidance_state": "LIVE", "thesis_state": status,
        "candidate_contract": contract, "expiration": "2026-09-11", "strike": strike,
        "delta": -.65, "bid": 3.60, "ask": 3.68, "option_entry_price": 3.68,
        "option_entry_time": stamp.isoformat(), "current_option_return": 3.60 / 3.68 - 1,
        "model_event_time": stamp.isoformat(), "latest_quote_time": stamp.isoformat(),
        "selected_contract_event_time": stamp.isoformat(),
        "display_probability_surface": surface, "raw_probability_surface": surface,
        "raw_aim_for_by_horizon": {"10": .08, "20": .10, "30": .12},
        "aim_for_percent_by_horizon": {"10": 8, "20": 10, "30": 12},
        "invalid_if": "SPY accepts above qualified resistance", "invalidation_reason": None,
        "relative_spread": .02, "surface_contract": "DIRECT_TIME_CONDITIONED_MFE_SURFACE_V1",
        "probability_language": "historical proxy", "feature_hash": "abc",
    }


def test_creation_gate_is_exact_and_updates_are_not_frozen(tmp_path):
    assert signal_creation_allowed(_at(8, 29, 59))
    assert not signal_creation_allowed(_at(8, 30))
    assert not signal_creation_allowed(_at(8, 44, 59))
    assert signal_creation_allowed(_at(8, 45))
    book = SignalEpisodeBook(tmp_path / "signals.json")
    first, created = book.sync_decision(_decision(_at(8, 29, 59)), now=_at(8, 29, 59))
    assert created and first["status"] == "TRACKING"
    update = _decision(_at(8, 35), strength=.22)
    updated, created = book.sync_decision(update, now=_at(8, 35))
    assert not created and updated["id"] == first["id"]
    assert updated["model_strength_p30_30"] == pytest.approx(.22)
    blocked, created = book.sync_decision(_decision(_at(8, 35), strike=758), now=_at(8, 35))
    assert blocked is None and not created
    resumed, created = book.sync_decision(_decision(_at(8, 45), strike=758), now=_at(8, 45))
    assert created and resumed["id"] != first["id"]
    book.close()


def test_deterministic_key_updates_same_row_and_different_strike_never_overrides(tmp_path):
    book = SignalEpisodeBook(tmp_path / "signals.json")
    first, created = book.sync_decision(_decision(_at(9, 0), strike=759), now=_at(9, 0))
    same, same_created = book.sync_decision(_decision(_at(9, 1), strike=759, strength=.24), now=_at(9, 1))
    second, second_created = book.sync_decision(_decision(_at(9, 2), strike=758), now=_at(9, 2))
    key, row_id = signal_identity("SPY_OPTIONS_ONLY", "SPY", "2026-09-11", 759, "PUT")
    assert created and not same_created and second_created
    assert first["id"] == same["id"] == row_id and first["signal_key"] == key
    assert second["id"] != first["id"] and len(book.snapshot()) == 2
    book.close()


def test_terminal_rows_remain_visible_and_new_rows_are_added(tmp_path):
    book = SignalEpisodeBook(tmp_path / "signals.json")
    first, _ = book.sync_decision(_decision(_at(9, 0), strike=759), now=_at(9, 0))
    changed = book.invalidate_setup("SPY_OPTIONS_ONLY", "setup-1", "MODEL_REVERSAL_CONFIRMED", now=_at(9, 5))
    assert changed[0]["status"] == "INVALIDATED" and not changed[0]["active"]
    new_decision = _decision(_at(9, 6), strike=758)
    new_decision["setup_episode_id"] = "setup-2"
    second, created = book.sync_decision(new_decision, now=_at(9, 6))
    rows = {row["id"]: row for row in book.snapshot()}
    assert created and rows[first["id"]]["status"] == "INVALIDATED"
    assert rows[second["id"]]["status"] == "TRACKING" and len(rows) == 2
    book.close()


def test_quote_update_sets_target_hit_and_sweep_sets_expired(tmp_path):
    book = SignalEpisodeBook(tmp_path / "signals.json")
    target, _ = book.sync_decision(_decision(_at(9, 0), strike=759), now=_at(9, 0))
    hit = book.update_quote(target["contract"], bid=4.20, ask=4.22,
                            quote_time=_at(9, 5).isoformat(), now=_at(9, 5))[0]
    assert hit["status"] == "TARGET_HIT" and hit["current_return"] > .12
    expiring, _ = book.sync_decision(_decision(_at(9, 0), strike=758), now=_at(9, 0))
    expired = book.sweep(_at(9, 31))
    assert any(row["id"] == expiring["id"] and row["status"] == "EXPIRED" for row in expired)
    assert {row["status"] for row in book.snapshot()} == {"TARGET_HIT", "EXPIRED"}
    book.close()


def test_signal_state_is_persisted_and_restored(tmp_path):
    path = tmp_path / "signals.json"
    book = SignalEpisodeBook(path)
    row, _ = book.sync_decision(_decision(_at(9, 0)), now=_at(9, 0))
    book.close()
    restored = SignalEpisodeBook(path)
    assert restored.snapshot()[0]["id"] == row["id"]
    restored.close()


def test_signal_publisher_shape_and_priority_coalescing(monkeypatch, tmp_path):
    captured = []

    class Response:
        def __enter__(self): return self
        def __exit__(self, *_args): return False
        def read(self): return b""

    def fake_open(request, timeout):
        captured.append(json.loads(request.data)); return Response()

    monkeypatch.setattr("urllib.request.urlopen", fake_open)
    publisher = object.__new__(PredictiveCurrentStatePublisher)
    publisher.url = "https://example.invalid"; publisher.key = "backend-only"
    book = SignalEpisodeBook(tmp_path / "publisher.json")
    row, _ = book.sync_decision(_decision(_at(9, 0)), now=_at(9, 0))
    publisher("predictive_signal_episode_live", row)
    assert captured[0]["id"] == row["id"]
    assert captured[0]["details_payload"]["display_probability_surface"]
    assert AsyncPublishQueue._priority("predictive_signal_episode_live") == 0
    book.close()


def test_signal_episode_migration_is_owner_only_and_realtime_enabled():
    sql = (REPO / "supabase/migrations/20260910163000_predictive_signal_episode_live.sql").read_text()
    assert "predictive_signal_episode_live" in sql
    assert "enable row level security" in sql
    assert "dashboard_readers" in sql and "to authenticated" in sql
    assert "revoke all" in sql and "from anon, authenticated" in sql
    assert "alter publication supabase_realtime add table" in sql
    assert all(status in sql for status in ("TRACKING", "INVALIDATED", "TARGET_HIT", "EXPIRED"))


def test_frontend_multi_signal_realtime_sorting_and_details_contract():
    html = (REPO / "predictive/index.html").read_text(encoding="utf-8")
    js = (REPO / "predictive/predictive.js").read_text(encoding="utf-8")
    assert "signal-list" in html and "Signal lifecycle shown per row" in html
    assert "predictive_signal_episode_live" in js and "postgres_changes" in js
    assert "state.signals.set" in js and "signalSort" in js
    assert "statusRank={TRACKING:0,TARGET_HIT:1,INVALIDATED:2,EXPIRED:3}" in js
    assert "gradeRank={A:3,B:2,C:1}" in js
    assert "toggle-signal" in js and "More details" in js
    assert "signal-detail-surface" in js and "signal-aim" in js and "signal-invalid" in js
    assert "current-return" not in html  # lifecycle metrics are rendered per signal row, not per card
