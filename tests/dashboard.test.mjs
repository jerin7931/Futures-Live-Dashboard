import test from "node:test";
import assert from "node:assert/strict";
import { analysisIsStale, footprintContext, healthState, isMeaningfulHistory, keyLevels, levelInteraction, nextExpectedLabel, optionPresentationState } from "../core.js";

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
  assert.equal(nextExpectedLabel(new Date("2026-09-16T22:00:00Z")), "Tomorrow · 08:30 CT");
});

test("next expected run aligns to the next five-minute bar close", () => {
  assert.equal(nextExpectedLabel(new Date("2026-09-16T15:32:00Z")), "Today · 10:35 CT");
});

test("key levels hide nulls and keep the nearest confirmed 15m levels", () => {
  const levels = keyLevels({ prior_day_high: 101, prior_day_low: null, premarket_high: null, opening_range_low: 99, important_15m_levels: [
    { type: "SWING_HIGH", price: 103 }, { type: "SWING_HIGH", price: 101.5 }, { type: "SWING_LOW", price: 98.5 },
  ] }, 100);
  assert.deepEqual(levels, [["PDH", 101], ["Opening Range Low", 99], ["15m Resistance", 101.5], ["15m Support", 98.5]]);
});

test("location interaction is shown only for the active matching level", () => {
  assert.equal(levelInteraction({ active_level: { type: "SWING_HIGH", relation: "AT" } }, "15m Resistance"), "AT");
  assert.equal(levelInteraction({ active_level: { type: "SWING_HIGH", relation: "AT" } }, "15m Support"), null);
});

test("a prior swing high is displayed as support after price moves above it", () => {
  const context = { important_15m_levels: [
    { type: "SWING_HIGH", status: "ACTIVE", price: 103 },
    { type: "SWING_HIGH", status: "ACTIVE", price: 101.5 },
    { type: "SWING_LOW", status: "ACTIVE", price: 98.5 },
  ] };
  const location = {
    nearest_support: { type: "SWING_HIGH", price: 101.5 },
    nearest_resistance: { type: "SWING_HIGH", price: 103 },
    active_level: { type: "SWING_HIGH", price: 101.5, relation: "AT" },
  };
  const levels = keyLevels(context, 102, location);
  assert.deepEqual(levels, [["15m Resistance", 103], ["15m Support", 101.5]]);
  assert.equal(levelInteraction(location, "15m Support", 101.5), "AT");
  assert.equal(levelInteraction(location, "15m Resistance", 103), null);
});

test("futures context hides unavailable summaries", () => {
  assert.equal(footprintContext({ location_summary: "Above prior RTH high" }), "Above prior RTH high");
  assert.equal(footprintContext({ location_summary: "Context unavailable" }), null);
});

test("confirmed setup without a candidate remains explicit and non-actionable", () => {
  const row = { session_state: "OPEN", session_phase: "NORMAL", valid_until: "2026-09-16T21:40:00Z" };
  const payload = { session: { state: "OPEN", phase: "NORMAL" }, best_watch: { symbol: "QQQ", direction: "CALL", state: "CONFIRMED" }, contract_candidate: null };
  const state = optionPresentationState(row, payload, false);
  assert.equal(state.code, "NO_CONTRACT");
  assert.equal(state.label, "NO QUALIFIED CONTRACT");
  assert.equal(state.setupReady, true);
  assert.equal(state.contractReady, false);
  assert.equal(state.entryAllowed, false);
});

test("late-session confirmation is labeled entry suppressed", () => {
  const row = { session_state: "OPEN", session_phase: "LATE_SESSION", valid_until: "2026-09-16T21:40:00Z" };
  const payload = { session: { state: "OPEN", phase: "LATE_SESSION" }, best_watch: { symbol: "SPY", direction: "CALL", state: "CONFIRMED" }, contract_candidate: null };
  const state = optionPresentationState(row, payload, false);
  assert.equal(state.code, "ENTRY_SUPPRESSED");
  assert.equal(state.entryAllowed, false);
});

test("a current validated candidate is separately marked ready", () => {
  const row = { session_state: "OPEN", session_phase: "NORMAL", valid_until: "2026-09-16T21:40:00Z" };
  const payload = { session: { state: "OPEN", phase: "NORMAL" }, best_watch: { symbol: "SPY", direction: "PUT", state: "CONFIRMED" }, contract_candidate: { option_symbol: "SPY_TEST", bid: 1, ask: 1.05, quote_event_at: "2026-09-16T21:30:00Z" } };
  const state = optionPresentationState(row, payload, false);
  assert.equal(state.code, "CANDIDATE");
  assert.equal(state.contractReady, true);
  assert.equal(state.entryAllowed, true);
});
