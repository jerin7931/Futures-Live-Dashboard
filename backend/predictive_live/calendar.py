"""Versioned NYSE regular-session calendar used by the live inference gate.

This module intentionally has no weekday-only fallback.  It encodes the NYSE
holiday and scheduled early-close rules used by the approved research and
fails closed outside its explicit supported year range.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo


ET = ZoneInfo("America/New_York")
SUPPORTED_YEARS = range(2025, 2031)


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    value = date(year, month, 1)
    value += timedelta(days=(weekday - value.weekday()) % 7 + 7 * (n - 1))
    return value


def _last_weekday(year: int, month: int, weekday: int) -> date:
    value = date(year + (month == 12), 1 if month == 12 else month + 1, 1) - timedelta(days=1)
    return value - timedelta(days=(value.weekday() - weekday) % 7)


def _easter(year: int) -> date:
    # Anonymous Gregorian algorithm.
    a = year % 19; b = year // 100; c = year % 100; d = b // 4; e = b % 4
    f = (b + 8) // 25; g = (b - f + 1) // 3; h = (19 * a + b - d - g + 15) % 30
    i = c // 4; k = c % 4; l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    return date(year, month, (h + l - 7 * m + 114) % 31 + 1)


def _observed(value: date, *, saturday_previous: bool = True) -> date:
    if value.weekday() == 5 and saturday_previous:
        return value - timedelta(days=1)
    if value.weekday() == 6:
        return value + timedelta(days=1)
    return value


def _closed_dates(year: int) -> set[date]:
    new_year = date(year, 1, 1)
    closed = {
        _observed(new_year, saturday_previous=False),
        _nth_weekday(year, 1, 0, 3),
        _nth_weekday(year, 2, 0, 3),
        _easter(year) - timedelta(days=2),
        _last_weekday(year, 5, 0),
        _observed(date(year, 6, 19)),
        _observed(date(year, 7, 4)),
        _nth_weekday(year, 9, 0, 1),
        _nth_weekday(year, 11, 3, 4),
        _observed(date(year, 12, 25)),
    }
    return closed


def _early_close_dates(year: int) -> set[date]:
    thanksgiving = _nth_weekday(year, 11, 3, 4)
    candidates = {thanksgiving + timedelta(days=1), date(year, 12, 24), date(year, 7, 3)}
    closed = _closed_dates(year)
    return {value for value in candidates if value.weekday() < 5 and value not in closed}


@dataclass(frozen=True)
class SessionBounds:
    session_date: str
    open_utc: datetime
    close_utc: datetime
    early_close: bool

    @property
    def last_actionable_y30_utc(self) -> datetime:
        return self.close_utc - timedelta(minutes=30)


class ExchangeSessionCalendar:
    VERSION = "NYSE_RTH_RULES_2025_2030_V1"

    def session(self, day: date) -> SessionBounds | None:
        if day.year not in SUPPORTED_YEARS:
            raise RuntimeError(f"Exchange calendar has no approved schedule for {day.year}")
        if day.weekday() >= 5 or day in _closed_dates(day.year):
            return None
        early = day in _early_close_dates(day.year)
        opened = datetime.combine(day, time(9, 30), ET).astimezone(timezone.utc)
        closed = datetime.combine(day, time(13 if early else 16, 0), ET).astimezone(timezone.utc)
        return SessionBounds(day.isoformat(), opened, closed, early)

    def for_timestamp(self, timestamp: datetime) -> SessionBounds | None:
        stamp = timestamp.astimezone(ET)
        return self.session(stamp.date())

    def next_session(self, day: date) -> SessionBounds:
        value = day + timedelta(days=1)
        for _ in range(10):
            bounds = self.session(value)
            if bounds is not None:
                return bounds
            value += timedelta(days=1)
        raise RuntimeError(f"No next exchange session found after {day}")

    def market_state(self, timestamp: datetime) -> dict[str, object]:
        bounds = self.for_timestamp(timestamp)
        open_now = bool(bounds and bounds.open_utc <= timestamp.astimezone(timezone.utc) < bounds.close_utc)
        return {
            "state": "OPEN" if open_now else "CLOSED",
            "session_date": bounds.session_date if bounds else timestamp.astimezone(ET).date().isoformat(),
            "session_open": bounds.open_utc.isoformat() if bounds else None,
            "session_close": bounds.close_utc.isoformat() if bounds else None,
            "early_close": bounds.early_close if bounds else False,
            "calendar_version": self.VERSION,
        }

    def actionable_y30(self, event_ms: int) -> tuple[bool, str, SessionBounds | None]:
        stamp = datetime.fromtimestamp(event_ms / 1000, timezone.utc)
        bounds = self.for_timestamp(stamp)
        if bounds is None:
            return False, "MARKET_SESSION_CLOSED", None
        if stamp < bounds.open_utc or stamp >= bounds.close_utc:
            return False, "OUTSIDE_RTH", bounds
        if stamp > bounds.last_actionable_y30_utc:
            return False, "INSUFFICIENT_RTH_Y30_HORIZON", bounds
        return True, "OK", bounds

    def expiration_close(self, expiration: str) -> datetime:
        bounds = self.session(date.fromisoformat(expiration))
        if bounds is None:
            raise RuntimeError(f"Expiration is not an exchange session: {expiration}")
        return bounds.close_utc
