from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


def load_project_env() -> Path | None:
    docs = Path.home() / "Documents"
    candidates = [
        docs / "Futures Dashboard V28" / "FUTURES_DASHBOARD_V28_PRODUCTION_COMPLETION_KIT" / "config" / "production.env",
        docs / "Futures Dashboard V28" / "FUTURES_DASHBOARD_V28_PRODUCTION_COMPLETION_KIT" / ".env",
        Path(__file__).resolve().parents[2] / ".env",
    ]
    for path in candidates:
        if not path.is_file():
            continue
        for raw in path.read_text(encoding="utf-8-sig").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            value = value.strip().strip("\"'")
            os.environ.setdefault(key.strip(), value)
        return path
    return None


class SupabasePublisher:
    """Backend-only REST publisher. Credentials never enter payloads or logs."""

    RETRYABLE_HTTP_STATUS = {408, 409, 503, 504}
    UPSERT_ATTEMPTS = 3
    RETRY_BASE_SECONDS = 0.25

    def __init__(self) -> None:
        load_project_env()
        self.url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        self.key = os.environ.get("SUPABASE_SECRET_KEY", "").strip() or os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        if not self.url or not self.key:
            raise RuntimeError("Supabase backend configuration is unavailable")

    def _send(self, request: urllib.request.Request, *, timeout: float,
              retry_transient: bool) -> None:
        attempts = self.UPSERT_ATTEMPTS if retry_transient else 1
        for attempt in range(attempts):
            try:
                with urllib.request.urlopen(request, timeout=timeout) as response:
                    response.read()
                return
            except urllib.error.HTTPError as exc:
                retryable = exc.code in self.RETRYABLE_HTTP_STATUS
                if not retryable or attempt + 1 >= attempts:
                    raise
            except (urllib.error.URLError, TimeoutError, OSError):
                if attempt + 1 >= attempts:
                    raise
            time.sleep(self.RETRY_BASE_SECONDS * (2 ** attempt))

    def upsert(self, table: str, rows: list[dict[str, Any]], on_conflict: str) -> float:
        if not rows:
            return 0.0
        query = urllib.parse.urlencode({"on_conflict": on_conflict})
        request = urllib.request.Request(
            f"{self.url}/rest/v1/{table}?{query}",
            data=json.dumps(rows, separators=(",", ":"), allow_nan=False).encode("utf-8"),
            headers={
                "apikey": self.key,
                "Authorization": "Bearer " + self.key,
                "Content-Type": "application/json",
                "Prefer": "resolution=merge-duplicates,return=minimal",
            },
            method="POST",
        )
        started = time.perf_counter()
        # Every upsert has an explicit conflict key, so replaying a transiently
        # failed POST is idempotent for these current-state tables.
        self._send(request, timeout=10, retry_transient=True)
        return (time.perf_counter() - started) * 1000.0

    def insert(self, table: str, rows: list[dict[str, Any]]) -> float:
        if not rows:
            return 0.0
        request = urllib.request.Request(
            f"{self.url}/rest/v1/{table}",
            data=json.dumps(rows, separators=(",", ":"), allow_nan=False).encode("utf-8"),
            headers={
                "apikey": self.key,
                "Authorization": "Bearer " + self.key,
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
            },
            method="POST",
        )
        started = time.perf_counter()
        # Append-only inserts are not retried: a lost response after a
        # successful server commit could otherwise create a duplicate row.
        self._send(request, timeout=10, retry_transient=False)
        return (time.perf_counter() - started) * 1000.0
