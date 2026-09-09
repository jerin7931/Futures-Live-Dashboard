"""Current GEX surface with durable same-session RTH-open baseline."""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, time
from pathlib import Path
from zoneinfo import ZoneInfo

from .policies import gamma_regime


ET = ZoneInfo("America/New_York")


@dataclass
class GexSessionState:
    state_path: Path | None = None
    session_date: str | None = None
    baseline: dict[float, float] | None = None
    baseline_time: datetime | None = None
    current: dict[float, float] = field(default_factory=dict)
    current_time: datetime | None = None
    scope: str = "FULL_CHAIN"
    baseline_tolerance_minutes: int = 15

    def __post_init__(self) -> None:
        if not self.state_path or not self.state_path.is_file():
            return
        obj = json.loads(self.state_path.read_text(encoding="utf-8"))
        self.session_date = obj.get("session_date")
        self.scope = obj.get("scope", "FULL_CHAIN")
        values = obj.get("baseline")
        self.baseline = {float(key): float(value) for key, value in values.items()} if isinstance(values, dict) else None
        stamp = obj.get("baseline_time")
        self.baseline_time = datetime.fromisoformat(stamp) if stamp else None

    def _persist(self) -> None:
        if not self.state_path:
            return
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        obj = {
            "schema_version": 1, "session_date": self.session_date, "scope": self.scope,
            "baseline": self.baseline, "baseline_time": self.baseline_time.isoformat() if self.baseline_time else None,
        }
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=self.state_path.parent, delete=False) as handle:
            json.dump(obj, handle, indent=2, sort_keys=True); handle.write("\n")
            temporary = Path(handle.name)
        os.replace(temporary, self.state_path)

    def update(self, *, timestamp: datetime, signed_by_strike: dict[float, float], scope: str) -> dict[str, object]:
        stamp = timestamp.astimezone(ET)
        day = stamp.date().isoformat()
        if self.session_date != day or self.scope != scope:
            self.session_date = day; self.baseline = None; self.baseline_time = None
            self.scope = scope
            self._persist()
        self.current = {float(key): float(value) for key, value in signed_by_strike.items()}
        self.current_time = stamp; self.scope = scope
        open_time = datetime.combine(stamp.date(), time(9, 30), tzinfo=ET)
        delta_minutes = (stamp - open_time).total_seconds() / 60
        if self.baseline is None and 0 <= delta_minutes <= self.baseline_tolerance_minutes:
            self.baseline = dict(self.current); self.baseline_time = stamp; self._persist()
        common = set(self.current) & set(self.baseline or {})
        change = {strike: self.current[strike] - self.baseline[strike] for strike in sorted(common)}
        unmatched_current = sorted(set(self.current) - set(self.baseline or {})) if self.baseline is not None else []
        unmatched_baseline = sorted(set(self.baseline or {}) - set(self.current)) if self.baseline is not None else []
        return {
            "current": dict(self.current), "delta_from_rth_open": change,
            "unmatched_current_strikes": unmatched_current,
            "unmatched_baseline_strikes": unmatched_baseline,
            "baseline_time": self.baseline_time.isoformat() if self.baseline_time else None,
            "as_of": stamp.isoformat(), "scope": scope, "regime": gamma_regime(self.current, scope=scope),
        }
