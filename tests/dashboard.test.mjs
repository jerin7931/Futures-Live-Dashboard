import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { analysisIsStale, footprintContext, healthState, isMeaningfulHistory, keyLevels, levelInteraction, nextExpectedLabel, optionPresentationState, rangePosition } from "../core.js";
import { createGammaFrameManager, GAMMA_URLS } from "../gamma.js";

const [indexHtml, appSource] = await Promise.all([
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8"),
]);

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(value) { this.values.add(value); }
  remove(value) { this.values.delete(value); }
  contains(value) { return this.values.has(value); }
  toggle(value, force) {
    if (force === undefined ? !this.values.has(value) : force) this.values.add(value);
    else this.values.delete(value);
  }
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.classList = new FakeClassList();
    this.hidden = false;
    this.textContent = "";
    this._src = "";
    this.srcAssignments = 0;
    this.listeners = new Map();
  }
  set className(value) { this._className = value; value.split(/\s+/).filter(Boolean).forEach((name) => this.classList.add(name)); }
  get className() { return this._className || ""; }
  set src(value) { this._src = value; this.srcAssignments += 1; }
  get src() { return this._src; }
  appendChild(child) { this.children.push(child); child.parent = this; return child; }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  dispatch(name) { this.listeners.get(name)?.(); }
}

function gammaHarness() {
  const document = { createElement: (tagName) => new FakeElement(tagName) };
  const host = new FakeElement();
  const status = new FakeElement();
  const selected = new FakeElement();
  const openOriginal = new FakeElement("a");
  const symbolButtons = ["SPX", "SPY", "QQQ"].map((symbol) => {
    const button = new FakeElement("button");
    button.dataset.gammaSymbol = symbol;
    return button;
  });
  const manager = createGammaFrameManager({ document, host, status, selected, openOriginal, symbolButtons });
  return { host, manager, openOriginal, selected, status };
}

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

test("gamma is the fifth routed dashboard view with a Brief shortcut", () => {
  assert.match(indexHtml, /data-view="gamma"[^>]*><span>05<\/span>Gamma \/ GEX<\/button>/);
  assert.match(indexHtml, /data-view-panel="gamma"/);
  assert.match(indexHtml, /class="text-button brief-gamma-link" data-view="gamma"/);
  assert.match(appSource, /\["brief", "structure", "focus", "options", "gamma"\]\.includes\(view\)/);
});

test("gamma frames are absent from initial authenticated and unauthenticated markup", () => {
  assert.equal((indexHtml.match(/<iframe\b/g) || []).length, 0);
  assert.match(appSource, /if \(next === "gamma" && dashboardAuthorized\) gammaManager\.open\(\)/);
});

test("gamma frames are lazy-created once per symbol and retain node identity", () => {
  const { host, manager } = gammaHarness();
  assert.equal(manager.frameCount(), 0);
  const spx = manager.open();
  assert.equal(manager.frameCount(), 1);
  assert.equal(spx.src, GAMMA_URLS.SPX);
  assert.equal(spx.loading, "lazy");
  assert.equal(spx.title, "InsiderFinance SPX Gamma Exposure");
  assert.equal(manager.getFrame("SPY"), null);
  assert.equal(manager.getFrame("QQQ"), null);

  const qqq = manager.select("QQQ");
  assert.equal(manager.frameCount(), 2);
  const originalSpxSrcAssignments = spx.srcAssignments;
  assert.strictEqual(manager.select("SPX"), spx);
  assert.equal(spx.srcAssignments, originalSpxSrcAssignments);
  assert.strictEqual(manager.select("QQQ"), qqq);

  manager.select("SPY");
  manager.select("SPY");
  manager.select("QQQ");
  assert.equal(manager.frameCount(), 3);
  assert.equal(host.children.length, 3);
});

test("dashboard refresh and view changes do not recreate gamma frames", () => {
  const renderStart = appSource.indexOf("function render(data)");
  const renderEnd = appSource.indexOf("async function refresh()", renderStart);
  const renderSource = appSource.slice(renderStart, renderEnd);
  assert.doesNotMatch(renderSource, /gammaManager|gammaFrameHost|InsiderFinance/);

  const { manager } = gammaHarness();
  const spx = manager.open();
  manager.select("QQQ");
  assert.strictEqual(manager.open(), manager.getFrame("QQQ"));
  assert.strictEqual(manager.select("SPX"), spx);
});

test("sign-out cleanup destroys every external gamma frame", () => {
  const showAuthStart = appSource.indexOf("function showAuth");
  const showAuthEnd = appSource.indexOf("function showDashboard", showAuthStart);
  assert.match(appSource.slice(showAuthStart, showAuthEnd), /gammaManager\.destroy\(\)/);
  assert.match(appSource, /\$\("signOut"\)\.addEventListener\("click", async \(\) => \{[\s\S]*?showAuth\(\);/);

  const { host, manager } = gammaHarness();
  manager.open();
  manager.select("SPY");
  manager.select("QQQ");
  manager.destroy();
  assert.equal(manager.frameCount(), 0);
  assert.equal(host.children.length, 0);
  assert.equal(manager.getCurrentSymbol(), "SPX");
});

test("Reload current reloads only the selected frame", () => {
  const { manager } = gammaHarness();
  const spx = manager.open();
  const qqq = manager.select("QQQ");
  assert.equal(spx.srcAssignments, 1);
  assert.equal(qqq.srcAssignments, 1);
  assert.equal(manager.reloadCurrent(), true);
  assert.equal(spx.srcAssignments, 1);
  assert.equal(qqq.srcAssignments, 2);
});

test("Open original tracks the selected symbol", () => {
  const { manager, openOriginal, selected } = gammaHarness();
  manager.open();
  assert.equal(openOriginal.href, GAMMA_URLS.SPX);
  manager.select("SPY");
  assert.equal(openOriginal.href, GAMMA_URLS.SPY);
  assert.equal(selected.textContent, "SPY");
  assert.match(indexHtml, /id="gammaOpenOriginal"[^>]*target="_blank" rel="noopener noreferrer"/);
});

test("CSP permits only the requested InsiderFinance frame origin", () => {
  const directives = indexHtml.match(/frame-src [^;]+;/g) || [];
  assert.deepEqual(directives, ["frame-src https://www.insiderfinance.io;"]);
});

test("range marker position reflects price distance between support and resistance", () => {
  assert.ok(Math.abs(rangePosition(762.9, 762.8, 762.95) - 66.6666667) < 0.0001);
  assert.ok(Math.abs(rangePosition(717.23, 717.16, 718.04) - 7.9545455) < 0.0001);
  assert.equal(rangePosition(99, 100, 110), 2);
  assert.equal(rangePosition(111, 100, 110), 98);
  assert.equal(rangePosition(null, 100, 110), 50);
  assert.equal(rangePosition(105, 110, 100), 50);
});

test("range marker avoids CSP-blocked inline style markup", () => {
  assert.doesNotMatch(appSource, /<i style="left:/);
  assert.match(appSource, /marker\.style\.left = `\$\{position\}%`/);
});
