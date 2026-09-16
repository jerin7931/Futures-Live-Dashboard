import { CONFIG } from "./config.js";
import { ageLabel, analysisIsStale, ctClock, dateTime, footprintContext, healthState, isMeaningfulHistory, keyLevels, levelInteraction, nextExpectedLabel, number, statusClass, timeOnly } from "./core.js";

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "—").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const client = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabasePublishableKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
let pollTimer = null;
let currentAnalysis = null;

function pill(value) { return `<span class="pill ${statusClass(value)}">${escapeHtml(value || "—")}</span>`; }
function valueOrDash(value) { return value === null || value === undefined || value === "" ? "—" : escapeHtml(value); }

function showAuth(message = "") {
  $("dashboard").classList.add("hidden");
  $("authView").classList.remove("hidden");
  $("authError").textContent = message;
  clearInterval(pollTimer);
}

function showDashboard() {
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
  await refresh();
  clearInterval(pollTimer);
  pollTimer = setInterval(refresh, CONFIG.pollIntervalMs);
  return true;
}

function healthBadge(name, state, timestamp) {
  return `<div class="health"><span class="health-name"><i class="dot ${statusClass(state)}"></i>${escapeHtml(name)}</span><span class="health-value"><strong class="${statusClass(state)}">${escapeHtml(state)}</strong><small>${escapeHtml(ageLabel(timestamp))}</small></span></div>`;
}

function tickerCard(symbol, leg, source, context) {
  const levels = [["Trigger", leg?.trigger], ["No-chase", leg?.no_chase], ["Invalidation", leg?.invalidation], ["Target 1", leg?.target_1], ["Target 2", leg?.target_2]];
  const contextLevels = keyLevels(context, source?.price);
  return `<div class="ticker-top"><div class="ticker-symbol"><h2>${symbol}</h2><span class="price">${number(source?.price)}</span></div>${pill(leg?.opportunity_state || "PASS")}</div>
    <div class="state-row"><div class="state-box"><small>BIAS</small><strong class="${statusClass(leg?.bias)}">${valueOrDash(leg?.bias)}</strong></div><div class="state-box"><small>OPPORTUNITY</small><strong>${valueOrDash(leg?.opportunity_state)}</strong></div><div class="state-box"><small>DIRECTION</small><strong>${valueOrDash(leg?.direction)}</strong></div></div>
    <div class="levels">${levels.map(([label, value]) => `<div class="level"><small>${label}</small><strong>${valueOrDash(value)}</strong></div>`).join("")}</div>
    <div class="key-levels-wrap"><small>KEY LEVELS</small><div class="key-levels">${contextLevels.length ? contextLevels.map(([label, value]) => { const interaction = levelInteraction(leg?.location_context, label); return `<div class="key-level${interaction ? " interacting" : ""}"><span>${escapeHtml(label)}</span><strong>${number(value)}</strong>${interaction ? `<em>${escapeHtml(interaction)}</em>` : ""}</div>`; }).join("") : `<div class="empty compact">No validated levels available.</div>`}</div></div>
    <div class="evidence-grid"><div class="evidence"><small>STRONGEST EVIDENCE</small><p>${valueOrDash(leg?.evidence)}</p></div><div class="evidence"><small>STRONGEST CONFLICT</small><p>${valueOrDash(leg?.conflict)}</p></div></div>`;
}

function renderBest(payload) {
  const best = payload?.best_watch || {};
  const leg = best.symbol ? payload?.[best.symbol.toLowerCase()] : null;
  const title = best.symbol && best.direction ? `${best.symbol} ${best.direction}` : "PASS";
  const detail = best.symbol ? valueOrDash(best.reason || "Selected by scheduled analyst.") : "NO CLEAN 0DTE OPPORTUNITY";
  $("bestOpportunity").innerHTML = `<div class="opportunity-lead"><div class="eyebrow">BEST OPPORTUNITY</div><h2>${escapeHtml(title)}</h2><p>${detail}</p></div><div class="opportunity-details">
    ${[["Setup type", leg?.setup_type],["Entry trigger",leg?.trigger],["No-chase",leg?.no_chase],["Invalidation",leg?.invalidation],["Target 1",leg?.target_1],["Target 2",leg?.target_2],["Valid until",dateTime(payload?.valid_until)],["State",best.state || "PASS"]].map(([label,value])=>`<div class="metric"><small>${label}</small><strong>${valueOrDash(value)}</strong></div>`).join("")}</div>`;
}

function renderContract(candidate) {
  const card = $("optionContract");
  if (!candidate) { card.classList.add("hidden"); card.innerHTML = ""; return; }
  card.classList.remove("hidden");
  const metrics = [["Contract",candidate.option_symbol || candidate.contract],["Type",candidate.option_type],["Strike",number(candidate.strike)],["Expiration",candidate.expiration],["Bid × Ask",`${number(candidate.bid)} × ${number(candidate.ask)}`],["Size",`${number(candidate.bid_size,0)} × ${number(candidate.ask_size,0)}`],["Last",number(candidate.last)],["Volume",number(candidate.session_volume,0)],["Open interest",number(candidate.open_interest,0)],["IV",number(candidate.implied_volatility,4)],["Delta",number(candidate.delta,4)],["Gamma",number(candidate.gamma,5)],["Theta",number(candidate.theta,4)],["Quote age",candidate.quote_age_seconds == null ? "—" : `${number(candidate.quote_age_seconds,1)}s`]];
  card.innerHTML = `<div class="section-head"><div><div class="eyebrow">VALIDATED WEBULL CONTRACT</div><h2>${valueOrDash(candidate.option_symbol || candidate.contract)}</h2></div>${pill(candidate.option_type)}</div><div class="contract-grid">${metrics.map(([label,value])=>`<div class="metric"><small>${label}</small><strong>${valueOrDash(value)}</strong></div>`).join("")}</div>`;
}

function renderFootprint(alias, bar, interpretation, context) {
  if (!bar) return `<div class="section-head"><div><div class="eyebrow">TRADINGVIEW FOOTPRINT</div><h2>${alias}</h2></div>${pill("UNAVAILABLE")}</div><div class="empty">No completed five-minute bar available.</div>`;
  const poc = bar.poc_low == null ? "—" : `${number(bar.poc_low)}–${number(bar.poc_high)}`;
  const metrics = [["Close",number(bar.close)],["Delta",number(bar.delta,0)],["Delta %",bar.delta_pct == null?"—":`${number(bar.delta_pct,1)}%`],["POC",poc],["POC migration",number(bar.poc_migration)],["VAH",number(bar.vah)],["VAL",number(bar.val)],["Buy imbalances",number(bar.buy_imbalance_count,0)],["Sell imbalances",number(bar.sell_imbalance_count,0)],["Max buy stack",number(bar.max_buy_stack,0)],["Max sell stack",number(bar.max_sell_stack,0)]];
  const contextLine = footprintContext(context);
  return `<div class="section-head"><div><div class="eyebrow">LATEST COMPLETED 5-MINUTE BAR</div><h2>${alias}</h2></div><span class="micro">${dateTime(bar.bar_time)}</span></div>${contextLine ? `<p class="footprint-context">${escapeHtml(contextLine)}</p>` : ""}<div class="footprint-metrics">${metrics.map(([label,value])=>`<div class="metric"><small>${label}</small><strong>${valueOrDash(value)}</strong></div>`).join("")}</div><p class="footprint-note">${valueOrDash(interpretation)}</p>`;
}

function renderHistory(rows) {
  const meaningful = (rows || []).filter(isMeaningfulHistory).slice(0, 7);
  $("history").innerHTML = meaningful.length ? meaningful.map((row) => `<div class="timeline-row"><time>${timeOnly(row.as_of)}</time><p>${escapeHtml(row.payload?.changed || "State changed")}</p></div>`).join("") : `<div class="empty">No meaningful transitions recorded yet. Unchanged cycles are intentionally suppressed.</div>`;
}

function renderTiming(row) {
  const timing = row?.payload?.timing || {};
  const items = [["Scheduled",dateTime(timing.scheduled_for)],["Started",dateTime(timing.analysis_started_at || row?.analysis_started_at)],["Snapshot ready",dateTime(timing.snapshot_ready_at)],["Model started",dateTime(timing.model_started_at)],["Completed",dateTime(timing.analysis_completed_at || row?.analysis_completed_at)],["Database written",dateTime(timing.database_written_at || row?.updated_at)],["Runtime",timing.total_runtime_seconds == null?"—":`${number(timing.total_runtime_seconds,2)}s`],["Analysis freshness",row?.payload?.freshness_state || (analysisIsStale(row)?"STALE":"FRESH")]];
  $("timing").innerHTML = items.map(([label,value])=>`<div class="timing-item"><span>${label}</span><strong>${valueOrDash(value)}</strong></div>`).join("");
  $("modeBadge").textContent = row?.payload?.analysis_mode || "LEGACY";
}

function latestByTicker(rows, ticker) { return (rows || []).find((row) => row.tickerid === ticker) || null; }

function render(data) {
  const row = data.analysis;
  const payload = row?.payload || {};
  const closed = row?.session_state === "MARKET_CLOSED" || row?.session_phase === "CLOSED";
  currentAnalysis = row;
  $("sessionStatus").textContent = closed ? "MARKET CLOSED" : (row?.session_phase || "UNAVAILABLE");
  $("lastAnalysis").textContent = dateTime(row?.as_of);
  $("nextAnalysis").textContent = nextExpectedLabel();
  const stale = analysisIsStale(row);
  $("analysisAlert").classList.toggle("hidden", !stale);
  $("analysisAlert").textContent = stale ? `STALE ANALYSIS${closed ? " · MARKET CLOSED" : " · DO NOT TREAT AS CURRENT GUIDANCE"}` : "";
  const es = latestByTicker(data.footprints, "CME_MINI:ES1!");
  const mnq = latestByTicker(data.footprints, "CME_MINI:MNQ1!");
  const provider = data.provider;
  const analystState = closed ? "MARKET CLOSED" : (stale ? "STALE" : "LIVE");
  $("healthGrid").innerHTML = [
    healthBadge("ES FOOTPRINT", healthState({ timestamp: es?.received_at || es?.bar_time, closed, thresholdSeconds: CONFIG.footprintFreshSeconds }), es?.received_at || es?.bar_time),
    healthBadge("MNQ FOOTPRINT", healthState({ timestamp: mnq?.received_at || mnq?.bar_time, closed, thresholdSeconds: CONFIG.footprintFreshSeconds }), mnq?.received_at || mnq?.bar_time),
    healthBadge("WEBULL OPTIONS", provider?.state === "MARKET_CLOSED" ? "MARKET CLOSED" : healthState({ timestamp: provider?.heartbeat_at, closed: false, thresholdSeconds: CONFIG.providerFreshSeconds }), provider?.heartbeat_at),
    healthBadge("CODEX ANALYST", analystState, row?.analysis_completed_at),
  ].join("");
  $("spyCard").innerHTML = tickerCard("SPY", payload.spy, payload.data_health?.spy, payload.daily_context?.spy);
  $("qqqCard").innerHTML = tickerCard("QQQ", payload.qqq, payload.data_health?.qqq, payload.daily_context?.qqq);
  renderBest(payload);
  renderContract(payload.contract_candidate);
  const esDerived = payload.data_health?.es_footprint?.derived || {};
  const mnqDerived = payload.data_health?.mnq_footprint?.derived || {};
  if (es) es.poc_migration = esDerived.poc_migration;
  if (mnq) mnq.poc_migration = mnqDerived.poc_migration;
  $("esFootprint").innerHTML = renderFootprint("ES", es, payload.spy?.footprint_interpretation, payload.daily_context?.es);
  $("mnqFootprint").innerHTML = renderFootprint("MNQ", mnq, payload.qqq?.footprint_interpretation, payload.daily_context?.mnq);
  renderHistory(data.history);
  renderTiming(row);
  $("connectionState").textContent = `Updated ${ctClock()} · 12s polling`;
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
  if (failure) { $("connectionState").textContent = `Read failed · ${failure.error.message}`; return; }
  render({ analysis: queries[0].data, history: queries[1].data, footprints: queries[2].data, provider: queries[3].data, optionCount: queries[4].count });
}

$("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault(); $("authError").textContent = "";
  const { data, error } = await client.auth.signInWithPassword({ email: $("email").value.trim(), password: $("password").value });
  if (error) { $("authError").textContent = "Sign-in failed."; return; }
  await authorize(data.session);
});
$("signOut").addEventListener("click", async () => { await client.auth.signOut(); showAuth(); });
setInterval(() => { $("clock").textContent = ctClock(); if (currentAnalysis) $("nextAnalysis").textContent = nextExpectedLabel(); }, 1000);
$("clock").textContent = ctClock();
const { data: { session } } = await client.auth.getSession();
if (!(await authorize(session))) showAuth();
