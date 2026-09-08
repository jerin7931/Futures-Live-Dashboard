"""Exact live form of the frozen cadence_60s candidate constructor."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .features import OptionPrint


@dataclass(frozen=True)
class PreparedCadenceCandidate:
    event: OptionPrint
    session_open_ms: int
    bucket: int
    bucket_start_ms: int
    snapshots: dict[str, dict[str, Any]]


class FrozenCandidateCadence:
    """One latest eligible event per symbol fixed-clock 60-second bucket.

    This deliberately mirrors research ``select_entries``: the key is the
    cadence bucket (not OSI), and a later tradeTime replaces the earlier row.
    Same-millisecond replacement follows the stable provider-id order used by
    the historical ``(tradeTime, id)`` sort. Feature snapshots are captured at
    event time and travel with the candidate, so later context cannot leak.
    """

    def __init__(self, cadence_seconds: int = 60) -> None:
        if cadence_seconds != 60:
            raise ValueError("Frozen production cadence is exactly 60 seconds")
        self.cadence_seconds = cadence_seconds
        self.pending: dict[str, PreparedCadenceCandidate] = {}

    def make(self, event: OptionPrint, session_open_ms: int,
             snapshots: dict[str, dict[str, Any]]) -> PreparedCadenceCandidate:
        width = self.cadence_seconds * 1000
        bucket = (event.event_time_ms - session_open_ms) // width
        return PreparedCadenceCandidate(event, session_open_ms, bucket,
                                        session_open_ms + bucket * width, snapshots)

    @staticmethod
    def _key(candidate: PreparedCadenceCandidate) -> tuple[int, str]:
        return candidate.event.event_time_ms, candidate.event.provider_id

    def observe(self, candidate: PreparedCadenceCandidate) -> list[PreparedCadenceCandidate]:
        symbol = candidate.event.symbol
        prior = self.pending.get(symbol)
        completed: list[PreparedCadenceCandidate] = []
        if prior is not None:
            if candidate.bucket < prior.bucket:
                raise ValueError("Non-increasing cadence bucket")
            if candidate.bucket > prior.bucket:
                completed.append(prior)
                self.pending[symbol] = candidate
            elif self._key(candidate) >= self._key(prior):
                self.pending[symbol] = candidate
        else:
            self.pending[symbol] = candidate
        return completed

    def flush_due(self, now_ms: int) -> list[PreparedCadenceCandidate]:
        completed: list[PreparedCadenceCandidate] = []
        width = self.cadence_seconds * 1000
        for symbol, candidate in tuple(self.pending.items()):
            if now_ms >= candidate.bucket_start_ms + width:
                completed.append(candidate)
                del self.pending[symbol]
        return sorted(completed, key=lambda item: (item.bucket_start_ms, item.event.symbol))

    def reset_symbol(self, symbol: str) -> None:
        self.pending.pop(symbol.upper(), None)
