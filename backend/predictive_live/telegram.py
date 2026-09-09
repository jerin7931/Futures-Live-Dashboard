"""Asynchronous Telegram mirror for Options Dashboard setup episodes.

This module contains presentation and delivery state only.  It never trains,
scores, selects a contract, grades a setup, or changes thesis state.
"""

from __future__ import annotations

import html
import json
import queue
import threading
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol
from zoneinfo import ZoneInfo


MODEL_NAMES = {
    "SPY_OPTIONS_ONLY": "SPY OPTIONS ONLY",
    "SPY_OPTIONS_PLUS_ES": "SPY + ES",
    "QQQ_OPTIONS_ONLY": "QQQ OPTIONS ONLY",
    "QQQ_OPTIONS_PLUS_NQ": "QQQ + NQ",
}
CT = ZoneInfo("America/Chicago")


class TelegramSender(Protocol):
    def send_message(self, text: str, *, reply_to: int | None = None) -> int: ...


class TelegramBotClient:
    """Minimal Bot API client which never logs credentials or response bodies."""

    def __init__(self, token: str, chat_id: str, timeout_seconds: float = 8.0) -> None:
        if not token or not chat_id:
            raise ValueError("Telegram token and destination are required")
        self._token = token
        self._chat_id = str(chat_id)
        self._timeout = float(timeout_seconds)

    def send_message(self, text: str, *, reply_to: int | None = None) -> int:
        data: dict[str, str] = {
            "chat_id": self._chat_id,
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": "true",
        }
        if reply_to is not None:
            data["reply_parameters"] = json.dumps({"message_id": int(reply_to)})
        request = urllib.request.Request(
            f"https://api.telegram.org/bot{self._token}/sendMessage",
            data=urllib.parse.urlencode(data).encode("utf-8"),
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except Exception as exc:
            raise RuntimeError(f"Telegram send failed: {type(exc).__name__}") from None
        message_id = payload.get("result", {}).get("message_id") if payload.get("ok") else None
        if not isinstance(message_id, int):
            raise RuntimeError("Telegram send failed: invalid Bot API acknowledgement")
        return message_id


def load_telegram_credentials(path: Path) -> tuple[str, str]:
    """Read the legacy external bot config without copying secrets into Git/state."""
    payload = json.loads(path.resolve().read_text(encoding="utf-8-sig"))
    token = payload.get("bot_token") or payload.get("token") or payload.get("telegram_bot_token")
    chat_id = payload.get("chat_id") or payload.get("destination") or payload.get("telegram_chat_id")
    if not token or not chat_id:
        raise ValueError("External Telegram configuration is missing token or destination")
    return str(token), str(chat_id)


@dataclass(order=True)
class TelegramEvent:
    priority: int
    sequence: int
    dedupe_key: str = field(compare=False)
    model_id: str = field(compare=False)
    episode_id: str = field(compare=False)
    notification_id: str = field(compare=False)
    kind: str = field(compare=False)
    text: str = field(compare=False)


class AsyncTelegramNotifier:
    """Bounded priority delivery with durable, non-secret episode/dedupe state."""

    PRIORITY = {"INVALIDATED": 0, "WINDOW30": 0, "WARNING": 1,
                "AIM10": 2, "AIM20": 2, "AIM30": 2, "ROOT": 3,
                "HOLD10": 4, "HOLD20": 4}

    def __init__(self, sender: TelegramSender, state_path: Path, *, queue_capacity: int = 256,
                 test_prefix: str = "", send_interval_seconds: float = 0.0,
                 autostart: bool = True) -> None:
        self.sender = sender
        self.state_path = state_path.resolve()
        self.queue: queue.PriorityQueue[TelegramEvent] = queue.PriorityQueue(maxsize=queue_capacity)
        self.test_prefix = test_prefix.strip()
        self.send_interval_seconds = max(0.0, float(send_interval_seconds))
        self.last_send_monotonic = 0.0
        self.lock = threading.RLock()
        self.stop_event = threading.Event()
        self.sequence = 0
        self.errors: list[str] = []
        self.sent_count = 0
        self.dropped = 0
        self.episodes: dict[str, dict[str, Any]] = {}
        self.dedupe: set[str] = set()
        self.inflight: set[str] = set()
        self.queued: set[str] = set()
        self._load()
        self.thread: threading.Thread | None = None
        if autostart:
            self.thread = threading.Thread(target=self._run, name="options-dashboard-telegram", daemon=True)
            self.thread.start()

    @staticmethod
    def _stamp(value: str | datetime | None) -> datetime:
        if isinstance(value, datetime):
            return value.astimezone(timezone.utc)
        if value:
            try:
                return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(timezone.utc)
            except ValueError:
                pass
        return datetime.now(timezone.utc)

    def _load(self) -> None:
        if not self.state_path.exists():
            return
        payload = json.loads(self.state_path.read_text(encoding="utf-8-sig"))
        self.episodes = dict(payload.get("episodes", {}))
        for episode in self.episodes.values():
            if not episode.get("notification_id"):
                episode["notification_id"] = self._notification_id(
                    str(episode.get("setup_episode_id") or ""),
                    str(episode.get("contract") or ""),
                    str(episode.get("setup_time") or "persisted"),
                )
        self.dedupe = set(payload.get("dedupe_keys", []))
        # An uncertain pre-crash send is never replayed. This favors no duplicate
        # alert over a possibly duplicated alert after a process/power failure.
        self.inflight = set(payload.get("inflight_keys", []))
        self.dedupe.update(self.inflight)

    def _persist(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "schema_version": 1,
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "episodes": self.episodes,
            "dedupe_keys": sorted(self.dedupe),
            "inflight_keys": sorted(self.inflight),
        }
        temporary = self.state_path.with_suffix(self.state_path.suffix + ".tmp")
        temporary.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
        temporary.replace(self.state_path)

    @staticmethod
    def _fmt_percent(value: float | None, decimals: int = 1) -> str:
        return "—" if value is None else f"{100.0 * float(value):.{decimals}f}%"

    @staticmethod
    def _fmt_signed_percent(value: float | None, decimals: int = 1) -> str:
        return "—" if value is None else f"{100.0 * float(value):+.{decimals}f}%"

    @staticmethod
    def _fmt_price(value: float | None) -> str:
        return "—" if value is None else f"{float(value):.2f}"

    def _prefix(self, text: str) -> str:
        return f"{html.escape(self.test_prefix)} · {text}" if self.test_prefix else text

    @staticmethod
    def _notification_id(episode_id: str, contract: str, selection_time: str) -> str:
        """Identify one Telegram root chain within a longer-lived thesis episode."""
        return f"{episode_id}|{contract}|{selection_time}"

    def _root_text(self, decision: dict[str, Any], setup_time: datetime,
                   underlying: float | None) -> str:
        surface = decision["display_probability_surface"]
        aims = decision.get("aim_for_percent_by_horizon") or {}
        title = (f"{MODEL_NAMES.get(decision['model_id'], decision['model_id'])} · "
                 f"{float(decision['strike']):g} {decision['direction']} · GRADE {decision['grade']}")
        table = (
            "          10m    20m    30m\n"
            f"+10%    {self._fmt_percent(surface.get('p10_10')):>6} {self._fmt_percent(surface.get('p10_20')):>6} {self._fmt_percent(surface.get('p10_30')):>6}\n"
            f"+20%    {self._fmt_percent(surface.get('p20_10')):>6} {self._fmt_percent(surface.get('p20_20')):>6} {self._fmt_percent(surface.get('p20_30')):>6}\n"
            f"+30%    {self._fmt_percent(surface.get('p30_10')):>6} {self._fmt_percent(surface.get('p30_20')):>6} {self._fmt_percent(surface.get('p30_30')):>6}"
        )
        contract = (f"{decision['symbol']} {float(decision['strike']):g} {decision['direction']} · "
                    f"1DTE · exp {decision.get('expiration') or '—'}")
        aim_text = " · ".join(f"{h}m +{int(aims.get(h, 0))}%" for h in ("10", "20", "30"))
        return self._prefix(
            f"<b>{html.escape(title)}</b>\n\n"
            f"{html.escape(contract)}\n"
            f"Contract: <code>{html.escape(str(decision.get('candidate_contract') or '—'))}</code>\n"
            f"Delta {float(decision['delta']):.2f} · Bid {self._fmt_price(decision.get('bid'))} · Ask {self._fmt_price(decision.get('ask'))}\n"
            f"{decision['symbol']} {self._fmt_price(underlying)}\n\n"
            f"<b>Direct historical proxy MFE</b>\n<pre>{table}</pre>"
            f"<b>Aim For</b> {html.escape(aim_text)}\n\n"
            f"<b>INVALID IF</b>\n{html.escape(str(decision.get('invalid_if') or 'Unavailable'))}\n\n"
            f"CT {setup_time.astimezone(CT).strftime('%Y-%m-%d %H:%M:%S')}\n"
            f"Setup ID <code>{html.escape(str(decision['setup_episode_id']))}</code>"
        )

    def _followup_text(self, episode: dict[str, Any], heading: str, now: datetime,
                       bid: float | None, underlying: float | None,
                       reason: str | None = None) -> str:
        started = self._stamp(episode["setup_time"])
        elapsed = max(0.0, (now - started).total_seconds() / 60.0)
        original_underlying = episode.get("original_underlying")
        move = None if underlying is None or original_underlying is None else float(underlying) - float(original_underlying)
        move_pct = None if move is None or not float(original_underlying) else move / float(original_underlying)
        original_ask = episode.get("original_ask")
        option_return = None if bid is None or not original_ask else float(bid) / float(original_ask) - 1.0
        lines = [f"<b>{html.escape(heading)}</b>", f"Elapsed {elapsed:.1f}m"]
        if move is None:
            lines.append(f"{episode['symbol']} move unavailable")
        else:
            lines.append(f"{episode['symbol']} move {move:+.2f} ({self._fmt_signed_percent(move_pct)})")
        lines.append(f"Option bid {self._fmt_price(bid)} · return {self._fmt_signed_percent(option_return)}")
        if reason:
            lines.append(f"Reason: {html.escape(reason)}")
        return self._prefix("\n".join(lines))

    def _enqueue(self, episode: dict[str, Any], kind: str, text: str,
                 transition_id: str | None = None) -> bool:
        suffix = f"WARNING:{transition_id}" if kind == "WARNING" else kind
        key = f"{episode['model_id']}:{episode['notification_id']}:{suffix}"
        with self.lock:
            if key in self.dedupe or key in self.inflight or key in self.queued:
                return False
            if kind != "ROOT" and not episode.get("root_message_id"):
                pending = episode.setdefault("pending", {})
                pending[key] = {"kind": kind, "text": text, "transition_id": transition_id}
                return True
            self.sequence += 1
            try:
                self.queue.put_nowait(TelegramEvent(self.PRIORITY[kind], self.sequence, key,
                                                    episode["model_id"], episode["setup_episode_id"],
                                                    episode["notification_id"], kind, text))
                self.queued.add(key)
                return True
            except queue.Full:
                self.dropped += 1
                return False

    def observe_decision(self, decision: dict[str, Any], *, underlying: float | None = None,
                         now: datetime | None = None) -> None:
        now = self._stamp(now)
        model_id = str(decision.get("model_id") or "")
        episode_id = decision.get("setup_episode_id")
        if not model_id or not episode_id:
            return
        with self.lock:
            episode = self.episodes.get(model_id)
            contract = str(decision.get("candidate_contract") or "")
            actionable = (decision.get("grade") in {"A", "B", "C"} and
                          decision.get("guidance_state") == "LIVE" and
                          decision.get("thesis_state") != "INVALIDATED" and
                          decision.get("ask") is not None)
            contract_changed = episode is not None and str(episode.get("contract") or "") != contract
            if episode is None or episode.get("setup_episode_id") != episode_id or contract_changed:
                if not actionable:
                    return
                selection_time = self._stamp(decision.get("model_event_time") or now).isoformat()
                episode = {
                    "model_id": model_id, "setup_episode_id": str(episode_id),
                    "notification_id": self._notification_id(str(episode_id), contract, selection_time),
                    "symbol": str(decision["symbol"]), "direction": str(decision["direction"]),
                    "contract": contract, "strike": decision.get("strike"),
                    "setup_time": selection_time,
                    "original_ask": float(decision["ask"]),
                    "original_underlying": None if underlying is None else float(underlying),
                    "aims": dict(decision.get("aim_for_percent_by_horizon") or {}),
                    "root_message_id": None, "sent": [], "pending": {}, "closed": False,
                    "last_thesis_state": str(decision.get("thesis_state") or "LIVE"),
                    "last_guidance_state": str(decision.get("guidance_state") or "LIVE"),
                    "last_bid": decision.get("bid"), "last_underlying": underlying,
                    "last_priority_event_time": None,
                }
                self.episodes[model_id] = episode
                self._enqueue(episode, "ROOT", self._root_text(decision, now, underlying))
                return
            if episode.get("closed"):
                return
            bid = decision.get("bid") if decision.get("bid") is not None else episode.get("last_bid")
            if underlying is not None:
                episode["last_underlying"] = float(underlying)
            if bid is not None:
                episode["last_bid"] = float(bid)
            previous = episode.get("last_thesis_state")
            current = str(decision.get("thesis_state") or previous)
            if current == "INVALIDATED" and previous != "INVALIDATED":
                text = self._followup_text(episode, "🔴 EXIT · SETUP INVALIDATED", now, bid,
                                           episode.get("last_underlying"),
                                           str(decision.get("invalidation_reason") or "SETUP_INVALIDATED"))
                self._enqueue(episode, "INVALIDATED", text)
                episode["closed"] = True
                episode["last_priority_event_time"] = now.isoformat()
            elif current == "WARNING" and previous != "WARNING":
                transition_id = str(decision.get("latest_same_side_event_time") or now.isoformat())
                text = self._followup_text(episode, "🟡 HOLD · WARNING", now, bid,
                                           episode.get("last_underlying"),
                                           str(decision.get("invalidation_reason") or "THESIS_WARNING"))
                self._enqueue(episode, "WARNING", text, transition_id)
                episode["last_priority_event_time"] = now.isoformat()
            episode["last_thesis_state"] = current
            episode["last_guidance_state"] = str(decision.get("guidance_state") or "BLOCKED")

    def observe_quote(self, contract: str, *, bid: float | None, quote_time: str | None,
                      quote_fresh: bool, underlying_by_symbol: dict[str, float],
                      now: datetime | None = None) -> None:
        now = self._stamp(now)
        if not quote_fresh or bid is None:
            return
        with self.lock:
            for episode in self.episodes.values():
                if episode.get("closed") or episode.get("contract") != contract:
                    continue
                episode["last_bid"] = float(bid)
                underlying = underlying_by_symbol.get(str(episode["symbol"]))
                if underlying is not None:
                    episode["last_underlying"] = float(underlying)
                option_return = float(bid) / float(episode["original_ask"]) - 1.0
                for horizon in (10, 20, 30):
                    kind = f"AIM{horizon}"
                    aim = episode.get("aims", {}).get(str(horizon))
                    if aim is None or option_return < float(aim) / 100.0:
                        continue
                    heading = f"💰 TAKE PROFITS · {horizon}m AIM REACHED"
                    elapsed = (now - self._stamp(episode["setup_time"])).total_seconds() / 60
                    if elapsed < horizon:
                        heading += " EARLY"
                    if self._enqueue(episode, kind, self._followup_text(
                            episode, heading, now, float(bid), episode.get("last_underlying"))):
                        episode["last_priority_event_time"] = now.isoformat()

    def sweep(self, *, underlying_by_symbol: dict[str, float],
              quotes: dict[str, dict[str, Any]], quote_stale_seconds: float,
              now: datetime | None = None) -> None:
        now = self._stamp(now)
        with self.lock:
            for episode in self.episodes.values():
                if episode.get("closed"):
                    continue
                quote = quotes.get(str(episode["contract"]), {})
                quote_time = self._stamp(quote.get("quote_time")) if quote.get("quote_time") else None
                quote_fresh = quote_time is not None and (now - quote_time).total_seconds() <= quote_stale_seconds
                if not quote_fresh or quote.get("bid") is None:
                    continue
                bid = float(quote["bid"])
                underlying = underlying_by_symbol.get(str(episode["symbol"]), episode.get("last_underlying"))
                elapsed = (now - self._stamp(episode["setup_time"])).total_seconds() / 60.0
                last_priority = self._stamp(episode.get("last_priority_event_time")) if episode.get("last_priority_event_time") else None
                quiet = last_priority is None or (now - last_priority).total_seconds() >= 60
                if elapsed >= 30:
                    text = self._followup_text(episode, "⏱️ 30m WINDOW COMPLETE · EXIT / REASSESS",
                                               now, bid, underlying)
                    self._enqueue(episode, "WINDOW30", text)
                    episode["closed"] = True
                elif quiet and elapsed >= 20:
                    self._enqueue(episode, "HOLD20", self._followup_text(
                        episode, "🟢 HOLD · 20m UPDATE", now, bid, underlying))
                elif quiet and elapsed >= 10:
                    self._enqueue(episode, "HOLD10", self._followup_text(
                        episode, "🟢 HOLD · 10m UPDATE", now, bid, underlying))

    def pinned_contracts(self) -> list[str]:
        with self.lock:
            return list(dict.fromkeys(str(row["contract"]) for row in self.episodes.values()
                                      if not row.get("closed") and row.get("contract")))

    def _mark_inflight(self, event: TelegramEvent) -> None:
        with self.lock:
            self.inflight.add(event.dedupe_key)
            self._persist()

    def _mark_sent(self, event: TelegramEvent, message_id: int) -> None:
        with self.lock:
            self.inflight.discard(event.dedupe_key)
            self.dedupe.add(event.dedupe_key)
            episode = self.episodes.get(event.model_id)
            if (episode and episode.get("setup_episode_id") == event.episode_id and
                    episode.get("notification_id") == event.notification_id):
                episode.setdefault("sent", []).append(event.kind)
                if event.kind == "ROOT":
                    episode["root_message_id"] = int(message_id)
                    pending = list(episode.setdefault("pending", {}).items())
                    episode["pending"] = {}
                    for key, row in pending:
                        self.sequence += 1
                        self.queue.put_nowait(TelegramEvent(
                            self.PRIORITY[row["kind"]], self.sequence, key, event.model_id,
                            event.episode_id, event.notification_id, row["kind"], row["text"]))
                        self.queued.add(key)
            self.sent_count += 1
            self._persist()

    def drain_once(self) -> bool:
        try:
            event = self.queue.get_nowait()
        except queue.Empty:
            return False
        with self.lock:
            self.queued.discard(event.dedupe_key)
        try:
            with self.lock:
                episode = self.episodes.get(event.model_id)
                if (not episode or episode.get("setup_episode_id") != event.episode_id or
                        episode.get("notification_id") != event.notification_id):
                    return True
                root_id = episode.get("root_message_id")
            self._mark_inflight(event)
            remaining = self.send_interval_seconds - (time.monotonic() - self.last_send_monotonic)
            if remaining > 0:
                time.sleep(remaining)
            message_id = self.sender.send_message(event.text,
                                                  reply_to=None if event.kind == "ROOT" else int(root_id))
            self.last_send_monotonic = time.monotonic()
            self._mark_sent(event, message_id)
        except Exception as exc:
            with self.lock:
                self.inflight.discard(event.dedupe_key)
                self.errors.append(f"{type(exc).__name__}: Telegram delivery unavailable")
                self.errors[:] = self.errors[-20:]
                self._persist()
            # Delivery outages are isolated. A subsequent state observation may
            # enqueue the durable unsent key again.
        finally:
            self.queue.task_done()
        return True

    def _run(self) -> None:
        while not self.stop_event.is_set():
            if not self.drain_once():
                self.stop_event.wait(.05)

    def wait_idle(self, timeout: float = 5.0) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.queue.unfinished_tasks == 0:
                return True
            time.sleep(.01)
        return False

    def health(self) -> dict[str, Any]:
        return {"status": "DEGRADED" if self.errors or self.dropped else "LIVE",
                "queued": self.queue.qsize(), "sent": self.sent_count,
                "dropped": self.dropped, "errors": list(self.errors)}

    def close(self, timeout: float = 5.0) -> None:
        self.wait_idle(timeout=max(.1, timeout * .8))
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout)
