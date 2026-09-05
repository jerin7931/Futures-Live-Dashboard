(() => {
  "use strict";

  const cfg = window.OPTIONS_COMMAND_CONFIG || {};
  const requireAuth = Boolean(cfg.requireAuth);
  const db = window.supabase?.createClient && cfg.supabaseUrl && cfg.supabasePublishableKey
    ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      })
    : null;

  const state = {
    symbol: "SPY",
    dte: 1,
    paused: false,
    mode: "demo",
    session: null,
    signal: null,
    chain: [],
    flow: {},
    health: null,
    compare: null,
    refreshTimer: null,
    realtime: null,
    spotHistory: [],
    lastPaint: Date.now()
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const num = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const text = (selector, value) => { const node = $(selector); if (node) node.textContent = value; };
  const money = (value) => value == null ? "—" : `$${num(value).toFixed(2)}`;
  const price = (value) => value == null ? "—" : num(value).toFixed(2);
  const whole = (value) => value == null ? "—" : Math.round(num(value)).toLocaleString("en-US");
  const signed = (value, digits = 2) => `${num(value) >= 0 ? "+" : ""}${num(value).toFixed(digits)}`;
  const compact = (value) => {
    const n = num(value);
    if (Math.abs(n) >= 1e6) return `${signed(n / 1e6, 1)}M`;
    if (Math.abs(n) >= 1e3) return `${signed(n / 1e3, 1)}K`;
    return signed(n, 0);
  };
  const ageSeconds = (iso) => iso ? Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000) : Infinity;
  const expirationLabel = (iso) => {
    if (!iso) return "—";
    const date = new Date(`${String(iso).slice(0, 10)}T12:00:00`);
    return date.toLocaleDateString("en-US", { month: "short", day: "2-digit" }).toUpperCase();
  };

  function toast(message) {
    text("#toast", message);
    $("#toast").classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => $("#toast").classList.remove("show"), 2800);
  }

  function setAuthGate(show) {
    if (!requireAuth) return;
    document.documentElement.classList.toggle("auth-gate", show);
    $("#authDialog").classList.toggle("hidden", !show);
    $("#closeAuthButton").classList.toggle("hidden", show);
    if (show) setTimeout(() => $("#loginEmail").focus(), 0);
  }

  function demoDataset(symbol = state.symbol, dte = state.dte) {
    const base = symbol === "SPY" ? 770.18 : 692.42;
    const wave = Math.sin(Date.now() / 18000) * .12;
    const spot = base + wave;
    const anchor = Math.round(spot);
    const expiration = new Date(Date.now() + dte * 86400000).toISOString().slice(0, 10);
    const rows = [];
    for (let strike = anchor - 5; strike <= anchor + 5; strike += 1) {
      const callDelta = Math.max(.08, Math.min(.92, .50 + (spot - strike) * .105));
      const callGamma = Math.max(.018, .056 - Math.abs(spot - strike) * .005);
      for (const optionType of ["CALL", "PUT"]) {
        const intrinsic = optionType === "CALL" ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
        const mark = intrinsic + 1.45 + Math.max(0, 1.1 - Math.abs(spot - strike) * .15);
        rows.push({
          symbol, dte, expiration, option_type: optionType, strike,
          bid: mark - .04, ask: mark + .04, last: mark - .01, mark,
          delta: optionType === "CALL" ? callDelta : callDelta - 1,
          gamma: callGamma, iv: .184 + Math.abs(spot - strike) * .002,
          open_interest: 900 + ((strike * 173) % 1600), volume: 350 + ((strike * 97) % 1200),
          underlying_price: spot, quote_time: new Date().toISOString(), source: "DEMO"
        });
      }
    }
    const selected = rows.filter((row) => row.option_type === "CALL" && Math.abs(row.delta) >= .60 && Math.abs(row.delta) <= .70)
      .sort((a, b) => Math.abs(Math.abs(a.delta) - .65) - Math.abs(Math.abs(b.delta) - .65))[0];
    const flow = {
      ES: { symbol: "ES", cumulative_delta: 12420, delta_1s: 87, book_imbalance: .23, absorption_side: "NONE", absorption_score: .08, flow_score: .61, event_time: new Date().toISOString(), latency: { feature_us: 78 } },
      NQ: { symbol: "NQ", cumulative_delta: 8301, delta_1s: 54, book_imbalance: .29, absorption_side: "BUY", absorption_score: .32, flow_score: .52, event_time: new Date().toISOString(), latency: { feature_us: 81 } }
    };
    const entry = selected?.mark || 3.2;
    const support = anchor - 2;
    const resistance = anchor + 2;
    return {
      chain: rows,
      flow,
      signal: {
        symbol, dte, expiration, as_of: new Date().toISOString(), status: "READY", direction: "CALL",
        contract_symbol: `${symbol} ${expiration} ${selected?.strike || anchor - 1} CALL`,
        strike: selected?.strike || anchor - 1, entry_bid: selected?.bid, entry_ask: selected?.ask,
        entry_mid: entry, target_price: entry * 1.3, target_underlying: spot + 1.9,
        required_underlying_move_pct: 1.9 / spot * 100, delta: selected?.delta, gamma: selected?.gamma,
        iv: selected?.iv, open_interest: selected?.open_interest, volume: selected?.volume,
        spread_pct: 2.1, score: 78, confidence: .78, regime: "DEMO TREND UP",
        model_read: "Demonstration only. Sign in to view the fail-closed paper candidate calculated from the live ES/NQ bridge and current option chain.",
        invalidation: spot - 1.33,
        structure: { spot, vwap_proxy: spot - 1.33, support, support_source: "demo put OI", resistance, resistance_source: "demo call OI", recent_high: resistance + 1.2, recent_low: support - .7 },
        orderflow: flow.ES,
        latency: { option_source_ms: 228, feature_us: 78, flow_age_ms: 26, supabase_write_ms: 41 }
      }
    };
  }

  function setMode(mode, note = "") {
    state.mode = mode;
    const live = mode === "live";
    const stale = mode === "stale";
    $("#feedState").className = `feed-state ${live ? "" : stale ? "stale" : "demo"}`.trim();
    text("#feedStateLabel", live ? "LIVE PAPER" : stale ? "DATA STALE" : "DEMO MODE");
    text("#dataModeLabel", live ? "Live decision support · no orders are transmitted" : stale ? "Live session · upstream data is stale" : "Demo fallback · no orders are transmitted");
    text("#environmentLabel", live || stale ? "Private live workspace" : "Paper decision support");
    text("#footerChannel", live ? "SUPABASE REALTIME · PAPER" : stale ? "STALE · PAPER" : "LOCAL FALLBACK · PAPER");
    text("#connectButton", state.session ? "Sign out" : "Connect live");
    if (note) text("#connectionNote", note);
  }

  function setTone(node, value) {
    node?.classList.toggle("positive", num(value) > 0);
    node?.classList.toggle("negative", num(value) < 0);
  }

  function renderSignal() {
    const signal = state.signal;
    if (!signal) return;
    const ready = signal.status === "READY";
    const direction = ready ? signal.direction : "NONE";
    const spot = num(signal.structure?.spot || state.chain[0]?.underlying_price);
    const badge = $("#signalBadge");
    badge.classList.toggle("waiting", ["WAITING", "STALE"].includes(signal.status));
    badge.classList.toggle("no-trade", signal.status === "NO_TRADE");
    text("#signalLabel", ready ? `LONG ${direction}` : signal.status.replace("_", " "));
    text("#signalConfidence", ready ? `${Math.round(num(signal.confidence) * 100)}% CONVICTION` : "FAIL-CLOSED");
    text("#contractSymbol", signal.symbol);
    text("#contractStrike", ready ? num(signal.strike).toFixed(Number.isInteger(num(signal.strike)) ? 0 : 1) : "—");
    text("#contractSide", ready ? direction : "NO CONTRACT");
    text("#contractExpiry", `${expirationLabel(signal.expiration)} · ${signal.dte}DTE`);
    text("#entryPrice", ready ? money(signal.entry_mid) : "—");
    text("#bidAsk", ready ? `${price(signal.entry_bid)} × ${price(signal.entry_ask)}` : "pricing withheld");
    text("#targetPrice", ready ? money(signal.target_price) : "—");
    text("#targetMove", ready ? `${signal.symbol} ≈ ${price(signal.target_underlying)}` : "requires a valid contract");
    text("#metricDelta", ready ? num(signal.delta).toFixed(4) : "—");
    text("#metricGamma", ready ? num(signal.gamma).toFixed(4) : "—");
    text("#metricSpread", ready ? `${num(signal.spread_pct).toFixed(1)}%` : "—");
    text("#metricLiquidity", ready ? (num(signal.open_interest) >= 1000 && num(signal.volume) >= 500 ? "A" : "B") : "—");
    text("#metricOiVol", ready ? `OI ${whole(signal.open_interest)} · Vol ${whole(signal.volume)}` : "No eligible candidate");
    text("#metricMove", ready ? `${direction === "PUT" ? "−" : "+"}${num(signal.required_underlying_move_pct).toFixed(2)}%` : "—");
    text("#modelRead", signal.model_read || "No model explanation is available.");
    text("#invalidationPrice", ready && signal.invalidation != null ? `${signal.symbol} ${direction === "CALL" ? "<" : ">"} ${price(signal.invalidation)}` : "Not armed");
    text("#spotPrice", price(spot));
    text("#spyRibbonPrice", signal.symbol === "SPY" ? money(spot) : $("#spyRibbonPrice").textContent);
    text("#regimeText", signal.regime || signal.status);
    text("#volatilityText", signal.iv == null ? "WAITING" : `${(num(signal.iv) * 100).toFixed(1)}% IV`);
    text("#spotChange", state.mode === "demo" ? "+0.42%" : "LIVE");
    text("#chainSymbol", signal.symbol);
    text("#chainExpiry", expirationLabel(signal.expiration));
    text("#chartHeading", `${signal.symbol} · recent spot trace`);
    text("#chartPriceLabel", price(spot));
    if (spot) {
      const last = state.spotHistory.at(-1);
      if (!last || Math.abs(last - spot) > 0.00001) state.spotHistory.push(spot);
      state.spotHistory = state.spotHistory.slice(-90);
    }
    renderStructure(signal.structure || {}, spot);
    renderLatency(signal);
    drawChart();
  }

  function renderStructure(structure, spot) {
    const vwap = structure.vwap_proxy;
    const support = structure.support ?? structure.recent_low;
    const resistance = structure.resistance ?? structure.recent_high;
    text("#mapSpot", price(spot));
    text("#r1Level", price(resistance));
    text("#r2Level", price(structure.recent_high ?? resistance));
    text("#s1Level", price(vwap ?? support));
    text("#s2Level", price(structure.recent_low ?? support));
    text("#vwapState", vwap == null ? "VWAP proxy waiting" : `${spot >= num(vwap) ? "Above" : "Below"} proxy VWAP`);
    text("#supportSource", structure.support_source || "Support waiting");
    text("#resistanceDistance", resistance == null ? "Resistance waiting" : `${Math.abs(num(resistance) - spot).toFixed(2)} pts to R1`);
  }

  function renderFlow() {
    const es = state.flow.ES || {};
    const nq = state.flow.NQ || {};
    text("#esCumulativeDelta", es.cumulative_delta == null ? "—" : compact(es.cumulative_delta));
    text("#esDeltaNote", num(es.cumulative_delta) > 0 ? "buyers in control" : num(es.cumulative_delta) < 0 ? "sellers in control" : "balanced");
    text("#nqBookImbalance", nq.book_imbalance == null ? "—" : signed(nq.book_imbalance, 2));
    const absorption = es.absorption_side && es.absorption_side !== "NONE" ? es : nq;
    text("#absorptionLabel", `${absorption.symbol || "ES"} absorption`);
    text("#absorptionValue", absorption.absorption_side || "NONE");
    text("#absorptionNote", `${Math.round(num(absorption.absorption_score) * 100)}% score`);
    const alignment = (num(es.flow_score) + num(nq.flow_score)) / 2;
    text("#flowAlignment", signed(alignment, 2));
    text("#flowAlignmentNote", Math.abs(alignment) < .15 ? "mixed / no edge" : alignment > 0 ? "supports calls" : "supports puts");
    [$("#esCumulativeDelta"), $("#nqBookImbalance"), $("#flowAlignment")].forEach((node) => setTone(node, num(node?.textContent?.replace(/[+KM]/g, ""))));
  }

  function renderLatency(signal) {
    const latency = signal.latency || {};
    const bridge = num(latency.flow_age_ms, num((state.flow.ES || {}).latency?.event_to_bridge_ms));
    const featureMs = num(latency.feature_us) / 1000;
    const push = latency.supabase_write_ms == null ? null : num(latency.supabase_write_ms);
    const source = num(latency.option_source_ms);
    const total = bridge + featureMs + (push || 0);
    text("#totalLatency", total ? `${total.toFixed(total < 10 ? 1 : 0)} ms*` : "—");
    text("#ingestLatency", bridge ? `${bridge.toFixed(1)} ms` : "—");
    text("#featureLatency", featureMs ? `${featureMs.toFixed(3)} ms` : "—");
    text("#modelLatency", latency.ollama_async ? "ASYNC" : "OFF HOT PATH");
    text("#supabaseLatency", push == null ? "—" : `${push.toFixed(1)} ms`);
    $("#ingestLatencyBar").style.width = `${Math.min(100, bridge / 3)}%`;
    $("#featureLatencyBar").style.width = `${Math.min(100, featureMs * 20)}%`;
    $("#supabaseLatencyBar").style.width = `${Math.min(100, (push || 0) / 3)}%`;
    const age = ageSeconds(signal.as_of);
    text("#cycleAge", Number.isFinite(age) ? `${age.toFixed(1)}s` : "—");
    text("#systemHealthText", state.mode === "demo" ? "Demo pipeline active" : state.mode === "live" ? "Live paper pipeline active" : "Pipeline waiting for fresh data");
    text("#quoteAge", state.mode === "demo" ? "local fallback" : `${age.toFixed(1)}s signal · option fetch ${source.toFixed(0)}ms`);
  }

  function renderChain() {
    const grouped = new Map();
    for (const row of state.chain) {
      const key = num(row.strike);
      if (!grouped.has(key)) grouped.set(key, {});
      grouped.get(key)[row.option_type] = row;
    }
    const selectedStrike = state.compare?.strike ?? state.signal?.strike;
    const selectedSide = state.compare?.side ?? state.signal?.direction;
    const filter = $("#deltaFilter").checked;
    const body = $("#chainBody");
    body.replaceChildren();
    [...grouped.entries()].sort((a, b) => a[0] - b[0]).forEach(([strike, pair]) => {
      const call = pair.CALL || {};
      const put = pair.PUT || {};
      const callEligible = call.delta != null && Math.abs(num(call.delta)) >= .60 && Math.abs(num(call.delta)) <= .70;
      const putEligible = put.delta != null && Math.abs(num(put.delta)) >= .60 && Math.abs(num(put.delta)) <= .70;
      if (filter && !callEligible && !putEligible) return;
      const tr = document.createElement("tr");
      if (num(selectedStrike, NaN) === strike) tr.classList.add("selected");
      const cells = [
        pickCell("CALL", strike, selectedSide === "CALL" && num(selectedStrike) === strike),
        cell(price(call.mark), callEligible), cell(call.delta == null ? "—" : num(call.delta).toFixed(3), callEligible),
        cell(call.gamma == null ? "—" : num(call.gamma).toFixed(4)), cell(call.iv == null ? "—" : `${(num(call.iv) * 100).toFixed(1)}%`),
        cell(whole(call.volume)), cell(whole(call.open_interest)), cell(num(strike).toFixed(Number.isInteger(strike) ? 0 : 1), false, "strike"),
        cell(whole(put.open_interest)), cell(whole(put.volume)), cell(put.iv == null ? "—" : `${(num(put.iv) * 100).toFixed(1)}%`),
        cell(put.gamma == null ? "—" : num(put.gamma).toFixed(4)), cell(put.delta == null ? "—" : num(put.delta).toFixed(3), putEligible),
        cell(price(put.mark), putEligible), pickCell("PUT", strike, selectedSide === "PUT" && num(selectedStrike) === strike)
      ];
      cells.forEach((node) => tr.append(node));
      body.append(tr);
    });
    text("#chainSource", state.mode === "demo" ? "Simulated fallback · sign in for OptionChainLive test data" : "OptionChainLive test adapter · 30-second source cadence");
  }

  function cell(value, eligible = false, className = "") {
    const td = document.createElement("td");
    td.textContent = value;
    if (eligible) td.classList.add("eligible");
    if (className) td.classList.add(className);
    return td;
  }

  function pickCell(side, strike, active) {
    const td = document.createElement("td");
    const button = document.createElement("button");
    button.type = "button";
    button.className = `pick-button ${side === "PUT" ? "put" : ""} ${active ? "active" : ""}`;
    button.textContent = active ? "✓" : "+";
    button.title = `Compare ${strike} ${side}`;
    button.addEventListener("click", () => {
      state.compare = { side, strike };
      renderChain();
      toast("Comparison highlight only—the engine's paper candidate is unchanged.");
    });
    td.append(button);
    return td;
  }

  function drawChart() {
    const canvas = $("#marketChart");
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
    const ctx = canvas.getContext("2d");
    ctx.scale(ratio, ratio);
    const w = rect.width, h = rect.height, pad = 12;
    ctx.strokeStyle = "rgba(119,139,157,.12)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 5; i += 1) { ctx.beginPath(); ctx.moveTo(0, h * i / 5); ctx.lineTo(w, h * i / 5); ctx.stroke(); }
    let values = state.spotHistory;
    if (values.length < 3) {
      const spot = num(state.signal?.structure?.spot, 1);
      values = Array.from({ length: 50 }, (_, i) => spot + Math.sin(i / 6) * spot * .0004 + i * spot * .000004);
    }
    const vwap = num(state.signal?.structure?.vwap_proxy, values[0]);
    const target = num(state.signal?.target_underlying, values.at(-1));
    const min = Math.min(...values, vwap, target), max = Math.max(...values, vwap, target);
    const range = Math.max(.01, max - min);
    const y = (v) => pad + (max - v) / range * (h - pad * 2);
    const line = (level, color, dash = []) => { ctx.setLineDash(dash); ctx.strokeStyle = color; ctx.beginPath(); ctx.moveTo(0, y(level)); ctx.lineTo(w, y(level)); ctx.stroke(); ctx.setLineDash([]); };
    line(vwap, "rgba(169,150,255,.7)", [5, 5]);
    if (state.signal?.status === "READY") line(target, "rgba(51,211,156,.55)", [3, 6]);
    const gradient = ctx.createLinearGradient(0, 0, w, 0); gradient.addColorStop(0, "#43c7e8"); gradient.addColorStop(1, "#33d39c");
    ctx.strokeStyle = gradient; ctx.lineWidth = 2; ctx.beginPath();
    values.forEach((value, i) => { const x = i / Math.max(1, values.length - 1) * w; if (!i) ctx.moveTo(x, y(value)); else ctx.lineTo(x, y(value)); });
    ctx.stroke();
  }

  function paint() {
    if (state.paused) return;
    renderSignal();
    renderFlow();
    renderChain();
    state.lastPaint = Date.now();
  }

  function loadDemo() {
    const demo = demoDataset();
    state.signal = demo.signal;
    state.chain = demo.chain;
    state.flow = demo.flow;
    state.compare = null;
    setMode("demo", "Demo values. Sign in to read the ES/NQ NinjaTrader bridge.");
    paint();
  }

  async function verifyReader(user) {
    const { data, error } = await db.from("dashboard_readers").select("user_id").eq("user_id", user.id).maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("This account is not authorized for the private dashboard.");
  }

  async function fetchLive({ quiet = false } = {}) {
    if (!db || !state.session || state.paused) return;
    const symbol = state.symbol, dte = state.dte;
    const [signalRes, flowRes, healthRes] = await Promise.all([
      db.from("options_signal_live").select("*").eq("symbol", symbol).eq("dte", dte).maybeSingle(),
      db.from("futures_orderflow_live").select("*").in("symbol", ["ES", "NQ"]),
      db.from("service_health").select("*").eq("service", "options_signal_engine").maybeSingle()
    ]);
    const firstError = signalRes.error || flowRes.error || healthRes.error;
    if (firstError) throw firstError;
    const signal = signalRes.data;
    let chainRes = { data: [], error: null };
    if (signal?.expiration) {
      chainRes = await db.from("options_chain_live").select("*").eq("symbol", symbol).eq("dte", dte).eq("expiration", signal.expiration).order("strike");
    }
    if (chainRes.error) throw chainRes.error;
    if (!signal) {
      setMode("stale", "The service has not published this symbol/DTE combination yet.");
      if (!quiet) toast("Live session connected; waiting for the first signal cycle.");
      return;
    }
    state.signal = signal;
    state.chain = chainRes.data || [];
    state.flow = Object.fromEntries((flowRes.data || []).map((row) => [row.symbol, row]));
    state.health = healthRes.data;
    state.compare = null;
    const freshestFlow = Math.min(...Object.values(state.flow).map((row) => ageSeconds(row.event_time)), Infinity);
    const stale = freshestFlow > num(cfg.staleFlowSeconds, 2) || ageSeconds(signal.as_of) > Math.max(3, num(cfg.staleFlowSeconds, 2) * 2);
    const note = stale
      ? "Connected, but the decision engine is fail-closed until fresh NinjaTrader ES/NQ snapshots arrive."
      : `Live ${Object.keys(state.flow).sort().join(" + ")} order flow · ${state.health?.message || "paper signal engine"}`;
    setMode(stale ? "stale" : "live", note);
    paint();
  }

  function scheduleFetch() {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(() => fetchLive({ quiet: true }).catch(handleLiveError), 120);
  }

  function handleLiveError(error) {
    console.error(error);
    setMode("stale", "Live session connected, but a protected data query failed.");
    toast(`Live data unavailable: ${error.message || error}`);
  }

  async function subscribeRealtime() {
    if (state.realtime) await db.removeChannel(state.realtime);
    state.realtime = db.channel("options-command-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "options_signal_live" }, scheduleFetch)
      .on("postgres_changes", { event: "*", schema: "public", table: "futures_orderflow_live" }, scheduleFetch)
      .on("postgres_changes", { event: "*", schema: "public", table: "options_chain_live" }, scheduleFetch)
      .subscribe();
  }

  async function connectSession(session) {
    state.session = session;
    await verifyReader(session.user);
    await subscribeRealtime();
    await fetchLive();
    setAuthGate(false);
    $("#authDialog").classList.add("hidden");
  }

  function wireEvents() {
    $$('[data-symbol]').forEach((button) => button.addEventListener("click", () => {
      state.symbol = button.dataset.symbol;
      $$('[data-symbol]').forEach((node) => node.classList.toggle("active", node === button));
      state.spotHistory = []; state.compare = null;
      state.session ? fetchLive().catch(handleLiveError) : loadDemo();
    }));
    $$('[data-dte]').forEach((button) => button.addEventListener("click", () => {
      state.dte = Number(button.dataset.dte);
      $$('[data-dte]').forEach((node) => node.classList.toggle("active", node === button));
      state.compare = null;
      state.session ? fetchLive().catch(handleLiveError) : loadDemo();
    }));
    $("#connectButton").addEventListener("click", async () => {
      if (state.session && db) {
        await db.auth.signOut();
        state.session = null;
        if (state.realtime) await db.removeChannel(state.realtime);
        loadDemo();
        setAuthGate(true);
        toast("Signed out. Demo fallback restored.");
      } else {
        $("#authDialog").classList.remove("hidden");
        $("#loginEmail").focus();
      }
    });
    $("#closeAuthButton").addEventListener("click", () => { if (!requireAuth) $("#authDialog").classList.add("hidden"); });
    $("#authDialog").addEventListener("click", (event) => { if (!requireAuth && event.target === $("#authDialog")) $("#authDialog").classList.add("hidden"); });
    $("#loginForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      text("#loginError", "");
      if (!db) { text("#loginError", "Live client failed to load. Check the network connection."); return; }
      const submit = event.currentTarget.querySelector('[type="submit"]');
      submit.disabled = true;
      try {
        const { data, error } = await db.auth.signInWithPassword({ email: $("#loginEmail").value, password: $("#loginPassword").value });
        if (error) throw error;
        await connectSession(data.session);
      } catch (error) {
        if (state.session) await db.auth.signOut();
        state.session = null;
        text("#loginError", error.message || "Sign in failed.");
      } finally { submit.disabled = false; }
    });
    $("#pauseButton").addEventListener("click", () => {
      state.paused = !state.paused;
      $("#pauseButton").classList.toggle("active", state.paused);
      toast(state.paused ? "Display paused; the backend continues running." : "Display resumed.");
      if (!state.paused) state.session ? fetchLive().catch(handleLiveError) : loadDemo();
    });
    $("#refreshButton").addEventListener("click", () => state.session ? fetchLive().catch(handleLiveError) : loadDemo());
    $("#chainRefresh").addEventListener("click", () => state.session ? fetchLive().catch(handleLiveError) : loadDemo());
    $("#deltaFilter").addEventListener("change", renderChain);
    window.addEventListener("resize", drawChart);
  }

  function updateClock() {
    text("#marketClock", new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date()) + " CT");
    if (!state.session && !state.paused && Date.now() - state.lastPaint > 4500) loadDemo();
    if (state.session && state.signal) renderLatency(state.signal);
  }

  async function init() {
    wireEvents();
    loadDemo();
    setAuthGate(requireAuth);
    updateClock();
    setInterval(updateClock, 1000);
    setInterval(() => state.session && fetchLive({ quiet: true }).catch(handleLiveError), num(cfg.safetyPollSeconds, 15) * 1000);
    if (!db) {
      text("#loginError", "Live client failed to load. Check the network connection.");
      return;
    }
    const { data } = await db.auth.getSession();
    if (data.session) {
      try { await connectSession(data.session); }
      catch (error) {
        await db.auth.signOut(); state.session = null; loadDemo(); setAuthGate(true);
        text("#loginError", error.message || "This session is not authorized for the private dashboard.");
      }
    }
  }

  init().catch((error) => { console.error(error); loadDemo(); });
})();
