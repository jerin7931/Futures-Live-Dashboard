from __future__ import annotations

import json
import os
import threading
import urllib.request
from typing import Any

from .math_utils import stable_hash


class OllamaExplanationCache:
    """Narrative-only worker; its output is never passed back to the engine."""

    def __init__(self) -> None:
        self.enabled = os.environ.get("OLLAMA_EXPLAIN", "0").lower() in {"1", "true", "on"}
        self.url = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
        self.model = os.environ.get("OLLAMA_MODEL", "qwen2.5:0.5b")
        self.cache: dict[str, str] = {}
        self.running: set[str] = set()

    @staticmethod
    def key(signal: dict[str, Any]) -> str:
        return stable_hash({
            "as_of": signal.get("as_of"),
            "market_key": signal.get("market_key"),
            "state": signal.get("display_state"),
            "directional_core": signal.get("directional_core"),
            "option": signal.get("option"),
            "reason_codes": signal.get("reason_codes"),
        })

    def submit(self, signal: dict[str, Any]) -> str | None:
        key = self.key(signal)
        if not self.enabled or key in self.cache or key in self.running:
            return self.cache.get(key)
        self.running.add(key)
        threading.Thread(target=self._run, args=(key, signal), daemon=True, name="v2-ollama-explain").start()
        return None

    def get(self, signal: dict[str, Any]) -> str | None:
        return self.cache.get(self.key(signal))

    def _run(self, key: str, signal: dict[str, Any]) -> None:
        compact = {name: signal.get(name) for name in (
            "display_state", "direction", "setup_type", "directional_core", "flow_persistence",
            "path_clearance", "primary_reason", "reason_codes", "option",
        )}
        prompt = (
            "Explain this already-computed deterministic paper-trading state in at most two sentences. "
            "Do not change the decision or contract, introduce a probability, or imply guaranteed profit. "
            "The +30% objective is conditional.\n" + json.dumps(compact, separators=(",", ":"))
        )
        payload = json.dumps({
            "model": self.model,
            "stream": False,
            "think": False,
            "messages": [{"role": "user", "content": prompt}],
            "options": {"temperature": 0, "num_predict": 100},
        }).encode("utf-8")
        try:
            request = urllib.request.Request(self.url + "/api/chat", data=payload, headers={"Content-Type": "application/json"}, method="POST")
            with urllib.request.urlopen(request, timeout=15) as response:
                body = json.loads(response.read().decode("utf-8"))
            text = " ".join(str(body.get("message", {}).get("content") or "").split())
            if text:
                self.cache[key] = text
        except Exception:
            pass
        finally:
            self.running.discard(key)
