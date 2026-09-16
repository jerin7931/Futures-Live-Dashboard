import test from "node:test";
import assert from "node:assert/strict";
import { analysisIsStale, healthState, isMeaningfulHistory, nextExpectedLabel } from "../core.js";

test("valid_until controls stale analysis", () => {
  const now = new Date("2026-09-16T21:30:00Z");
  assert.equal(analysisIsStale({ valid_until: "2026-09-16T21:29:59Z" }, now), true);
  assert.equal(analysisIsStale({ valid_until: "2026-09-16T21:31:00Z" }, now), false);
});

test("market closed overrides live health display", () => {
  assert.equal(healthState({ timestamp: "2026-09-16T21:30:00Z", closed: true, thresholdSeconds: 90, now: new Date("2026-09-16T21:30:01Z") }), "MARKET CLOSED");
});

test("unchanged history is suppressed", () => {
  assert.equal(isMeaningfulHistory({ payload: { changed: "UNCHANGED — SAME SETUP" } }), false);
  assert.equal(isMeaningfulHistory({ payload: { changed: "SPY WAIT → FORMING PUT" } }), true);
});

test("closed weekday points to next weekday open", () => {
  assert.equal(nextExpectedLabel(new Date("2026-09-16T22:00:00Z")), "Tomorrow · 08:31 CT");
});
