import { CONFIG } from "./config.js";
import {
  ageLabel, analysisIsStale, ctClock, dateTime, footprintContext, healthState,
  isMeaningfulHistory, keyLevels, levelInteraction, nextExpectedLabel, number,
  optionPresentationState, rangePosition, statusClass, timeOnly,
} from "./core.js?v=5";
import { createGammaFrameManager } from "./gamma.js?v=1";

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "—").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const client = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabasePublishableKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

let pollTimer = null;
let currentData = null;
let focusSymbol = "SPY";
let lastFocusedElement = null;
let dashboardAuthorized = false;

const gammaManager = createGammaFrameManager({
  document,
  host: $("gammaFrameHost"),
  status: $("gammaStatus"),
  selected: $("gammaSelected"),
  openOriginal: $("gammaOpenOriginal"),
  symbolButtons: Array.from(document.querySelectorAll("[data-gamma-symbol]")),
});

function valueOrDash(value) {
  return value === null || value === undefined || value === "" ? "—" : escapeHtml(value);
}

function pill(value, dot = false) {
  return `<span class="pill ${statusClass(value)}">${dot ? '<i class="dot"></i>' : ""}${escapeHtml(value || "—")}</span>`;
}

function phaseLabel(row) {
  return String(row?.payload?.session?.phase || row?.session_phase || "UNAVAILABLE").replaceAll("_", " ");
}

function formatLevelType(type) {
  const labels = {
    PRIOR_DAY_HIGH: "Prior-day high", PRIOR_DAY_LOW: "Prior-day low",
    OPENING_RANGE_HIGH: "Opening-range high", OPENING_RANGE_LOW: "Opening-range low",
    PREMARKET_HIGH: "Premarket high", PREMARKET_LOW: "Premarket low",
    SWING_HIGH: "15m swing high", SWING_LOW: "15m swing low",
  };
  return labels[type] || String(type || "Level").replaceAll("_", " ").toLowerCase();
}

function showAuth(message = "") {
  dashboardAuthorized = false;
  gammaManager.destroy();
  $("dashboard").classList.add("hidden");
  $("authView").classList.remove("hidden");
  $("authError").textContent = message;
  clearInterval(pollTimer);
}

function showDashboard() {
  dashboardAuthorized = true;
  $("authView").classList.add("hidden");
  $("dashboard").classList.remove("hidden");
}

async function authorize(session) {
  if (!session?.user) return false;
  const { data, error } = await client.from("dashboard_readers").select("user_id").eq("user_id", session.user.id).maybeSingle();
  if (error || !data) {
    await client.auth.signOut();
    showAuth("This account is not authorized for the private dashboard.");
    return false;
  }
  showDashboard();
  setView(window.location.hash.replace("#", "") || "brief", false);
  await refresh();
  clearInterval(pollTimer);
  pollTimer = setInterval(refresh, CONFIG.pollIntervalMs);
  return true;
}

function setView(view, updateHash = true) {
  const next = ["brief", "structure", "focus", "options", "gamma"].includes(view) ? view : "brief";
  document.querySelectorAll("[data-view-panel]").forEach((panel) => panel.classList.toggle("hidden", panel.dataset.viewPanel !== next));
  document.querySelectorAll("[data-view]").forEach((button) => {
    const selected = button.dataset.view === next;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  if (next === "gamma" && dashboardAuthorized) gammaManager.open();
  if (updateHash) history.replaceState(null, "", `#${next}`);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function latestByTicker(rows, ticker) {
  return (rows || []).find((row) => row.tickerid === ticker) || null;
}

function heroCopy(row, payload, presentation, stale) {
  const best = payload?.best_watch || {};
  if (!row) return ["Waiting for the first analyst state.", "The dashboard is connected, but no current analysis row is available."];
  if (row.session_state === "MARKET_CLOSED" || row.session_phase === "CLOSED") return ["The session is closed.", "Prior levels remain visible for context, but they are not current entry guidance."];
  if (stale) return ["The current state has expired.", "Wait for a fresh scheduled analysis before treating any setup or contract as actionable."];
  if (presentation.code === "CANDIDATE") return [`${best.symbol || "A setup"} has a validated contract candidate.`, "The underlying setup and the Webull contract-quality checks both passed for this analysis cycle."];
  if (best.state === "CONFIRMED") return [`${best.symbol || "The leading setup"} is confirmed.`, presentation.detail];
  if (best.state === "FORMING") return [`${best.symbol || "A setup"} is forming, not triggered.`, "Direction is context. Wait for the stated trigger and do not chase between levels."];
  return ["Observe the state. Wait for permission.", best.reason || "Bias, setup confirmation, and option selection are intentionally separate decisions."];
}

function renderHero(row, payload, presentation, stale) {
  const [headline, detail] = heroCopy(row, payload, presentation, stale);
  $("briefHero").innerHTML = `<div class="hero-copy">
    <div class="hero-status">${pill(stale ? "STALE" : phaseLabel(row), true)}<span>${escapeHtml(payload?.analysis_mode || "—")} analysis · ${escapeHtml(payload?.freshness_state || "—")}</span></div>
    <h1>${escapeHtml(headline)}<br><span>${escapeHtml(presentation.title)}</span></h1>
    <p>${escapeHtml(detail)}</p>
  </div><div class="hero-update"><span class="eyebrow">LAST COMPLETED ANALYSIS</span><strong>${escapeHtml(timeOnly(row?.as_of))} <span>CT</span></strong><p>${escapeHtml(ageLabel(row?.analysis_completed_at || row?.as_of))}<br>Next scheduled: ${escapeHtml(nextExpectedLabel())}</p><button class="text-button" data-drawer="health">Timing &amp; source health ↗</button></div>`;
}

function assetRead(symbol, leg, presentation) {
  const state = String(leg?.opportunity_state || "PASS").toUpperCase();
  if (state === "TARGET_REACHED") return `${symbol} reached the stated target. Do not recycle the completed setup.`;
  if (state === "CONFIRMED") return presentation.contractReady ? `${symbol} is confirmed and has a validated contract candidate.` : `${symbol} is confirmed, but option selection remains separate and no qualified contract is available.`;
  if (state === "FORMING") return `${symbol} is forming in the stated direction. Confirmation still requires the published trigger.`;
  if (leg?.bias && leg.bias !== "TRANSITION") return `${symbol} has ${String(leg.bias).toLowerCase()} context, but there is no confirmed entry permission.`;
  return `${symbol} has no clean opportunity. Preserve capital and wait for clearer structure.`;
}

function assetBrief(symbol, leg, source, context, presentation) {
  const location = leg?.location_context || {};
  const support = location.nearest_support;
  const resistance = location.nearest_resistance;
  const referenceOne = leg?.trigger != null ? ["Trigger", leg.trigger] : ["VWAP", context?.vwap];
  const referenceTwo = leg?.invalidation != null ? ["Invalidation", leg.invalidation] : ["Opening range high", context?.opening_range_high];
  return `<div class="asset-top"><div class="symbol-price"><h2>${symbol}</h2><strong>${number(source?.price)}</strong></div>${pill(leg?.opportunity_state || "PASS")}</div>
    <div class="status-row">${pill(leg?.bias || "—")}${pill(leg?.direction || "NO DIRECTION")}</div>
    <p class="asset-read">${escapeHtml(assetRead(symbol, leg, presentation))}</p>
    <div class="range-box"><div class="range-labels"><div><small>NEAREST SUPPORT</small><b>${number(support?.price)}</b></div><div><small>CURRENT</small><b>${number(source?.price)}</b></div><div><small>NEAREST RESISTANCE</small><b>${number(resistance?.price)}</b></div></div><div class="range-track"><i data-range-marker="${escapeHtml(symbol)}"></i></div><div class="range-distance"><span>${escapeHtml(formatLevelType(support?.type))}</span><span>${escapeHtml(location.location_summary || "Mapped structure")}</span><span>${escapeHtml(formatLevelType(resistance?.type))}</span></div></div>
    <div class="key-reference"><div><small>${escapeHtml(referenceOne[0])}</small><b>${number(referenceOne[1])}</b></div><div><small>${escapeHtml(referenceTwo[0])}</small><b>${number(referenceTwo[1])}</b></div></div>
    <div class="evidence-line"><i></i><p>${valueOrDash(leg?.evidence)}</p></div><div class="evidence-line caution"><i></i><p>${valueOrDash(leg?.conflict)}</p></div>
    <button class="card-link" data-drawer="${symbol.toLowerCase()}"><span>Full ${symbol} decision detail</span><span>↗</span></button>`;
}

function positionRangeMarker(symbol, leg, source) {
  const location = leg?.location_context || {};
  const position = rangePosition(source?.price, location.nearest_support?.price, location.nearest_resistance?.price);
  const marker = document.querySelector(`[data-range-marker="${symbol}"]`);
  if (marker) marker.style.left = `${position}%`;
}

function renderOptionPresence(presentation) {
  const candidate = presentation.candidate;
  const contract = candidate?.option_symbol || candidate?.contract;
  $("optionContract").innerHTML = `<div class="option-presence-icon">${candidate ? "◈" : "◇"}</div><div><span class="eyebrow">OPTION WORKFLOW · ${escapeHtml(presentation.label)}</span><h3>${candidate ? escapeHtml(contract) : escapeHtml(presentation.title)}</h3><p>${escapeHtml(presentation.detail)}</p></div><button class="option-link" data-view="options">Open options desk ↗</button>`;
}

function renderBest(payload, presentation) {
  const best = payload?.best_watch || {};
  const leg = best.symbol ? payload?.[best.symbol.toLowerCase()] : null;
  const title = best.symbol && best.direction ? `${best.symbol} ${best.direction}` : (best.symbol || "PASS");
  $("bestOpportunity").innerHTML = `<div class="decision-lead"><span class="eyebrow">BEST WATCH · ${escapeHtml(best.state || "PASS")}</span><h2>${escapeHtml(title)}</h2><p>${valueOrDash(best.reason || "No clean 0DTE opportunity.")}</p></div><div class="decision-metrics">
    ${[["Setup", leg?.setup_type], ["Buying trigger", leg?.trigger], ["No-chase", leg?.no_chase], ["Invalidation", leg?.invalidation], ["Target 1", leg?.target_1], ["Target 2", leg?.target_2], ["Valid until", dateTime(payload?.valid_until)], ["Contract", presentation.contractReady ? "VALIDATED" : presentation.label]].map(([label, value]) => `<div class="metric"><small>${label}</small><strong>${valueOrDash(value)}</strong></div>`).join("")}
  </div>`;
}

function footprintLine(alias, bar, interpretation) {
  if (!bar) return `<div class="future-line"><span class="future-symbol">${alias}</span><div class="future-text"><strong>Completed bar unavailable</strong><p>No participation confirmation can be shown.</p></div>${pill("UNAVAILABLE")}</div>`;
  const direction = Number(bar.delta) > 0 ? "Positive delta" : Number(bar.delta) < 0 ? "Negative delta" : "Flat delta";
  return `<div class="future-line"><span class="future-symbol">${alias}</span><div class="future-text"><strong>${escapeHtml(direction)} · ${number(bar.delta, 0)} · POC ${number(bar.poc_low)}–${number(bar.poc_high)}</strong><p>${valueOrDash(interpretation)}</p></div>${pill(Number(bar.delta) > 0 ? "BID" : Number(bar.delta) < 0 ? "OFFER" : "MIXED")}</div>`;
}

function renderBriefFootprints(es, mnq, payload) {
  $("briefFootprints").innerHTML = footprintLine("ES", es, payload?.spy?.footprint_interpretation) + footprintLine("MNQ", mnq, payload?.qqq?.footprint_interpretation);
}

function meaningfulHistory(rows) {
  return (rows || []).filter(isMeaningfulHistory);
}

function renderHistory(rows) {
  const historyRows = meaningfulHistory(rows).slice(0, 4);
  $("history").innerHTML = historyRows.length ? historyRows.map((row) => `<div class="timeline-row"><time>${timeOnly(row.as_of)}</time><i class="timeline-pin"></i><p>${escapeHtml(row.payload?.changed || "State changed")}</p></div>`).join("") : `<div class="empty">No meaningful transitions recorded yet. Unchanged cycles are suppressed.</div>`;
}

function normalizedStructureLevels(leg, source, context) {
  const location = leg?.location_context || {};
  const levels = [
    ["Current price", source?.price, "current", "Latest public-market observation"],
    [formatLevelType(location.nearest_resistance?.type), location.nearest_resistance?.price, "resistance", "Nearest mapped resistance"],
    [formatLevelType(location.nearest_support?.type), location.nearest_support?.price, "support", "Nearest mapped support"],
    ...keyLevels(context, source?.price, location).map(([label, value]) => [label, value, label.includes("High") || label.includes("Resistance") ? "resistance" : "support", levelInteraction(location, label, value) || "Validated daily / 15m map"]),
    ["VWAP", context?.vwap, Number(source?.price) >= Number(context?.vwap) ? "support" : "resistance", "Session volume-weighted average"],
  ].filter(([, value]) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)));
  const seen = new Set();
  return levels.filter(([label, value]) => {
    const key = `${label}:${Number(value).toFixed(6)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => Number(b[1]) - Number(a[1]));
}

function structureCard(symbol, leg, source, context) {
  const levels = normalizedStructureLevels(leg, source, context);
  return `<div class="ladder-head"><div><span class="eyebrow">${symbol} STRUCTURE</span><h2>${number(source?.price)} <span>${symbol}</span></h2></div>${pill(leg?.bias || "—")}</div><div class="ladder-state"><span class="subtle">${escapeHtml(leg?.location_context?.location_summary || "Mapped levels")}</span>${pill(leg?.opportunity_state || "PASS")}</div><div class="ladder-body">${levels.length ? levels.map(([label, value, role, note]) => `<div class="level-row ${role}"><div class="level-copy"><b>${escapeHtml(label)}</b><small>${escapeHtml(note)}</small></div><i class="level-connector"></i><span class="level-number">${number(value)}</span></div>`).join("") : '<div class="empty">No validated levels available.</div>'}</div><div class="ladder-foot">Levels are descriptive context, not stand-alone buying triggers.</div>`;
}

function renderStructure(row, payload, sources, presentation) {
  $("structureStamp").textContent = `As of ${dateTime(row?.as_of)}`;
  $("structureSession").innerHTML = `<strong>${escapeHtml(phaseLabel(row))}</strong> · ${escapeHtml(presentation.title)} · Buying permission requires the stated trigger, a valid session gate, and a qualified contract.`;
  $("spyStructure").innerHTML = structureCard("SPY", payload?.spy, sources.spy, payload?.daily_context?.spy);
  $("qqqStructure").innerHTML = structureCard("QQQ", payload?.qqq, sources.qqq, payload?.daily_context?.qqq);
  const best = payload?.best_watch || {};
  const leg = best.symbol ? payload?.[best.symbol.toLowerCase()] : null;
  $("decisionBoard").innerHTML = `<span class="eyebrow">DECISION BOARD</span><h2>${escapeHtml(best.symbol || "No best watch")}</h2><div class="decision-block">${pill(best.state || "PASS")}<h3>${valueOrDash(best.direction || "WAIT")}</h3><p>${valueOrDash(best.reason)}</p></div><div class="decision-block"><span class="eyebrow">BUYING TRIGGER</span><h3>${valueOrDash(leg?.trigger)}</h3><p>${valueOrDash(leg?.no_chase)}</p></div><div class="decision-block"><span class="eyebrow">RISK BOUNDARY</span><div class="decision-callout"><span>INVALIDATION</span><strong>${valueOrDash(leg?.invalidation)}</strong></div><div class="decision-callout"><span>TARGET 1</span><strong>${valueOrDash(leg?.target_1)}</strong></div></div><div class="decision-block"><span class="eyebrow">OPTION PERMISSION</span><h3>${escapeHtml(presentation.label)}</h3><p>${escapeHtml(presentation.detail)}</p></div>`;
}

function healthBadge(name, state, timestamp) {
  return `<div class="health"><span class="health-name"><i class="dot ${statusClass(state)}"></i> ${escapeHtml(name)}</span><span class="health-value"><strong class="${statusClass(state)}">${escapeHtml(state)}</strong><small>${escapeHtml(ageLabel(timestamp))}</small></span></div>`;
}

function renderHealth(row, data, es, mnq, closed, stale) {
  const provider = data.provider;
  const analystState = closed ? "MARKET CLOSED" : stale ? "STALE" : "LIVE";
  $("healthGrid").innerHTML = [
    healthBadge("ES FOOTPRINT", healthState({ timestamp: es?.received_at || es?.bar_time, closed, thresholdSeconds: CONFIG.footprintFreshSeconds }), es?.received_at || es?.bar_time),
    healthBadge("MNQ FOOTPRINT", healthState({ timestamp: mnq?.received_at || mnq?.bar_time, closed, thresholdSeconds: CONFIG.footprintFreshSeconds }), mnq?.received_at || mnq?.bar_time),
    healthBadge("WEBULL OPTIONS", provider?.state === "MARKET_CLOSED" ? "MARKET CLOSED" : healthState({ timestamp: provider?.heartbeat_at, closed: false, thresholdSeconds: CONFIG.providerFreshSeconds }), provider?.heartbeat_at),
    healthBadge("CODEX ANALYST", analystState, row?.analysis_completed_at),
  ].join("");
}

function checklistRow(ok, label, detail, state) {
  return `<div class="check-row"><span class="check-marker ${ok ? "" : "warn"}">${ok ? "✓" : "·"}</span><div><b>${escapeHtml(label)}</b><p>${escapeHtml(detail)}</p></div><span>${escapeHtml(state)}</span></div>`;
}

function renderFocus(payload, sources, presentation) {
  const symbol = focusSymbol;
  const leg = payload?.[symbol.toLowerCase()] || {};
  const source = sources[symbol.toLowerCase()] || {};
  const bestForSymbol = payload?.best_watch?.symbol === symbol;
  $("focusSpyPrice").textContent = number(sources.spy?.price);
  $("focusQqqPrice").textContent = number(sources.qqq?.price);
  document.querySelectorAll("[data-focus]").forEach((button) => {
    const selected = button.dataset.focus === symbol;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  const sessionAllowed = !["CLOSED", "OPENING_OBSERVATION", "LATE_SESSION", "CLOSING_SUMMARY"].includes(String(payload?.session?.phase || "").toUpperCase());
  const setupReady = String(leg.opportunity_state || "").toUpperCase() === "CONFIRMED";
  const candidateSymbol = presentation.candidate?.underlying_symbol || presentation.candidate?.symbol || payload?.best_watch?.symbol;
  const contractForSymbol = presentation.contractReady && candidateSymbol === symbol;
  $("focusContent").innerHTML = `<section class="focus-hero"><div class="focus-lead"><span class="eyebrow">${symbol} DECISION PATH</span><div class="focus-quote"><strong>${number(source.price)}</strong><span>${escapeHtml(leg.location_context?.location_summary || "CURRENT")}</span></div><div class="status-row">${pill(leg.bias || "—")}${pill(leg.opportunity_state || "PASS")}${pill(leg.direction || "NO DIRECTION")}</div><h1>${escapeHtml(assetRead(symbol, leg, presentation))}</h1><p>${valueOrDash(leg.evidence)}</p></div><div class="focus-action"><span class="eyebrow">CURRENT PERMISSION</span><h2>${escapeHtml(bestForSymbol ? presentation.title : "This instrument is not the best watch")}</h2><p>${valueOrDash(bestForSymbol ? payload?.best_watch?.reason : leg.conflict)}</p><div class="action-references"><div><span>BUYING TRIGGER</span><b>${valueOrDash(leg.trigger)}</b></div><div><span>INVALIDATION</span><b>${valueOrDash(leg.invalidation)}</b></div></div></div></section>
  <div class="focus-body"><article class="focus-panel"><div class="section-heading"><div><span class="eyebrow">PERMISSION CHECKLIST</span><h2>All gates stay independent</h2></div></div>${checklistRow(Boolean(leg.bias && leg.bias !== "TRANSITION"), "Directional context", `Bias is ${leg.bias || "unavailable"}.`, leg.bias || "PENDING")}${checklistRow(setupReady, "Underlying setup", setupReady ? "The stated setup is confirmed." : "The buying trigger has not confirmed.", leg.opportunity_state || "PASS")}${checklistRow(sessionAllowed, "Session gate", sessionAllowed ? "New entries are permitted in this phase." : "New entries are suppressed in this phase.", payload?.session?.phase || "—")}${checklistRow(contractForSymbol, "Contract quality", contractForSymbol ? "A validated Webull candidate is available." : "No qualified contract is attached to this instrument.", contractForSymbol ? "READY" : "WAIT")}<div class="focus-note">A bullish or bearish bias is not a buy signal. The trigger defines setup confirmation; the options desk separately determines whether a contract qualifies.</div></article>
  <article class="focus-panel"><div class="section-heading"><div><span class="eyebrow">EXECUTION MAP</span><h2>What must happen next</h2></div></div>${detailRows([["Setup type", leg.setup_type], ["Buying trigger", leg.trigger], ["No-chase", leg.no_chase], ["Invalidation", leg.invalidation], ["Target 1", leg.target_1], ["Target 2", leg.target_2]])}<div class="detail-group"><small>STRONGEST CONFLICT</small><p>${valueOrDash(leg.conflict)}</p></div></article></div>`;
}

function optionMetric(label, value) {
  return `<div class="metric"><small>${escapeHtml(label)}</small><strong>${valueOrDash(value)}</strong></div>`;
}

function optionCandidateMarkup(candidate) {
  const bid = Number(candidate.bid);
  const ask = Number(candidate.ask);
  const spread = Number.isFinite(bid) && Number.isFinite(ask) ? ask - bid : null;
  const contract = candidate.option_symbol || candidate.contract || "Validated candidate";
  return `<article class="recommendation"><div class="contract-eyebrow-row"><span class="eyebrow">VALIDATED WEBULL CANDIDATE</span>${pill(candidate.option_type || "OPTION")}</div><div class="candidate-heading"><div><h2>${escapeHtml(contract)}</h2><p>${escapeHtml(candidate.underlying_symbol || candidate.symbol || "SPY / QQQ")} · Production source quote</p></div><div class="expiry-badge"><strong>${number(candidate.strike)}</strong><small>${escapeHtml(candidate.expiration || "—")}</small></div></div><div class="quote-primary"><div><small>BID</small><strong>${number(candidate.bid)}</strong><p>Size ${number(candidate.bid_size, 0)}</p></div><div><small>ASK</small><strong>${number(candidate.ask)}</strong><p>Size ${number(candidate.ask_size, 0)}</p></div><div><small>SPREAD</small><strong>${number(spread)}</strong><p>Quote age ${candidate.quote_age_seconds == null ? "—" : `${number(candidate.quote_age_seconds, 1)}s`}</p></div></div><div class="contract-summary-grid">${[["Last", number(candidate.last)], ["Volume", number(candidate.session_volume, 0)], ["Open interest", number(candidate.open_interest, 0)], ["IV", number(candidate.implied_volatility, 4)], ["Delta", number(candidate.delta, 4)], ["Gamma", number(candidate.gamma, 5)], ["Theta", number(candidate.theta, 4)], ["Quote event", dateTime(candidate.quote_event_at)]].map(([label, value]) => optionMetric(label, value)).join("")}</div><div class="contract-explainer"><span class="eyebrow">WHY THIS IS SHOWN</span><p>This candidate was stored with no validation flags and with bid, ask, and source quote time present. The dashboard remains read only and provides no order controls.</p></div></article>`;
}

function optionEmptyMarkup(presentation) {
  return `<article class="option-empty"><span class="eyebrow">OPTION WORKFLOW · ${escapeHtml(presentation.label)}</span><span class="empty-glyph">◇</span><h2>${escapeHtml(presentation.title)}</h2><p>${escapeHtml(presentation.detail)}</p><div class="empty-message"><span>IMPORTANT</span><strong>Market bias and an underlying confirmation never manufacture an option recommendation.</strong></div></article>`;
}

function renderOptions(row, payload, presentation) {
  const best = payload?.best_watch || {};
  const leg = best.symbol ? payload?.[best.symbol.toLowerCase()] : null;
  const main = presentation.candidate ? optionCandidateMarkup(presentation.candidate) : optionEmptyMarkup(presentation);
  $("optionsDesk").innerHTML = `<div class="options-layout">${main}<aside class="options-side"><section class="panel"><span class="eyebrow">THREE SEPARATE QUESTIONS</span><div class="option-step ${presentation.biasReady ? "" : "pending"}"><span class="step-dot">1</span><div><strong>Is there directional context?</strong><small>${presentation.biasReady ? `${best.symbol} ${best.direction}` : "No preferred direction"}</small></div></div><div class="option-step ${presentation.setupReady ? "" : "pending"}"><span class="step-dot">2</span><div><strong>Did the underlying setup confirm?</strong><small>${presentation.setupReady ? "Yes · confirmed" : `${best.state || "PASS"} · not confirmed`}</small></div></div><div class="option-step ${presentation.contractReady ? "" : "pending"}"><span class="step-dot">3</span><div><strong>Did a contract qualify?</strong><small>${presentation.contractReady ? "Yes · candidate available" : "No qualified contract"}</small></div></div></section><section class="panel"><span class="eyebrow">SOURCE BINDING</span>${detailRows([["Analysis as of", dateTime(row?.as_of)], ["Valid until", dateTime(row?.valid_until || payload?.valid_until)], ["Webull quote", dateTime(presentation.candidate?.quote_event_at)], ["Stored option rows", number(currentData?.optionCount, 0)]])}<p class="binding-note">A candidate belongs only to the analysis cycle that selected it. Expired analysis is shown as stale, even if a prior contract remains in storage.</p></section></aside></div><section class="underlying-plan"><div class="section-heading"><div><span class="eyebrow">UNDERLYING PLAN</span><h2>${escapeHtml(best.symbol || "No best watch")} ${escapeHtml(best.direction || "WAIT")}</h2></div>${pill(best.state || "PASS")}</div><div class="underlying-plan-grid">${[["Setup", leg?.setup_type], ["Buying trigger", leg?.trigger], ["No-chase", leg?.no_chase], ["Invalidation", leg?.invalidation], ["Target 1", leg?.target_1], ["Target 2", leg?.target_2], ["Evidence", leg?.evidence], ["Conflict", leg?.conflict]].map(([label, value]) => `<div><small>${escapeHtml(label)}</small><b>${valueOrDash(value)}</b></div>`).join("")}</div></section>`;
}

function renderDetailedFootprint(alias, bar, interpretation, context) {
  if (!bar) return `<div class="detail-group"><small>${alias}</small><p>No completed five-minute bar available.</p></div>`;
  const poc = bar.poc_low == null ? "—" : `${number(bar.poc_low)}–${number(bar.poc_high)}`;
  const contextLine = footprintContext(context);
  return `<div class="detail-group"><small>${alias} · COMPLETED ${dateTime(bar.bar_time)}</small>${contextLine ? `<p>${escapeHtml(contextLine)}</p>` : ""}<div class="detail-grid">${[["Close", number(bar.close)], ["Delta", number(bar.delta, 0)], ["Delta %", bar.delta_pct == null ? "—" : `${number(bar.delta_pct, 1)}%`], ["POC", poc], ["POC migration", number(bar.poc_migration)], ["VAH / VAL", `${number(bar.vah)} / ${number(bar.val)}`], ["Buy imbalances", number(bar.buy_imbalance_count, 0)], ["Sell imbalances", number(bar.sell_imbalance_count, 0)], ["Max buy stack", number(bar.max_buy_stack, 0)], ["Max sell stack", number(bar.max_sell_stack, 0)]].map(([label, value]) => optionMetric(label, value)).join("")}</div><p>${valueOrDash(interpretation)}</p></div>`;
}

function renderHiddenDiagnostics(row, payload, es, mnq) {
  $("esFootprint").innerHTML = renderDetailedFootprint("ES", es, payload?.spy?.footprint_interpretation, payload?.daily_context?.es);
  $("mnqFootprint").innerHTML = renderDetailedFootprint("MNQ", mnq, payload?.qqq?.footprint_interpretation, payload?.daily_context?.mnq);
  const timing = payload?.timing || {};
  $("timing").textContent = JSON.stringify({ scheduled_for: timing.scheduled_for, analysis_started_at: timing.analysis_started_at || row?.analysis_started_at, snapshot_ready_at: timing.snapshot_ready_at, analysis_completed_at: timing.analysis_completed_at || row?.analysis_completed_at, database_written_at: timing.database_written_at || row?.updated_at, total_runtime_seconds: timing.total_runtime_seconds });
  $("modeBadge").textContent = payload?.analysis_mode || "LEGACY";
}

function detailRows(items) {
  return items.map(([label, value]) => `<div class="detail-row"><span>${escapeHtml(label)}</span><b>${valueOrDash(value)}</b></div>`).join("");
}

function drawerMarkup(kind) {
  const row = currentData?.analysis;
  const payload = row?.payload || {};
  const es = latestByTicker(currentData?.footprints, "CME_MINI:ES1!");
  const mnq = latestByTicker(currentData?.footprints, "CME_MINI:MNQ1!");
  const stale = analysisIsStale(row);
  const presentation = optionPresentationState(row, payload, stale);
  if (kind === "health") {
    const timing = payload.timing || {};
    return ["Timing & source health", `<p class="drawer-intro">Exact stored timestamps and source-specific freshness. No source is inferred from another.</p>${stale ? '<div class="detail-alert">The current analysis validity window has expired.</div>' : ""}${detailRows([["Scheduled", dateTime(timing.scheduled_for)], ["Analysis started", dateTime(timing.analysis_started_at || row?.analysis_started_at)], ["Snapshot ready", dateTime(timing.snapshot_ready_at)], ["Model started", dateTime(timing.model_started_at)], ["Analysis completed", dateTime(timing.analysis_completed_at || row?.analysis_completed_at)], ["Database written", dateTime(timing.database_written_at || row?.updated_at)], ["Runtime", timing.total_runtime_seconds == null ? "—" : `${number(timing.total_runtime_seconds, 2)}s`], ["Analysis freshness", payload.freshness_state || (stale ? "STALE" : "FRESH")], ["Webull provider", currentData?.provider?.state], ["Webull heartbeat", dateTime(currentData?.provider?.heartbeat_at)], ["Last valid Webull quote", dateTime(currentData?.provider?.last_valid_source_quote_at)], ["Stored Webull rows", number(currentData?.optionCount, 0)]])}`];
  }
  if (["spy", "qqq"].includes(kind)) {
    const symbol = kind.toUpperCase();
    const leg = payload[kind] || {};
    const context = payload.daily_context?.[kind] || {};
    const levels = keyLevels(context, payload.data_health?.[kind]?.price, leg.location_context);
    return [`${symbol} decision detail`, `<div class="status-row">${pill(leg.bias || "—")}${pill(leg.opportunity_state || "PASS")}${pill(leg.direction || "NO DIRECTION")}</div>${detailRows([["Setup type", leg.setup_type], ["Buying trigger", leg.trigger], ["No-chase", leg.no_chase], ["Invalidation", leg.invalidation], ["Target 1", leg.target_1], ["Target 2", leg.target_2], ["Location", leg.location_context?.location_summary]])}<div class="detail-group"><small>VALIDATED LEVEL MAP</small>${levels.map(([label, value]) => `<div class="detail-row"><span>${escapeHtml(label)}</span><b>${number(value)} ${levelInteraction(leg.location_context, label, value) ? `· ${escapeHtml(levelInteraction(leg.location_context, label, value))}` : ""}</b></div>`).join("") || '<p>No validated levels available.</p>'}</div><div class="detail-group"><small>STRONGEST EVIDENCE</small><p>${valueOrDash(leg.evidence)}</p></div><div class="detail-group"><small>STRONGEST CONFLICT</small><p>${valueOrDash(leg.conflict)}</p></div><div class="detail-group"><small>FOOTPRINT INTERPRETATION</small><p>${valueOrDash(leg.footprint_interpretation)}</p></div>`];
  }
  if (kind === "footprints") return ["Completed futures detail", `<p class="drawer-intro">Completed ES and MNQ five-minute bars confirm participation and timing; they do not replace the higher-timeframe map.</p>${renderDetailedFootprint("ES", es, payload.spy?.footprint_interpretation, payload.daily_context?.es)}${renderDetailedFootprint("MNQ", mnq, payload.qqq?.footprint_interpretation, payload.daily_context?.mnq)}`];
  if (kind === "history") {
    const rows = meaningfulHistory(currentData?.history);
    return ["Meaningful state history", rows.length ? rows.map((item) => `<div class="detail-group"><small>${dateTime(item.as_of)} · ${escapeHtml(item.opportunity_state || "STATE")}</small><p>${escapeHtml(item.payload?.changed || "State changed")}</p></div>`).join("") : '<div class="empty">No meaningful transitions recorded yet.</div>'];
  }
  return ["Options workflow", `<div class="detail-alert">${escapeHtml(presentation.title)} — ${escapeHtml(presentation.detail)}</div>`];
}

function openDrawer(kind, trigger = document.activeElement) {
  if (!currentData) return;
  lastFocusedElement = trigger;
  const [title, body] = drawerMarkup(kind);
  $("drawerTitle").textContent = title;
  $("drawerBody").innerHTML = body;
  $("drawerBackdrop").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  $("drawerClose").focus();
}

function closeDrawer() {
  $("drawerBackdrop").classList.add("hidden");
  document.body.style.overflow = "";
  lastFocusedElement?.focus?.();
}

function render(data) {
  currentData = data;
  const row = data.analysis;
  const payload = row?.payload || {};
  const sources = { spy: payload.data_health?.spy || {}, qqq: payload.data_health?.qqq || {} };
  const es = latestByTicker(data.footprints, "CME_MINI:ES1!");
  const mnq = latestByTicker(data.footprints, "CME_MINI:MNQ1!");
  if (es) es.poc_migration = payload.data_health?.es_footprint?.derived?.poc_migration;
  if (mnq) mnq.poc_migration = payload.data_health?.mnq_footprint?.derived?.poc_migration;
  const closed = row?.session_state === "MARKET_CLOSED" || row?.session_phase === "CLOSED";
  const stale = analysisIsStale(row);
  const presentation = optionPresentationState(row, payload, stale);

  $("headerDate").textContent = ctClock();
  $("headerStatus").textContent = closed ? "MARKET CLOSED" : `${phaseLabel(row)} · ${stale ? "STALE" : "LIVE"}`;
  $("analysisAlert").classList.toggle("hidden", !stale);
  $("analysisAlert").textContent = stale ? `STALE ANALYSIS${closed ? " · MARKET CLOSED" : " · DO NOT TREAT AS CURRENT GUIDANCE"}` : "";

  renderHero(row, payload, presentation, stale);
  $("spyCard").innerHTML = assetBrief("SPY", payload.spy, sources.spy, payload.daily_context?.spy, presentation);
  $("qqqCard").innerHTML = assetBrief("QQQ", payload.qqq, sources.qqq, payload.daily_context?.qqq, presentation);
  positionRangeMarker("SPY", payload.spy, sources.spy);
  positionRangeMarker("QQQ", payload.qqq, sources.qqq);
  renderOptionPresence(presentation);
  renderBest(payload, presentation);
  renderBriefFootprints(es, mnq, payload);
  renderHistory(data.history);
  renderStructure(row, payload, sources, presentation);
  renderHealth(row, data, es, mnq, closed, stale);
  renderFocus(payload, sources, presentation);
  renderOptions(row, payload, presentation);
  renderHiddenDiagnostics(row, payload, es, mnq);
  $("connectionState").textContent = `Updated ${ctClock()} · ${CONFIG.pollIntervalMs / 1000}s polling`;
}

async function refresh() {
  const queries = await Promise.all([
    client.from("intraday_analysis_current").select("*").eq("analysis_key", "SPY_QQQ_0DTE").maybeSingle(),
    client.from("intraday_analysis_history").select("run_id,as_of,session_state,session_phase,opportunity_state,payload,recorded_at").eq("analysis_key", "SPY_QQQ_0DTE").order("recorded_at", { ascending: false }).limit(30),
    client.from("tv_footprint_bars").select("tickerid,bar_time,received_at,close,delta,delta_pct,poc_low,poc_high,vah,val,buy_imbalance_count,sell_imbalance_count,max_buy_stack,max_sell_stack").in("tickerid", ["CME_MINI:ES1!", "CME_MINI:MNQ1!"]).eq("timeframe", "5").order("bar_time", { ascending: false }).limit(12),
    client.from("webull_options_provider_health").select("source,state,heartbeat_at,last_valid_source_quote_at,market_status,batch_complete,error_class").eq("source", "WEBULL_OPENAPI").maybeSingle(),
    client.from("webull_options_latest").select("provider_contract_id", { count: "exact", head: true }).eq("source", "WEBULL_OPENAPI").eq("environment", "production"),
  ]);
  const failure = queries.find((result) => result.error);
  if (failure) {
    $("connectionState").textContent = `Read failed · ${failure.error.message}`;
    return;
  }
  render({ analysis: queries[0].data, history: queries[1].data, footprints: queries[2].data, provider: queries[3].data, optionCount: queries[4].count });
}

$("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("authError").textContent = "";
  const { data, error } = await client.auth.signInWithPassword({ email: $("email").value.trim(), password: $("password").value });
  if (error) {
    $("authError").textContent = "Sign-in failed.";
    return;
  }
  await authorize(data.session);
});

$("signOut").addEventListener("click", async () => {
  await client.auth.signOut();
  showAuth();
});

$("gammaReload").addEventListener("click", () => gammaManager.reloadCurrent());

$("healthButton").addEventListener("click", (event) => openDrawer("health", event.currentTarget));
$("drawerClose").addEventListener("click", closeDrawer);
$("drawerBackdrop").addEventListener("click", (event) => { if (event.target === $("drawerBackdrop")) closeDrawer(); });

document.addEventListener("click", (event) => {
  const viewButton = event.target.closest("[data-view]");
  if (viewButton) setView(viewButton.dataset.view);
  const gammaButton = event.target.closest("[data-gamma-symbol]");
  if (gammaButton && dashboardAuthorized) gammaManager.select(gammaButton.dataset.gammaSymbol);
  const focusButton = event.target.closest("[data-focus]");
  if (focusButton) {
    focusSymbol = focusButton.dataset.focus;
    if (currentData) {
      const payload = currentData.analysis?.payload || {};
      renderFocus(payload, { spy: payload.data_health?.spy || {}, qqq: payload.data_health?.qqq || {} }, optionPresentationState(currentData.analysis, payload));
    }
  }
  const drawerButton = event.target.closest("[data-drawer]");
  if (drawerButton) openDrawer(drawerButton.dataset.drawer, drawerButton);
});

window.addEventListener("hashchange", () => setView(window.location.hash.replace("#", "") || "brief", false));

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("drawerBackdrop").classList.contains("hidden")) closeDrawer();
});

setInterval(() => {
  $("headerDate").textContent = ctClock();
  if (currentData?.analysis) {
    const payload = currentData.analysis.payload || {};
    renderHero(currentData.analysis, payload, optionPresentationState(currentData.analysis, payload), analysisIsStale(currentData.analysis));
  }
}, 1000);

setView(window.location.hash.replace("#", "") || "brief", false);
const { data: { session } } = await client.auth.getSession();
if (!(await authorize(session))) showAuth();
