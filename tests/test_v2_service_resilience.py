from __future__ import annotations

import urllib.error

import pytest

from backend.tradytics_signal_service_v2 import V2Service
from backend.v2.supabase import SupabasePublisher


class _Response:
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return b""


def _service() -> V2Service:
    service = V2Service.__new__(V2Service)
    service.publish_failures = 0
    service.next_publish_attempt = 0.0
    service.last_publish_error = None
    service.shadow_failures = 0
    return service


def test_v2_publish_failure_is_contained_and_backed_off(capsys):
    service = _service()
    calls = []

    def fail(_signals):
        calls.append("publish")
        raise urllib.error.URLError("synthetic timeout")

    service.publish = fail
    assert service.publish_resilient([], now=10.0) is False
    assert service.publish_failures == 1
    assert service.next_publish_attempt == 11.0
    assert service.last_publish_error == "URLError"
    assert service.publish_resilient([], now=10.5) is False
    assert calls == ["publish"]
    assert "V2_PUBLISH_DEGRADED" in capsys.readouterr().err


def test_v2_publish_recovers_and_clears_degraded_state():
    service = _service()
    service.publish_failures = 2
    service.next_publish_attempt = 20.0
    service.last_publish_error = "URLError"
    service.publish = lambda _signals: None
    assert service.publish_resilient([], now=20.0) is True
    assert service.publish_failures == 0
    assert service.next_publish_attempt == 0.0
    assert service.last_publish_error is None


def test_shadow_transport_failure_cannot_stop_service_loop(capsys):
    service = _service()
    service.shadow_log = lambda *_args, **_kwargs: (_ for _ in ()).throw(TimeoutError())
    assert service.shadow_log_resilient([]) is False
    assert service.shadow_failures == 1
    assert "V2_SHADOW_LOG_DEGRADED" in capsys.readouterr().err


def test_supabase_current_state_upsert_retries_transient_network_error(monkeypatch):
    publisher = SupabasePublisher.__new__(SupabasePublisher)
    publisher.url = "https://example.invalid"
    publisher.key = "test-only"
    outcomes = [urllib.error.URLError("timeout"), TimeoutError(), _Response()]
    sleeps = []

    def open_once(*_args, **_kwargs):
        value = outcomes.pop(0)
        if isinstance(value, BaseException):
            raise value
        return value

    monkeypatch.setattr("backend.v2.supabase.urllib.request.urlopen", open_once)
    monkeypatch.setattr("backend.v2.supabase.time.sleep", sleeps.append)
    publisher.upsert("options_signal_v2_live", [{"market_key": "SPY_1DTE"}], "market_key")
    assert sleeps == [0.25, 0.5]
    assert outcomes == []


def test_supabase_append_insert_is_not_retried(monkeypatch):
    publisher = SupabasePublisher.__new__(SupabasePublisher)
    publisher.url = "https://example.invalid"
    publisher.key = "test-only"
    calls = []

    def fail(*_args, **_kwargs):
        calls.append(1)
        raise urllib.error.URLError("timeout")

    monkeypatch.setattr("backend.v2.supabase.urllib.request.urlopen", fail)
    with pytest.raises(urllib.error.URLError):
        publisher.insert("options_v2_shadow_log", [{"market_key": "SPY_1DTE"}])
    assert len(calls) == 1
