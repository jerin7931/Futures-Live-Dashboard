// V26_3_4_LIGHT_CHART_EXECUTION_CONTEXT
// V26_3_3_DIRECTIONAL_CONFLUENCE_DISPLAY
(() => {
  "use strict";

  const cfg = window.DASHBOARD_CONFIG || {};

  if (
    !cfg.supabaseUrl ||
    !cfg.supabasePublishableKey ||
    cfg.supabaseUrl.includes("PASTE_") ||
    cfg.supabasePublishableKey.includes("PASTE_")
  ) {
    document.body.innerHTML = `
      <div class="auth-shell">
        <div class="auth-card">
          <div class="brand-mark">FM</div>
          <h1>Configuration required</h1>
          <p class="muted">
            Edit <strong>config.js</strong> and add your Supabase Project URL
            plus the <strong>publishable</strong> key.
          </p>
        </div>
      </div>
    `;
    return;
  }

  const client = window.supabase.createClient(
    cfg.supabaseUrl,
    cfg.supabasePublishableKey,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    }
  );

  const state = {
    session: null,
    latest: null,
    selected: null,
    daySnapshots: [],
    outcomes: [],
    activeTab: "live",
    marketFilter: "all",
    charts: {},
    realtimeChannel: null,
    refreshTimer: null,
    dates: [],
    activeTrade: null,
    activeTradeLoaded: false,
    liveBars: {},
    liveFootprints: {},
    liveMarketChannel: null,
    liveFeedAvailable: false,
    liveFeedError: null,
    entrySignals: {},
    entrySignalChannel: null,
    entrySignalError: null,
  };

  const $ = (id) => document.getElementById(id);
  const $$ = (selector) => [...document.querySelectorAll(selector)];

  // PHASE4D_ORDERFLOW_WEB_V2 — read-only bridge
  // The Order Flow renderer receives the same state object as the main app.
  // Exposing the authenticated client also lets it re-fetch ONLY the current
  // row if a browser/state synchronization issue leaves orderflow unavailable.
  window.FM_ORDERFLOW_STATE = state;
  window.FM_ORDERFLOW_CLIENT = client;

  function normalizeJsonObject(value) {
    if (!value) return null;

    if (typeof value === "object") {
      return value;
    }

    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" ? parsed : null;
      } catch (_error) {
        return null;
      }
    }

    return null;
  }

  function normalizeSnapshot(row) {
    if (!row || typeof row !== "object") return row;

    // Canonical database column is "orderflow".
    // Keep tolerant aliases for older/test deployments.
    const rawOrderflow =
      row.orderflow ??
      row.order_flow ??
      row.orderFlow ??
      null;

    const normalizedOrderflow = normalizeJsonObject(rawOrderflow);

    if (normalizedOrderflow) {
      row.orderflow = normalizedOrderflow;
    }

    const normalizedSupplyDemand = normalizeJsonObject(
      row.supply_demand ?? row.supplyDemand ?? null
    );

    if (normalizedSupplyDemand) {
      row.supply_demand = normalizedSupplyDemand;
    }

    const normalizedOptionsFlow0dte = normalizeJsonObject(
      row.options_flow_0dte ?? row.optionsFlow0dte ?? null
    );

    if (normalizedOptionsFlow0dte) {
      row.options_flow_0dte = normalizedOptionsFlow0dte;
    }

    return row;
  }

  function notifyOrderflowState(reason = "state-update") {
    window.dispatchEvent(
      new CustomEvent("fm-orderflow-state-updated", {
        detail: {
          reason,
          latestId: state.latest?.id ?? null,
          selectedId: state.selected?.id ?? null,
        },
      })
    );
  }

  function esc(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function fmt(value, digits = 2) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) {
      return "N/A";
    }
    return Number(value).toFixed(digits);
  }

  function fmtSigned(value, digits = 2) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) {
      return "N/A";
    }
    const n = Number(value);
    return `${n > 0 ? "+" : ""}${n.toFixed(digits)}`;
  }

  function formatMoney(value, digits = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    const sign = n > 0 ? "+" : n < 0 ? "-" : "";
    return `${sign}$${Math.abs(n).toFixed(digits)}`;
  }

  function fmtGex(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) {
      return "N/A";
    }
    const n = Number(value);
    const sign = n > 0 ? "+" : "";
    if (Math.abs(n) >= 1000) return `${sign}${(n / 1000).toFixed(2)}B`;
    return `${sign}${n.toFixed(1)}M`;
  }

  function localDateTime(value) {
    if (!value) return "—";
    return new Intl.DateTimeFormat("en-US", {
      timeZone: cfg.timezone || "America/Chicago",
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(value));
  }

  function localTime(value) {
    if (!value) return "—";
    return new Intl.DateTimeFormat("en-US", {
      timeZone: cfg.timezone || "America/Chicago",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(value));
  }

  function biasClass(value) {
    const v = String(value || "").toUpperCase();
    if (v.includes("BULL") || v === "LONG") return "positive";
    if (v.includes("BEAR") || v === "SHORT") return "negative";
    return "neutral";
  }

  function confidenceClass(value) {
    const v = String(value || "").toUpperCase();
    if (v === "VERY_HIGH" || v === "HIGH") return "bad";
    if (v === "MODERATE") return "warn";
    return "muted";
  }

  function shortBias(value) {
    const map = {
      STRONG_BULLISH: "STR BULL",
      BULLISH: "BULL",
      NEUTRAL_MIXED: "MIXED",
      MIXED_NEUTRAL: "MIXED",
      NEUTRAL: "MIXED",
      BEARISH: "BEAR",
      STRONG_BEARISH: "STR BEAR",
      INSUFFICIENT_HISTORY: "NO HIST",
    };
    return map[value] || String(value || "N/A").replaceAll("_", " ");
  }

  function reactionShort(value) {
    const map = {
      UPSIDE_ACCELERATION_IF_ACCEPTED: "Acceleration if accepted",
      DOWNSIDE_ACCELERATION_IF_ACCEPTED: "Acceleration if accepted",
      UPSIDE_BRAKE_RESISTANCE: "Brake / resistance",
      DOWNSIDE_BRAKE_SUPPORT: "Brake / support",
      ACTIVE_NEGATIVE_GEX_INSTABILITY: "Active instability",
    };
    return map[value] || String(value || "N/A").replaceAll("_", " ");
  }

  function priorityRank(value) {
    return { VERY_HIGH: 4, HIGH: 3, MODERATE: 2, LOW: 1 }[value] || 0;
  }

  function toast(message) {
    const node = $("toast");
    node.textContent = message;
    node.classList.remove("hidden");
    clearTimeout(node._timer);
    node._timer = setTimeout(() => node.classList.add("hidden"), 2600);
  }

  function showLogin() {
    $("loginView").classList.remove("hidden");
    $("appView").classList.add("hidden");
  }

  function showApp() {
    $("loginView").classList.add("hidden");
    $("appView").classList.remove("hidden");
  }

  async function signIn(email, password) {
    const { data, error } = await client.auth.signInWithPassword({
      email,
      password,
    });
    if (error) throw error;
    return data;
  }

  async function initAuth() {
    const { data } = await client.auth.getSession();
    state.session = data.session;

    client.auth.onAuthStateChange((_event, session) => {
      state.session = session;
      if (session) {
        showApp();
      } else {
        showLogin();
      }
    });

    if (state.session) {
      showApp();
      await startDashboard();
    } else {
      showLogin();
    }
  }


  // ==========================================================
  // V21.1 LIVE MARKET LAYER
  // ==========================================================
  // Live 1m bars update price / trade management between model cycles.
  // The production model itself remains based on saved confirmed snapshots.
  // ==========================================================

  const LIVE_PRICE_SYMBOLS = ["MES", "MNQ", "SPX", "SPY", "QQQ"];
  const LIVE_PRICE_MAX_AGE_MINUTES = 3.25;
  const LIVE_FOOTPRINT_MAX_AGE_MINUTES = 3.25;

  function liveRowAgeMinutes(row) {
    if (!row) return null;
    const timeMs = Number(row.bar_close_ms || row.bar_open_ms);
    const receivedMs = Date.parse(row.received_at || "");
    const basis = Number.isFinite(timeMs)
      ? timeMs
      : Number.isFinite(receivedMs)
        ? receivedMs
        : null;
    if (!Number.isFinite(basis)) return null;
    return Math.max(0, (Date.now() - basis) / 60000);
  }

  function liveRowFresh(row, maxAgeMinutes) {
    const age = liveRowAgeMinutes(row);
    return Number.isFinite(age) && age <= maxAgeMinutes;
  }

  function applyLiveBarRow(row) {
    if (!row || row.data_type !== "ohlcv" || row.timeframe !== "1m") return false;
    const symbol = String(row.symbol || "").toUpperCase();
    if (!LIVE_PRICE_SYMBOLS.includes(symbol)) return false;
    const previous = state.liveBars[symbol];
    if (!previous || Number(row.bar_open_ms) >= Number(previous.bar_open_ms)) {
      state.liveBars[symbol] = row;
      return true;
    }
    return false;
  }

  function applyLiveFootprintRow(row) {
    if (!row || row.data_type !== "footprint" || row.timeframe !== "1m") return false;
    const symbol = String(row.symbol || "").toUpperCase();
    if (!["ES", "NQ"].includes(symbol)) return false;
    const previous = state.liveFootprints[symbol];
    if (!previous || Number(row.bar_open_ms) >= Number(previous.bar_open_ms)) {
      state.liveFootprints[symbol] = row;
      return true;
    }
    return false;
  }

  function livePriceState(symbol, fallbackPrice = null) {
    const key = String(symbol || "").toUpperCase();
    const row = state.liveBars[key] || null;
    const close = Number(row?.payload?.close);
    const ageMinutes = liveRowAgeMinutes(row);
    const fresh = Number.isFinite(close) && liveRowFresh(row, LIVE_PRICE_MAX_AGE_MINUTES);
    if (fresh) {
      return {
        price: close,
        fresh: true,
        ageMinutes,
        source: `${key} TradingView completed 1m`,
        bar: row,
      };
    }
    const fallback = Number(fallbackPrice);
    return {
      price: Number.isFinite(fallback) ? fallback : null,
      fresh: false,
      ageMinutes,
      source: Number.isFinite(fallback) ? "model snapshot fallback" : "price unavailable",
      bar: row,
    };
  }

  function liveFootprintState(symbol) {
    const key = String(symbol || "").toUpperCase();
    const row = state.liveFootprints[key] || null;
    const p = row?.payload || {};
    const ageMinutes = liveRowAgeMinutes(row);
    const fresh = liveRowFresh(row, LIVE_FOOTPRINT_MAX_AGE_MINUTES);
    return {
      symbol: key,
      row,
      fresh,
      ageMinutes,
      price: Number.isFinite(Number(p.close)) ? Number(p.close) : null,
      delta: Number.isFinite(Number(p.FP_Delta)) ? Number(p.FP_Delta) : null,
      deltaPct: Number.isFinite(Number(p.FP_Delta_Pct)) ? Number(p.FP_Delta_Pct) : null,
      poc: Number.isFinite(Number(p.FP_POC_Price)) ? Number(p.FP_POC_Price) : null,
      maxBuyStack: Number.isFinite(Number(p.FP_Max_Buy_Stack)) ? Number(p.FP_Max_Buy_Stack) : null,
      maxSellStack: Number.isFinite(Number(p.FP_Max_Sell_Stack)) ? Number(p.FP_Max_Sell_Stack) : null,
    };
  }

  async function fetchLiveMarket() {
    try {
      const [pricesResult, footprintResult] = await Promise.all([
        client
          .from("tv_market_bars")
          .select("data_type,symbol,timeframe,bar_open_ms,bar_close_ms,payload,received_at")
          .eq("data_type", "ohlcv")
          .eq("timeframe", "1m")
          .in("symbol", LIVE_PRICE_SYMBOLS)
          .order("bar_open_ms", { ascending: false })
          .limit(150),
        client
          .from("tv_market_bars")
          .select("data_type,symbol,timeframe,bar_open_ms,bar_close_ms,payload,received_at")
          .eq("data_type", "footprint")
          .eq("timeframe", "1m")
          .in("symbol", ["ES", "NQ"])
          .order("bar_open_ms", { ascending: false })
          .limit(80),
      ]);

      if (pricesResult.error) throw pricesResult.error;
      if (footprintResult.error) throw footprintResult.error;

      (pricesResult.data || []).forEach(applyLiveBarRow);
      (footprintResult.data || []).forEach(applyLiveFootprintRow);
      state.liveFeedAvailable = true;
      state.liveFeedError = null;
    }
    catch (error) {
      state.liveFeedAvailable = false;
      state.liveFeedError = error?.message || String(error);
      console.warn("Live TradingView feed unavailable; snapshot fallback remains active:", error);
    }

    renderLiveMarketStrip();
    updateLiveMarketDom();
    updateLiveFeedStatus();
  }

  function liveAgeText(ageMinutes) {
    return Number.isFinite(Number(ageMinutes))
      ? `${Number(ageMinutes).toFixed(1)}m ago`
      : "no live bar";
  }

  function modelSnapshotFallbackPrice(symbol) {
    const key = String(symbol || "").toUpperCase();
    if (["MES", "MNQ"].includes(key)) {
      const tech = state.latest?.technicals?.symbols?.[key] || null;
      const value = Number(tech?.price ?? tech?.timeframes?.["5m"]?.price);
      return Number.isFinite(value) ? value : null;
    }
    const value = Number(state.latest?.gex_context?.symbols?.[key]?.price);
    return Number.isFinite(value) ? value : null;
  }

  function livePriceCard(symbol) {
    const snapshotFallback = modelSnapshotFallbackPrice(symbol);
    const row = livePriceState(symbol, snapshotFallback);
    const digits = symbol === "SPX" ? 1 : 2;
    return `
      <div class="live-market-card ${row.fresh ? "fresh" : "fallback"}">
        <div class="live-market-card-top">
          <span>${esc(symbol)}</span>
          <span class="live-market-state">${row.fresh ? "LIVE 1M" : "SNAPSHOT"}</span>
        </div>
        <strong>${Number.isFinite(row.price) ? fmt(row.price, digits) : "—"}</strong>
        <small>${row.fresh ? esc(liveAgeText(row.ageMinutes)) : "waiting for TradingView 1m"}</small>
      </div>
    `;
  }

  function liveFootprintCard(symbol) {
    const row = liveFootprintState(symbol);
    const cls = !row.fresh
      ? "fallback"
      : Number(row.deltaPct) > 0
        ? "bullish"
        : Number(row.deltaPct) < 0
          ? "bearish"
          : "fresh";
    return `
      <div class="live-market-card footprint ${cls}">
        <div class="live-market-card-top">
          <span>${esc(symbol)} 1M OF</span>
          <span class="live-market-state">${row.fresh ? "LIVE" : "STALE"}</span>
        </div>
        <strong>${Number.isFinite(row.deltaPct) ? `${fmtSigned(row.deltaPct, 1)}% Δ` : "—"}</strong>
        <small>${row.fresh ? `POC ${Number.isFinite(row.poc) ? fmt(row.poc, 2) : "—"} · ${esc(liveAgeText(row.ageMinutes))}` : "confirmed OF model stays on last 5m snapshot"}</small>
      </div>
    `;
  }

  function renderLiveMarketStrip() {
    const container = $("liveMarketStrip");
    if (!container) return;
    container.innerHTML = [
      ...LIVE_PRICE_SYMBOLS.map(livePriceCard),
      liveFootprintCard("ES"),
      liveFootprintCard("NQ"),
    ].join("");
  }

  function updateLiveFeedStatus() {
    const status = $("liveMarketStatus");
    const updated = $("liveMarketUpdateText");
    const dot = $("liveMarketDot");
    if (!status || !updated || !dot) return;

    const freshRows = LIVE_PRICE_SYMBOLS
      .map(symbol => state.liveBars[symbol])
      .filter(row => liveRowFresh(row, LIVE_PRICE_MAX_AGE_MINUTES));

    if (freshRows.length >= 2) {
      const ages = freshRows.map(liveRowAgeMinutes).filter(Number.isFinite);
      const newestAge = ages.length ? Math.min(...ages) : null;
      status.textContent = "TradingView live";
      updated.textContent = Number.isFinite(newestAge)
        ? `newest completed 1m · ${liveAgeText(newestAge)}`
        : "completed 1m feed";
      dot.className = "status-dot online";
      return;
    }

    status.textContent = state.liveFeedError ? "Live feed fallback" : "Waiting for live feed";
    updated.textContent = state.liveFeedError
      ? "model snapshots remain available"
      : "no fresh 1m bars yet";
    dot.className = "status-dot stale";
  }

  function targetDistanceText(symbol, strike, side) {
    const snapshotPrice = state.latest?.gex_context?.symbols?.[symbol]?.price;
    const live = livePriceState(symbol, snapshotPrice);
    const price = Number(live.price);
    const target = Number(strike);
    if (!Number.isFinite(price) || !Number.isFinite(target)) return "distance —";
    const remaining = side === "UP" ? target - price : price - target;
    if (remaining >= 0) return `${fmt(remaining, symbol === "SPX" ? 1 : 2)} pts away`;
    return `${fmt(Math.abs(remaining), symbol === "SPX" ? 1 : 2)} pts passed`;
  }

  function updateLiveMarketDom() {
    document.querySelectorAll("[data-live-spot-symbol]").forEach(node => {
      const symbol = node.dataset.liveSpotSymbol;
      const fallback = Number(node.dataset.snapshotSpot);
      const row = livePriceState(symbol, fallback);
      const digits = symbol === "SPX" ? 1 : 2;
      node.textContent = Number.isFinite(row.price) ? fmt(row.price, digits) : "—";
      node.classList.toggle("live-price-fresh", row.fresh);
    });

    document.querySelectorAll("[data-live-spot-meta]").forEach(node => {
      const symbol = node.dataset.liveSpotMeta;
      const row = livePriceState(symbol, Number(node.dataset.snapshotSpot));
      node.textContent = row.fresh
        ? `LIVE · ${liveAgeText(row.ageMinutes)}`
        : "MODEL SNAPSHOT";
      node.classList.toggle("live-price-fresh", row.fresh);
    });

    document.querySelectorAll("[data-live-target-distance]").forEach(node => {
      node.textContent = targetDistanceText(
        node.dataset.symbol,
        Number(node.dataset.strike),
        node.dataset.side
      );
    });
  }

  function handleLiveMarketRow(row) {
    const changed = applyLiveBarRow(row) || applyLiveFootprintRow(row);
    const structureChartRow =
      row?.data_type === "ohlcv" &&
      row?.timeframe === "5m" &&
      ["MES", "MNQ"].includes(String(row?.symbol || "").toUpperCase());

    if (!changed && !structureChartRow) return;

    if (changed) {
      state.liveFeedAvailable = true;
      state.liveFeedError = null;
      renderLiveMarketStrip();
      updateLiveMarketDom();
      updateLiveFeedStatus();
      updateActiveTradeCurrentHint();

      if (loadActiveTradeState() && state.latest) {
        renderActiveTradeManagement({ emitManagementSnapshot: false });
      }
    }

    // Structure charts also consume completed MES/MNQ 5m rows.
    window.dispatchEvent(new CustomEvent("fm-live-market-updated", { detail: row }));
  }

  function subscribeLiveMarket() {
    if (state.liveMarketChannel) {
      client.removeChannel(state.liveMarketChannel);
    }

    state.liveMarketChannel = client
      .channel("tv-market-bars-live")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "tv_market_bars",
        },
        payload => handleLiveMarketRow(payload.new || payload.record || null)
      )
      .subscribe();
  }

  // V24_10M_ENTRY_SIGNAL_SHADOW

  // ==========================================================
  // V24 · 10M TRADINGVIEW ENTRY SIGNAL · SHADOW / TIMING LAYER
  // ==========================================================
  const ENTRY_SIGNAL_SYMBOLS = ["MES", "MNQ"];
  const ENTRY_SIGNAL_FRESH_MINUTES = 10;
  const ENTRY_SIGNAL_AGING_MINUTES = 20;

  function entrySignalAgeMinutes(row) {
    if (!row) return null;
    const timeMs = Number(row.bar_close_ms || row.bar_open_ms);
    const receivedMs = Date.parse(row.received_at || "");
    const basis = Number.isFinite(timeMs)
      ? timeMs
      : Number.isFinite(receivedMs)
        ? receivedMs
        : null;
    return Number.isFinite(basis)
      ? Math.max(0, (Date.now() - basis) / 60000)
      : null;
  }

  function applyEntrySignalRow(row) {
    if (!row) return false;
    const symbol = String(row.symbol || "").toUpperCase();
    if (!ENTRY_SIGNAL_SYMBOLS.includes(symbol)) return false;
    if (String(row.timeframe || "") !== "10m") return false;

    const previous = state.entrySignals[symbol] || null;
    const previousOpen = Number(previous?.bar_open_ms);
    const nextOpen = Number(row.bar_open_ms);
    if (!Number.isFinite(nextOpen)) return false;

    if (!previous || !Number.isFinite(previousOpen) || nextOpen >= previousOpen) {
      const isNew = !previous || nextOpen > previousOpen;
      state.entrySignals[symbol] = row;
      return isNew;
    }

    return false;
  }

  function entrySignalFreshness(row) {
    const age = entrySignalAgeMinutes(row);
    if (!Number.isFinite(age)) return { label: "UNKNOWN", cls: "unknown", age };
    if (age <= ENTRY_SIGNAL_FRESH_MINUTES) return { label: "FRESH", cls: "fresh", age };
    if (age <= ENTRY_SIGNAL_AGING_MINUTES) return { label: "AGING", cls: "aging", age };
    return { label: "STALE", cls: "stale", age };
  }

  function entrySignalExecution(symbol) {
    if (!state.latest) return null;
    const bullish = buildTradeScenario(state.latest, symbol, "BULLISH");
    const bearish = buildTradeScenario(state.latest, symbol, "BEARISH");
    return executionState(state.latest, symbol, bullish, bearish);
  }

  function entrySignalPayload(row) {
    const payload = row?.payload;
    return payload && typeof payload === "object" ? payload : {};
  }

  function entrySignalAlignment(symbol, row) {
    if (!row) {
      return {
        label: "NO SIGNAL",
        cls: "none",
        detail: "Waiting for a confirmed 10m TradingView L/S/LC/SC event.",
        execution: entrySignalExecution(symbol),
      };
    }

    const fresh = entrySignalFreshness(row);
    const direction = String(row.direction || "").toUpperCase();
    const execution = entrySignalExecution(symbol);

    if (fresh.label === "STALE") {
      return {
        label: "STALE",
        cls: "stale",
        detail: "Stored for research only. Wait for a new confirmed 10m trigger.",
        execution,
      };
    }

    if (fresh.label === "AGING") {
      return {
        label: "AGING · REASSESS",
        cls: "aging",
        detail: "The trigger is older than one 10m bar. Reassess current model/structure before entry.",
        execution,
      };
    }

    if (!execution) {
      return {
        label: "MODEL UNKNOWN",
        cls: "unknown",
        detail: "Signal is fresh, but the dashboard does not have a complete execution model.",
        execution,
      };
    }

    if (execution.bias !== direction) {
      return {
        label: "CONFLICT",
        cls: "conflict",
        detail: `Signal is ${direction}; current dashboard execution bias is ${execution.bias}. Do not use the signal to reverse the model.`,
        execution,
      };
    }

    const blockedClasses = new Set(["blocked", "warmup", "incomplete"]);
    if (blockedClasses.has(String(execution.stateClass || "").toLowerCase())) {
      return {
        label: "ALIGNED · MODEL BLOCKED",
        cls: "blocked",
        detail: `Direction agrees, but the current model state is ${execution.state}.`,
        execution,
      };
    }

    const triggerExpected = (
      String(execution.state || "") + " " + String(execution.action || "")
    ).toUpperCase().includes("10M");

    if (triggerExpected) {
      return {
        label: "TRIGGER ELIGIBLE",
        cls: "eligible",
        detail: "Fresh 10m direction agrees with the current model and the model is explicitly waiting for a 10m trigger.",
        execution,
      };
    }

    return {
      label: "ALIGNED · MODEL WAIT",
      cls: "aligned",
      detail: `Direction agrees, but another model gate is still pending: ${execution.state}.`,
      execution,
    };
  }

  function renderEntrySignalCards() {
    const container = $("entrySignalCards");
    if (!container) return;

    container.innerHTML = ENTRY_SIGNAL_SYMBOLS.map(symbol => {
      const row = state.entrySignals[symbol] || null;
      const payload = entrySignalPayload(row);
      const fresh = row
        ? entrySignalFreshness(row)
        : { label: "NO SIGNAL", cls: "none", age: null };
      const alignment = entrySignalAlignment(symbol, row);
      const execution = alignment.execution;

      if (!row) {
        return `
          <article class="entry-signal-card no-signal">
            <div class="entry-signal-head">
              <div>
                <strong>${symbol}</strong>
                <small>10m EMA9/21 + CCI trigger</small>
              </div>
              <span class="entry-signal-status none">NO SIGNAL</span>
            </div>
            <p>Waiting for the next confirmed TradingView L/S/LC/SC event.</p>
            <div class="entry-signal-model">
              <span>Model</span>
              <strong>${esc(execution?.state || "Waiting for model")}</strong>
            </div>
          </article>
        `;
      }

      const signal = String(row.signal || payload.signal || "—");
      const direction = String(row.direction || payload.direction || "—");
      const family = String(row.family || payload.family || "—");
      const quality = Number(row.quality_score ?? payload.quality_score);
      const strong = row.strong_tier === true || payload.strong_tier === true;
      const close = Number(row.close ?? payload.close);
      const ema9 = Number(payload.ema9);
      const ema21 = Number(payload.ema21);
      const cciFast = Number(payload.cci_fast);
      const cciSlow = Number(payload.cci_slow);
      const ageText = Number.isFinite(fresh.age)
        ? `${fresh.age.toFixed(1)}m ago`
        : "age unknown";

      return `
        <article class="entry-signal-card ${direction === "LONG" ? "long" : "short"}">
          <div class="entry-signal-head">
            <div>
              <strong>${symbol} · ${esc(signal)}</strong>
              <small>${esc(family.replaceAll("_", " "))} · confirmed 10m</small>
            </div>
            <span class="entry-signal-status ${esc(alignment.cls)}">${esc(alignment.label)}</span>
          </div>

          <div class="entry-signal-primary">
            <div><span>Direction</span><strong class="${direction === "LONG" ? "positive" : "negative"}">${esc(direction)}</strong></div>
            <div><span>Quality</span><strong>${Number.isFinite(quality) ? `${quality}/6` : "—"}</strong><small>${strong ? "STRONG TIER" : "STANDARD TIER"}</small></div>
            <div><span>Signal close</span><strong>${Number.isFinite(close) ? fmt(close, 2) : "—"}</strong></div>
            <div><span>Freshness</span><strong class="${esc(fresh.cls)}">${esc(fresh.label)}</strong><small>${esc(ageText)}</small></div>
          </div>

          <div class="entry-signal-tech">
            <span>EMA9 ${Number.isFinite(ema9) ? fmt(ema9, 2) : "—"}</span>
            <span>EMA21 ${Number.isFinite(ema21) ? fmt(ema21, 2) : "—"}</span>
            <span>CCI ${Number.isFinite(cciFast) ? fmt(cciFast, 1) : "—"} / ${Number.isFinite(cciSlow) ? fmt(cciSlow, 1) : "—"}</span>
            <span>${esc(String(payload.trend_state || "MIXED").replaceAll("_", " "))}</span>
          </div>

          <div class="entry-signal-model">
            <div><span>Current model state</span><strong>${esc(execution?.state || "MODEL UNKNOWN")}</strong></div>
            <div><span>Current model bias</span><strong>${esc(execution?.bias || "—")}</strong></div>
          </div>

          <p class="entry-signal-detail">${esc(alignment.detail)}</p>
        </article>
      `;
    }).join("");
  }

  async function fetchEntrySignals() {
    try {
      const { data, error } = await client
        .from("tv_entry_signals")
        .select("id,symbol,tickerid,timeframe,bar_open_ms,bar_close_ms,signal,direction,family,strong_tier,quality_score,close,payload,received_at")
        .in("symbol", ENTRY_SIGNAL_SYMBOLS)
        .eq("timeframe", "10m")
        .order("bar_open_ms", { ascending: false })
        .limit(30);

      if (error) throw error;
      (data || []).forEach(applyEntrySignalRow);
      state.entrySignalError = null;
    } catch (error) {
      state.entrySignalError = error?.message || String(error);
      console.warn("10m entry signal feed unavailable:", error);
    }

    renderEntrySignalCards();
  }

  function subscribeEntrySignals() {
    if (state.entrySignalChannel) {
      client.removeChannel(state.entrySignalChannel);
    }

    state.entrySignalChannel = client
      .channel("tv-entry-signals-live")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "tv_entry_signals" },
        payload => {
          const row = payload.new || payload.record || null;
          const isNew = applyEntrySignalRow(row);
          renderEntrySignalCards();
          if (isNew && row) toast(`${row.symbol} 10m ${row.signal} received`);
        }
      )
      .subscribe();
  }

  async function fetchLatest() {
    const { data, error } = await client
      .from("market_snapshots")
      .select("*")
      .order("captured_at", { ascending: false })
      .limit(1);

    if (error) throw error;

    state.latest = normalizeSnapshot(data?.[0] || null);
    state.selected = state.latest;
    notifyOrderflowState("fetch-latest");
    return state.latest;
  }

  async function fetchDay(date) {
    if (!date) return [];

    const { data, error } = await client
      .from("market_snapshots")
      .select("*")
      .eq("trading_date", date)
      .order("captured_at", { ascending: true })
      .limit(500);

    if (error) throw error;

    state.daySnapshots = (data || []).map(normalizeSnapshot);
    notifyOrderflowState("fetch-day");
    return state.daySnapshots;
  }

  async function fetchAvailableDates() {
    const { data, error } = await client
      .from("market_snapshots")
      .select("trading_date")
      .order("trading_date", { ascending: false })
      .limit(1000);

    if (error) throw error;

    state.dates = [...new Set((data || []).map(r => r.trading_date))];
    return state.dates;
  }

  async function fetchOutcomes(date) {
    if (!date) {
      state.outcomes = [];
      return [];
    }

    const { data, error } = await client
      .from("model_outcomes")
      .select("*")
      .eq("trading_date", date)
      .order("captured_at", { ascending: true })
      .limit(3000);

    if (error) {
      console.warn("Outcome query:", error);
      state.outcomes = [];
      return [];
    }

    state.outcomes = data || [];
    return state.outcomes;
  }

  function instrumentData(snapshot, symbol) {
    return snapshot?.attraction?.instruments?.[symbol] || null;
  }

  function techData(snapshot, symbol) {
    return snapshot?.technicals?.symbols?.[symbol] || null;
  }

  function marketData(snapshot, symbol) {
    return {
      gex: snapshot?.gex_context?.symbols?.[symbol] || null,
      flow: snapshot?.flowline?.symbols?.[symbol] || null,
      attraction: snapshot?.attraction?.assets?.[symbol] || null,
    };
  }

  // ==========================================================
  // DISPLAY-ONLY TRADE SCENARIO RECOMMENDATIONS
  // ==========================================================
  //
  // This does NOT change the backend Attraction Engine, Directional Confluence,
  // preferred instrument, or saved model output.
  //
  // Scenario-support score:
  //   70% production directional model (already includes capped OF V2)
  //   30% primary underlying target attraction
  //   Order Flow remains a separate freshness/conflict/timing gate, not a second additive vote
  //
  // The score is NOT a probability of winning.
  // ==========================================================

  function clampNumber(value, low, high) {
    const n = Number(value);
    if (!Number.isFinite(n)) return low;
    return Math.max(low, Math.min(high, n));
  }

  function parseRecommendationObject(value) {
    if (!value) return null;
    if (typeof value === "object") return value;

    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" ? parsed : null;
      } catch (_error) {
        return null;
      }
    }

    return null;
  }

  function recommendationOrderflowPayload(snapshot) {
    const candidates = [
      snapshot?.orderflow,
      snapshot?.order_flow,
      snapshot?.orderFlow,
    ];

    for (const candidate of candidates) {
      let payload = parseRecommendationObject(candidate);
      if (!payload) continue;

      if (!payload.instruments && payload.orderflow) {
        payload = parseRecommendationObject(payload.orderflow) || payload;
      }

      if (payload?.instruments) return payload;
    }

    return null;
  }

  function recommendationOrderflow(snapshot, instrumentSymbol) {
    const futuresSymbol = instrumentSymbol === "MES" ? "ES" : "NQ";
    const payload = recommendationOrderflowPayload(snapshot);
    const row = payload?.instruments?.[futuresSymbol] || null;
    const model = row?.production_model || row?.shadow_model || {};
    const usingProduction = Boolean(row?.production_model);

    const fresh = Boolean(
      row &&
      row.data_status === "FRESH" &&
      model.signal_status === "FRESH"
    );

    return {
      futuresSymbol,
      row,
      model,
      // Compatibility alias for trade_journal.js versions that still read .shadow.
      shadow: model,
      usingProduction,
      fresh,
    };
  }

  function directionalValueFromInstrument(row) {
    const direct = Number(row?.directional_value);

    if (Number.isFinite(direct)) {
      return clampNumber(direct, -1, 1);
    }

    let sum = 0;
    let found = false;

    Object.values(row?.components || {}).forEach(component => {
      const contribution = Number(component?.weighted_contribution);

      if (Number.isFinite(contribution)) {
        sum += contribution;
        found = true;
      }
    });

    return found ? clampNumber(sum, -1, 1) : 0;
  }

  function scenarioTier(score, complete) {
    if (!complete) {
      return {
        label: "DATA INCOMPLETE",
        cls: "incomplete",
      };
    }

    if (score >= 70) {
      return {
        label: "STRONG",
        cls: "strong",
      };
    }

    if (score >= 60) {
      return {
        label: "FAVORABLE",
        cls: "favorable",
      };
    }

    if (score >= 50) {
      return {
        label: "CONDITIONAL",
        cls: "conditional",
      };
    }

    return {
      label: "WEAK",
      cls: "weak",
    };
  }

  function scenarioTarget(snapshot, instrumentSymbol, side) {
    const assetSymbol = instrumentSymbol === "MES" ? "SPX" : "QQQ";
    const asset = snapshot?.attraction?.assets?.[assetSymbol] || null;

    const target = side === "BULLISH"
      ? asset?.primary_up_target
      : asset?.primary_down_target;

    return {
      assetSymbol,
      asset,
      target: target || null,
    };
  }

  function buildTradeScenario(snapshot, instrumentSymbol, side) {
    const row = instrumentData(snapshot, instrumentSymbol);
    const tech = techData(snapshot, instrumentSymbol);
    const of = recommendationOrderflow(snapshot, instrumentSymbol);

    const { assetSymbol, target } = scenarioTarget(
      snapshot,
      instrumentSymbol,
      side
    );

    const sideSign = side === "BULLISH" ? 1 : -1;

    const modelDirection = directionalValueFromInstrument(row);

    const modelSupport = clampNumber(
      50 + sideSign * 50 * modelDirection,
      0,
      100
    );

    const targetScoreRaw = Number(target?.attraction_score);

    const targetSupport = Number.isFinite(targetScoreRaw)
      ? clampNumber(targetScoreRaw, 0, 100)
      : 35;

    const orderflowDirection = of.fresh
      ? clampNumber(of.model?.effective_direction ?? of.model?.combined_direction, -1, 1)
      : 0;

    const orderflowQuality = of.fresh
      ? clampNumber(Number(of.model?.combined_quality) / 100, 0, 1)
      : 0;

    // Low-quality Order Flow stays close to neutral rather than dominating.
    const orderflowSupport = clampNumber(
      50 + sideSign * 50 * orderflowDirection * orderflowQuality,
      0,
      100
    );

    const score = clampNumber(
      modelSupport * 0.70 +
      targetSupport * 0.30,
      0,
      100
    );

    const complete = Boolean(
      row &&
      tech &&
      target &&
      of.fresh
    );

    const tier = scenarioTier(
      score,
      complete
    );

    const techBias = tech?.technical_bias || "NO DATA";
    const modelBias = row?.bias || "NO DATA";

    const ofBias = of.fresh
      ? of.model?.bias || "MIXED"
      : "NO FRESH OF";

    const targetStrike = Number(target?.strike);

    const targetText = target
      ? `${assetSymbol} ${Number.isFinite(targetStrike) ? targetStrike : "N/A"}`
      : `${assetSymbol} target unavailable`;

    const reaction = target?.reaction
      ? reactionShort(target.reaction)
      : "No target reaction";

    return {
      side,
      score,
      tier,
      complete,
      modelSupport,
      targetSupport,
      orderflowSupport,
      modelBias,
      techBias,
      ofBias,
      ofDirection: orderflowDirection,
      ofQuality: of.fresh
        ? Number(of.model?.combined_quality)
        : null,
      targetText,
      target,
      assetSymbol,
      reaction,
      futuresSymbol: of.futuresSymbol,
      freshOrderflow: of.fresh,
    };
  }

  // ==========================================================
  // EXECUTION STATE — DISPLAY ONLY
  // ==========================================================
  //
  // Candidate:
  //   winning scenario >= 60
  //   scenario spread >= 10 points
  //
  // 5m confirmation:
  //   long  technical score >= +3
  //   short technical score <= -3
  //
  // READY additionally requires:
  //   production model aligned
  //   target still ahead with usable room
  //   fresh Order Flow
  //   10m regime not opposing
  //   short-horizon trigger aligned
  //
  // "Room" is an underlying-distance heuristic only. It is NOT RR.
  // RR still depends on the actual futures entry and structural stop.
  // ==========================================================

  // ==========================================================
  // CASH-OPEN SESSION GATE — DISPLAY / EXECUTION ONLY
  // ==========================================================
  //
  // Uses the snapshot timestamp in America/Chicago so Live and History
  // reconstruct the same state.
  //
  // 08:30–08:59 CT  -> MARKET OPEN WARM-UP / OBSERVE ONLY
  // 09:00–09:14 CT  -> MODEL ACTIVE / EARLY SESSION
  // 09:15+ CT        -> MODEL ACTIVE / NORMAL CONFIDENCE
  //
  // Warm-up blocks READY, but it does NOT hide or modify model data.
  // ==========================================================

  function chicagoClockParts(value) {
    if (!value) return null;

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      return null;
    }

    const parts = new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone:
          cfg.timezone ||
          "America/Chicago",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }
    ).formatToParts(date);

    const hour = Number(
      parts.find(
        part => part.type === "hour"
      )?.value
    );

    const minute = Number(
      parts.find(
        part => part.type === "minute"
      )?.value
    );

    if (
      !Number.isFinite(hour) ||
      !Number.isFinite(minute)
    ) {
      return null;
    }

    return {
      hour,
      minute,
      totalMinutes:
        hour * 60 + minute,
    };
  }

  function marketOpenGate(snapshot) {
    const clock = chicagoClockParts(
      snapshot?.captured_at
    );

    if (!clock) {
      return {
        phase: "UNKNOWN",
        label: "SESSION TIME UNKNOWN",
        detail: "Snapshot time unavailable.",
        cls: "unknown",
        blocksReady: true,
      };
    }

    const open = 8 * 60 + 30;
    const unlock = 9 * 60;
    const normal = 9 * 60 + 15;

    if (
      clock.totalMinutes >= open &&
      clock.totalMinutes < unlock
    ) {
      return {
        phase: "WARMUP",
        label:
          "MARKET OPEN WARM-UP · OBSERVE ONLY",
        detail:
          "Opening price discovery in progress. Normal execution unlocks at 9:00 AM CT.",
        cls: "warmup",
        blocksReady: true,
      };
    }

    if (
      clock.totalMinutes >= unlock &&
      clock.totalMinutes < normal
    ) {
      return {
        phase: "EARLY",
        label:
          "MODEL ACTIVE · EARLY SESSION",
        detail:
          "Execution rules are active; use full confirmation because opening conditions are still settling.",
        cls: "early",
        blocksReady: false,
      };
    }

    if (
      clock.totalMinutes >= normal
    ) {
      return {
        phase: "NORMAL",
        label:
          "MODEL ACTIVE · NORMAL CONFIDENCE",
        detail:
          "Normal execution-state rules are active.",
        cls: "normal",
        blocksReady: false,
      };
    }

    // The collector normally begins after 08:30 CT, but keep a safe
    // pre-open state if earlier snapshots are ever loaded.
    return {
      phase: "PREOPEN",
      label:
        "PRE-OPEN · OBSERVE ONLY",
      detail:
        "Cash-session execution is locked until the 9:00 AM CT model unlock.",
      cls: "preopen",
      blocksReady: true,
    };
  }

  // ==========================================================
  // GEX STRUCTURAL-CHANGE EXECUTION GATE — DISPLAY ONLY
  // ==========================================================
  //
  // Uses the same current-cycle GEX/Attraction data already saved by
  // the backend. No production model weights are changed.
  //
  // BLOCK NEW ENTRY FOR THE CURRENT CYCLE:
  //   - primary target SIGN_FLIP
  //   - primary target changes strike vs previous valid snapshot
  //   - primary target disappears
  //   - a newly material/strengthening opposite-direction
  //     ACCELERATION structure appears
  //
  // CAUTION:
  //   - primary target WEAKENING
  //
  // INFORMATIONAL / SUPPORTIVE:
  //   - target STRENGTHENING
  //   - NEW_LEVEL that is not an opposing acceleration conflict
  //
  // A sign flip naturally requires one additional snapshot because the
  // sign-flip cycle is blocked. If the same target persists on the next
  // valid snapshot without another sign flip, normal execution can resume.
  // ==========================================================

  function snapshotTimeMs(snapshot) {
    const value = new Date(
      snapshot?.captured_at
    ).getTime();

    return Number.isFinite(value)
      ? value
      : null;
  }

  function previousSnapshotFor(snapshot) {
    const currentMs =
      snapshotTimeMs(snapshot);

    if (
      !Number.isFinite(currentMs) ||
      !Array.isArray(state.daySnapshots)
    ) {
      return null;
    }

    const sameDay =
      snapshot?.trading_date;

    const candidates =
      state.daySnapshots
        .filter(row => {
          if (
            sameDay &&
            row?.trading_date !== sameDay
          ) {
            return false;
          }

          const rowMs =
            snapshotTimeMs(row);

          if (
            !Number.isFinite(rowMs) ||
            rowMs >= currentMs
          ) {
            return false;
          }

          // Match the backend intraday GEX comparison guard.
          const gapMinutes =
            (currentMs - rowMs) / 60000;

          return (
            gapMinutes > 0 &&
            gapMinutes <= 30
          );
        })
        .sort(
          (a, b) =>
            snapshotTimeMs(b) -
            snapshotTimeMs(a)
        );

    return candidates[0] || null;
  }

  function rawTemporalEvent(target) {
    return String(
      target?.temporal_event ||
      ""
    ).toUpperCase();
  }

  function temporalEventLabel(target) {
    const raw =
      rawTemporalEvent(target);

    return raw
      ? raw.replaceAll("_", " ")
      : "UNCHANGED";
  }

  function targetForSide(
    snapshot,
    instrumentSymbol,
    side
  ) {
    const assetSymbol =
      instrumentSymbol === "MES"
        ? "SPX"
        : "QQQ";

    const asset =
      snapshot?.attraction
        ?.assets?.[assetSymbol];

    return side === "BULLISH"
      ? asset?.primary_up_target || null
      : asset?.primary_down_target || null;
  }

  function targetStrikeNumber(target) {
    const strike =
      Number(target?.strike);

    return Number.isFinite(strike)
      ? strike
      : null;
  }

  function reactionIsOpposingAcceleration(
    target,
    side
  ) {
    const reaction =
      String(
        target?.reaction ||
        ""
      ).toUpperCase();

    if (side === "BULLISH") {
      return reaction.includes(
        "DOWNSIDE_ACCELERATION"
      );
    }

    return reaction.includes(
      "UPSIDE_ACCELERATION"
    );
  }

  function materialTemporalBuild(event) {
    return (
      event === "SIGN_FLIP" ||
      event === "NEW_LEVEL" ||
      event.includes("STRENGTHENING")
    );
  }

  function buildGexExecutionGate(
    snapshot,
    instrumentSymbol,
    dominant,
    opposite
  ) {
    if (!dominant) {
      return {
        status: "UNKNOWN",
        label: "GEX CHANGE UNKNOWN",
        detail: "No dominant scenario.",
        cls: "unknown",
        blocksEntry: false,
        caution: false,
      };
    }

    const side =
      dominant.side;

    const currentTarget =
      dominant.target || null;

    const oppositeTarget =
      opposite?.target || null;

    const previous =
      previousSnapshotFor(snapshot);

    const previousTarget =
      previous
        ? targetForSide(
            previous,
            instrumentSymbol,
            side
          )
        : null;

    const currentStrike =
      targetStrikeNumber(
        currentTarget
      );

    const previousStrike =
      targetStrikeNumber(
        previousTarget
      );

    const currentEvent =
      rawTemporalEvent(
        currentTarget
      );

    const priorEvent =
      rawTemporalEvent(
        previousTarget
      );

    const oppositeEvent =
      rawTemporalEvent(
        oppositeTarget
      );

    const oppositeConflict =
      Boolean(
        oppositeTarget &&
        reactionIsOpposingAcceleration(
          oppositeTarget,
          side
        ) &&
        materialTemporalBuild(
          oppositeEvent
        )
      );

    if (
      previousTarget &&
      !currentTarget
    ) {
      return {
        status: "TARGET_LOST",
        label:
          "GEX TARGET LOST · REASSESS",
        detail:
          `The prior ${dominant.assetSymbol} primary target is no longer present. Wait for the next cycle to establish stable structure.`,
        cls: "blocked",
        blocksEntry: true,
        caution: false,
      };
    }

    if (
      Number.isFinite(previousStrike) &&
      Number.isFinite(currentStrike) &&
      previousStrike !== currentStrike
    ) {
      return {
        status: "TARGET_SHIFT",
        label:
          "GEX TARGET SHIFT · REASSESS",
        detail:
          `${dominant.assetSymbol} primary ${side === "BULLISH" ? "up" : "down"} target shifted ${previousStrike} → ${currentStrike}. Confirm the new target for one cycle before entry.`,
        cls: "blocked",
        blocksEntry: true,
        caution: false,
      };
    }

    if (
      currentEvent === "SIGN_FLIP"
    ) {
      return {
        status: "SIGN_FLIP",
        label:
          "GEX REGIME CHANGE · WAIT",
        detail:
          `${dominant.assetSymbol} ${currentStrike ?? "target"} has a material SIGN FLIP. Do not initiate a new trade until a subsequent snapshot confirms the new structure.`,
        cls: "blocked",
        blocksEntry: true,
        caution: false,
      };
    }

    if (oppositeConflict) {
      return {
        status:
          "OPPOSING_ACCELERATION_BUILD",
        label:
          "GEX CONFLICT · WAIT",
        detail:
          `A material ${dominant.assetSymbol} ${opposite?.side === "BULLISH" ? "upside" : "downside"} acceleration structure is ${temporalEventLabel(oppositeTarget).toLowerCase()} against the ${side === "BULLISH" ? "LONG" : "SHORT"} thesis.`,
        cls: "blocked",
        blocksEntry: true,
        caution: false,
      };
    }

    if (
      currentEvent.includes(
        "WEAKENING"
      )
    ) {
      return {
        status:
          "TARGET_WEAKENING",
        label:
          "GEX TARGET WEAKENING · CAUTION",
        detail:
          `${dominant.assetSymbol} ${currentStrike ?? "target"} is ${temporalEventLabel(currentTarget).toLowerCase()}. The setup can remain valid, but target conviction is reduced.`,
        cls: "caution",
        blocksEntry: false,
        caution: true,
      };
    }

    if (
      priorEvent === "SIGN_FLIP" &&
      Number.isFinite(previousStrike) &&
      previousStrike === currentStrike
    ) {
      return {
        status:
          "SIGN_FLIP_CONFIRMED",
        label:
          "GEX REGIME CHANGE CONFIRMED",
        detail:
          `${dominant.assetSymbol} ${currentStrike} persisted after the prior sign-flip snapshot. Normal execution rules can resume.`,
        cls: "confirmed",
        blocksEntry: false,
        caution: false,
      };
    }

    if (
      currentEvent.includes(
        "STRENGTHENING"
      )
    ) {
      return {
        status:
          "TARGET_STRENGTHENING",
        label:
          "GEX TARGET STRENGTHENING",
        detail:
          `${dominant.assetSymbol} ${currentStrike ?? "target"} is ${temporalEventLabel(currentTarget).toLowerCase()}. No execution block is applied.`,
        cls: "supportive",
        blocksEntry: false,
        caution: false,
      };
    }

    if (
      currentEvent === "NEW_LEVEL"
    ) {
      return {
        status:
          "NEW_TARGET_STRUCTURE",
        label:
          "NEW GEX STRUCTURE",
        detail:
          `${dominant.assetSymbol} ${currentStrike ?? "target"} is a new material level. It remains tradable unless another execution gate blocks the setup.`,
        cls: "info",
        blocksEntry: false,
        caution: false,
      };
    }

    return {
      status: "STABLE",
      label:
        "GEX STRUCTURE STABLE",
      detail:
        currentTarget
          ? `${dominant.assetSymbol} ${currentStrike ?? "target"} temporal state: ${temporalEventLabel(currentTarget)}.`
          : "No current primary target.",
      cls: "stable",
      blocksEntry: false,
      caution: false,
    };
  }

  function signOfBias(value) {
    const text = String(value || "").toUpperCase();

    if (text.includes("BULL")) return 1;
    if (text.includes("BEAR")) return -1;

    return 0;
  }

  function signWithDeadZone(value, deadZone = 0.05) {
    const n = Number(value);

    if (!Number.isFinite(n)) return 0;
    if (n > deadZone) return 1;
    if (n < -deadZone) return -1;

    return 0;
  }

  function technicalScore5m(tech) {
    const direct = Number(tech?.technical_score);

    if (Number.isFinite(direct)) {
      return direct;
    }

    const nested = Number(
      tech?.timeframes?.["5m"]?.technical_score
    );

    return Number.isFinite(nested)
      ? nested
      : null;
  }

  function technicalPosition(tech, sideSign) {
    const price = Number(tech?.price);
    const vwap = Number(tech?.vwap);
    const ema9 = Number(tech?.ema9);
    const ema21 = Number(tech?.ema21);

    const checks = [
      ["VWAP", vwap],
      ["EMA9", ema9],
      ["EMA21", ema21],
    ];

    let aligned = 0;
    let available = 0;

    checks.forEach(([_label, level]) => {
      if (!Number.isFinite(price) || !Number.isFinite(level)) {
        return;
      }

      available += 1;

      if (
        (sideSign > 0 && price > level) ||
        (sideSign < 0 && price < level)
      ) {
        aligned += 1;
      }
    });

    return {
      aligned,
      available,
      price,
      vwap,
      ema9,
      ema21,
    };
  }

  function executionTargetRoom(snapshot, scenario) {
    const strike = Number(
      scenario?.target?.strike
    );

    const spot = Number(
      snapshot?.gex_context
        ?.symbols?.[scenario?.assetSymbol]
        ?.price
    );

    if (
      !Number.isFinite(strike) ||
      !Number.isFinite(spot) ||
      spot === 0
    ) {
      return {
        valid: false,
        distance: null,
        pct: null,
        label: "UNKNOWN",
        cls: "unknown",
      };
    }

    const sideSign =
      scenario.side === "BULLISH"
        ? 1
        : -1;

    const distance =
      sideSign > 0
        ? strike - spot
        : spot - strike;

    const pct =
      Math.abs(distance) /
      Math.abs(spot) *
      100;

    if (distance <= 0) {
      return {
        valid: true,
        distance,
        pct,
        label: "TARGET PASSED",
        cls: "blocked",
      };
    }

    // Deliberately conservative anti-chase heuristic.
    // This does not replace actual futures R:R.
    if (pct <= 0.06) {
      return {
        valid: true,
        distance,
        pct,
        label: "VERY CLOSE",
        cls: "close",
      };
    }

    if (pct <= 0.10) {
      return {
        valid: true,
        distance,
        pct,
        label: "CLOSE",
        cls: "close",
      };
    }

    return {
      valid: true,
      distance,
      pct,
      label: "OPEN",
      cls: "open",
    };
  }

  function chooseDominantScenario(
    bullish,
    bearish
  ) {
    const bullScore = Number(
      bullish?.score
    );

    const bearScore = Number(
      bearish?.score
    );

    if (
      !Number.isFinite(bullScore) ||
      !Number.isFinite(bearScore)
    ) {
      return {
        dominant: null,
        opposite: null,
        spread: null,
        candidate: false,
      };
    }

    const dominant =
      bullScore >= bearScore
        ? bullish
        : bearish;

    const opposite =
      dominant === bullish
        ? bearish
        : bullish;

    const spread =
      Math.abs(
        bullScore - bearScore
      );

    return {
      dominant,
      opposite,
      spread,
      candidate:
        Number(dominant.score) >= 60 &&
        spread >= 10,
    };
  }

  function marketConditionFor(
    snapshot,
    instrumentSymbol
  ) {
    const tech = techData(
      snapshot,
      instrumentSymbol
    );

    const row =
      tech?.market_condition ||
      null;

    if (!row) {
      return {
        condition:
          "DATA UNAVAILABLE",
        execution_permission:
          "BLOCK",
        environment_score:
          null,
        hard_block:
          true,
        reason_codes: [
          "MARKET_CONDITION_NOT_SAVED",
        ],
        metrics: {},
        detail:
          "No saved market-condition metrics exist for this cycle.",
      };
    }

    return row;
  }

  function marketConditionLabel(row) {
    return String(
      row?.condition ||
      "DATA UNAVAILABLE"
    ).replaceAll("_", " ");
  }

  function marketConditionClass(row) {
    const value = String(
      row?.condition ||
      ""
    ).toUpperCase();

    if (
      value === "TRENDABLE"
    ) {
      return "safe";
    }

    if (
      value === "VOLATILE_TREND"
    ) {
      return "volatile";
    }

    if (
      value === "CHOPPY" ||
      value === "CHAOTIC_VOLATILITY"
    ) {
      return "blocked";
    }

    if (
      value === "ORDERLY_MIXED" ||
      value === "NORMAL_MIXED"
    ) {
      return "caution";
    }

    return "unknown";
  }

  function marketConditionMetricText(row) {
    const m =
      row?.metrics ||
      {};

    const range = Number(
      m.recent_max_range_ratio
    );

    const wick = Number(
      m.median_wick_ratio
    );

    const efficiency = Number(
      m.directional_efficiency
    );

    const crosses =
      m.reference_cross_events_last6 ??
      m.total_reference_crosses_last6;

    const cooldown =
      m.extreme_bar_cooldown_remaining;

    const pieces = [];

    if (Number.isFinite(range)) {
      pieces.push(
        `Range ${range.toFixed(2)}x ATR`
      );
    }

    if (Number.isFinite(wick)) {
      pieces.push(
        `Wicks ${(wick * 100).toFixed(0)}%`
      );
    }

    if (
      Number.isFinite(efficiency)
    ) {
      pieces.push(
        `Efficiency ${efficiency.toFixed(2)}`
      );
    }

    if (
      crosses !== undefined &&
      crosses !== null
    ) {
      pieces.push(
        `Whipsaw ${crosses}`
      );
    }

    if (
      Number(cooldown) > 0
    ) {
      pieces.push(
        `Cooldown ${cooldown} bar${Number(cooldown) === 1 ? "" : "s"}`
      );
    }

    return pieces.join(
      " · "
    ) || "Metrics unavailable";
  }

  // ==========================================================
  // CROSS-MARKET CONFIRMATION GATE V1 — DISPLAY / EXECUTION ONLY
  // ==========================================================
  //
  // Provisional rules:
  // - credible setup: 60+ support, 10+ Bull/Bear spread, market not BLOCK
  // - strong setup: 65+ support, 15+ spread, market ALLOW
  // - one side can dominate opposing credible setups only when BOTH:
  //     directional-confluence advantage >= 15
  //     setup-support advantage >= 5
  //   and the dominant side's market condition is ALLOW.
  // - strong opposite setups without clear dominance => HARD BLOCK.
  //
  // Directional Confluence alone cannot override a strong opposing setup.
  // ==========================================================

  const CROSS_MARKET_STRONG_SUPPORT = 65;
  const CROSS_MARKET_STRONG_SPREAD = 15;
  const CROSS_MARKET_TRADEABILITY_GAP = 15;
  const CROSS_MARKET_SETUP_GAP = 5;

  function crossMarketProfile(
    snapshot,
    instrumentSymbol
  ) {
    const bullish = buildTradeScenario(
      snapshot,
      instrumentSymbol,
      "BULLISH"
    );

    const bearish = buildTradeScenario(
      snapshot,
      instrumentSymbol,
      "BEARISH"
    );

    const choice = chooseDominantScenario(
      bullish,
      bearish
    );

    const dominant = choice.dominant;
    const row = instrumentData(
      snapshot,
      instrumentSymbol
    );

    const market = marketConditionFor(
      snapshot,
      instrumentSymbol
    );

    const tradeability = Number(
      row?.tradeability_score
    );

    const direction =
      dominant?.side === "BULLISH"
        ? "LONG"
        : dominant?.side === "BEARISH"
          ? "SHORT"
          : "NO EDGE";

    const marketPermission = String(
      market?.execution_permission ||
      "BLOCK"
    ).toUpperCase();

    const candidate = Boolean(
      dominant?.complete &&
      choice.candidate &&
      marketPermission !== "BLOCK"
    );

    const strong = Boolean(
      candidate &&
      Number(dominant?.score) >=
        CROSS_MARKET_STRONG_SUPPORT &&
      Number(choice.spread) >=
        CROSS_MARKET_STRONG_SPREAD &&
      marketPermission === "ALLOW"
    );

    return {
      instrument: instrumentSymbol,
      direction,
      dominant,
      setupSupport: Number(dominant?.score),
      spread: Number(choice.spread),
      tradeability:
        Number.isFinite(tradeability)
          ? tradeability
          : 0,
      marketPermission,
      marketCondition:
        market?.condition ||
        "DATA UNAVAILABLE",
      candidate,
      strong,
    };
  }

  function buildCrossMarketGate(
    snapshot,
    instrumentSymbol
  ) {
    const otherSymbol =
      instrumentSymbol === "MES"
        ? "MNQ"
        : "MES";

    const current = crossMarketProfile(
      snapshot,
      instrumentSymbol
    );

    const other = crossMarketProfile(
      snapshot,
      otherSymbol
    );

    if (
      current.direction === "NO EDGE" ||
      other.direction === "NO EDGE"
    ) {
      return {
        status: "UNKNOWN",
        label: "CROSS-MARKET UNKNOWN",
        detail: "A complete MES/MNQ directional comparison is unavailable.",
        cls: "unknown",
        blocksEntry: false,
        caution: false,
        current,
        other,
      };
    }

    if (
      current.direction ===
      other.direction
    ) {
      const confirmed =
        current.candidate &&
        other.candidate;

      return {
        status:
          confirmed
            ? "CONFIRMED"
            : "SAME_DIRECTION_WEAK",
        label:
          confirmed
            ? `CONFIRMED · ${current.direction}`
            : `SAME DIRECTION · ${otherSymbol} WEAK`,
        detail:
          confirmed
            ? `${instrumentSymbol} and ${otherSymbol} both have credible ${current.direction} setups.`
            : `${instrumentSymbol} and ${otherSymbol} point ${current.direction}, but ${otherSymbol} does not currently have a credible setup.`,
        cls:
          confirmed
            ? "confirmed"
            : "stable",
        blocksEntry: false,
        caution: false,
        current,
        other,
      };
    }

    // Opposite directions: a weak, blocked, or no-setup other index does not veto.
    if (
      current.candidate &&
      !other.candidate
    ) {
      return {
        status: "CURRENT_DOMINANT_WEAK_OTHER",
        label: `${instrumentSymbol} DOMINANT`,
        detail: `${otherSymbol} points ${other.direction}, but its opposing setup is weak, blocked, or not tradeable enough to veto ${instrumentSymbol}.`,
        cls: "info",
        blocksEntry: false,
        caution: false,
        current,
        other,
      };
    }

    if (
      !current.candidate &&
      other.candidate
    ) {
      return {
        status: "OTHER_DOMINANT",
        label: `${otherSymbol} DOMINANT`,
        detail: `${otherSymbol} has the credible opposing setup while ${instrumentSymbol} does not.`,
        cls: "blocked",
        blocksEntry: true,
        caution: false,
        current,
        other,
      };
    }

    if (
      !current.candidate &&
      !other.candidate
    ) {
      return {
        status: "NO_CREDIBLE_CROSS_MARKET_EDGE",
        label: "CROSS-MARKET NEUTRAL",
        detail: "MES and MNQ disagree, but neither side has a credible cross-market setup.",
        cls: "stable",
        blocksEntry: false,
        caution: false,
        current,
        other,
      };
    }

    const tradeabilityGap =
      current.tradeability -
      other.tradeability;

    const setupGap =
      current.setupSupport -
      other.setupSupport;

    const currentClearlyDominant = Boolean(
      current.marketPermission === "ALLOW" &&
      tradeabilityGap >=
        CROSS_MARKET_TRADEABILITY_GAP &&
      setupGap >=
        CROSS_MARKET_SETUP_GAP
    );

    const otherClearlyDominant = Boolean(
      other.marketPermission === "ALLOW" &&
      tradeabilityGap <=
        -CROSS_MARKET_TRADEABILITY_GAP &&
      setupGap <=
        -CROSS_MARKET_SETUP_GAP
    );

    if (
      currentClearlyDominant
    ) {
      return {
        status: "CURRENT_DOMINANT",
        label: `DIVERGENCE · ${instrumentSymbol} DOMINANT`,
        detail: `${instrumentSymbol} leads the opposing ${otherSymbol} setup by ${fmt(Math.abs(tradeabilityGap), 1)} Directional Confluence and ${fmt(Math.abs(setupGap), 1)} Setup Support points. The trade remains eligible, but broad index confirmation is absent.`,
        cls: "caution",
        blocksEntry: false,
        caution: true,
        current,
        other,
      };
    }

    if (
      otherClearlyDominant
    ) {
      return {
        status: "OTHER_DOMINANT",
        label: `DIVERGENCE · ${otherSymbol} DOMINANT`,
        detail: `${otherSymbol} leads the opposing ${instrumentSymbol} setup by ${fmt(Math.abs(tradeabilityGap), 1)} Directional Confluence and ${fmt(Math.abs(setupGap), 1)} Setup Support points. Do not take the weaker ${instrumentSymbol} side.`,
        cls: "blocked",
        blocksEntry: true,
        caution: false,
        current,
        other,
      };
    }

    if (
      current.strong &&
      other.strong
    ) {
      return {
        status: "STRONG_DIVERGENCE",
        label: "STRONG DIVERGENCE · WAIT",
        detail: `${instrumentSymbol} is ${current.direction} and ${otherSymbol} is ${other.direction}; both have strong, tradeable opposing setups without a clear dominant side. Wait for index alignment or one thesis to weaken.`,
        cls: "blocked",
        blocksEntry: true,
        caution: false,
        current,
        other,
      };
    }

    return {
      status: "DIVERGENCE_CAUTION",
      label: "CROSS-MARKET DIVERGENCE",
      detail: `${instrumentSymbol} and ${otherSymbol} point in opposite directions. Both are credible, but at least one is below the strong-divergence threshold. Require cleaner confirmation before entry.`,
      cls: "caution",
      blocksEntry: false,
      caution: true,
      current,
      other,
    };
  }

  function executionState(
    snapshot,
    instrumentSymbol,
    bullish,
    bearish
  ) {
    const choice = chooseDominantScenario(
      bullish,
      bearish
    );

    const dominant = choice.dominant;
    const opposite = choice.opposite;

    const row = instrumentData(
      snapshot,
      instrumentSymbol
    );

    const tech = techData(
      snapshot,
      instrumentSymbol
    );

    const of = recommendationOrderflow(
      snapshot,
      instrumentSymbol
    );

    const sessionGate = marketOpenGate(
      snapshot
    );

    const marketCondition =
      marketConditionFor(
        snapshot,
        instrumentSymbol
      );

    const crossMarketGate =
      buildCrossMarketGate(
        snapshot,
        instrumentSymbol
      );

    if (!dominant || !row) {
      return {
        bias: "NO EDGE",
        biasClass: "neutral",
        state: "DATA INCOMPLETE",
        stateClass: "incomplete",
        action: "Wait for a complete cycle.",
        blocker: "Missing model inputs.",
        exitPlan: "No trade.",
        spread: choice.spread,
        sessionGate,
        gexGate: {
          status: "UNKNOWN",
          label: "GEX CHANGE UNKNOWN",
          detail: "No complete execution scenario.",
          cls: "unknown",
          blocksEntry: false,
          caution: false,
        },
        marketCondition,
        crossMarketGate,
      };
    }

    const sideSign =
      dominant.side === "BULLISH"
        ? 1
        : -1;

    const bias =
      sideSign > 0
        ? "LONG"
        : "SHORT";

    const biasClass =
      sideSign > 0
        ? "positive"
        : "negative";

    const room = executionTargetRoom(
      snapshot,
      dominant
    );

    const gexGate =
      buildGexExecutionGate(
        snapshot,
        instrumentSymbol,
        dominant,
        opposite
      );

    const techScore =
      technicalScore5m(tech);

    const techAligned =
      Number.isFinite(techScore) &&
      (
        (
          sideSign > 0 &&
          techScore >= 3
        ) ||
        (
          sideSign < 0 &&
          techScore <= -3
        )
      );

    const techPosition =
      technicalPosition(
        tech,
        sideSign
      );

    const modelSign =
      signOfBias(row?.bias);

    const modelAligned =
      modelSign === sideSign;

    const regimeSign = of.fresh
      ? signWithDeadZone(
          of.model?.regime_direction
        )
      : 0;

    const triggerSign = of.fresh
      ? signWithDeadZone(
          of.model?.trigger_direction
        )
      : 0;

    const combinedSign = of.fresh
      ? signWithDeadZone(
          of.model?.effective_direction ?? of.model?.combined_direction
        )
      : 0;

    const regimeAligned =
      regimeSign === sideSign;

    const regimeOpposed =
      regimeSign === -sideSign;

    const triggerAligned =
      triggerSign === sideSign;

    const triggerOpposed =
      triggerSign === -sideSign;

    const combinedOpposed =
      combinedSign === -sideSign;

    const targetText =
      dominant.targetText ||
      "Target unavailable";

    const executionAssetSymbol =
      dominant.assetSymbol ||
      (instrumentSymbol === "MES" ? "SPX" : "QQQ");

    const executionSpot = Number(
      snapshot?.gex_context
        ?.symbols?.[executionAssetSymbol]
        ?.price
    );

    const spotText =
      Number.isFinite(executionSpot)
        ? `${executionAssetSymbol} ${fmt(executionSpot, executionAssetSymbol === "SPX" ? 1 : 2)}`
        : `${executionAssetSymbol} spot unavailable`;

    const executionTargetSummary =
      targetText;

    const techText =
      Number.isFinite(techScore)
        ? `${techScore >= 0 ? "+" : ""}${techScore}`
        : "N/A";

    const positionText =
      techPosition.available
        ? (
            `${techPosition.aligned}/${techPosition.available} ` +
            `above/below VWAP·EMA9·EMA21`
          )
        : "VWAP/EMA position unavailable";

    const regimeText =
      of.fresh
        ? String(
            of.model?.regime_bias ||
            "MIXED"
          ).replaceAll("_", " ")
        : "STALE";

    const triggerText =
      of.fresh
        ? String(
            of.model?.trigger_bias ||
            "MIXED"
          ).replaceAll("_", " ")
        : "STALE";

    const roomText =
      room.valid
        ? (
            `${fmt(Math.max(room.distance, 0), 2)} ` +
            `${dominant.assetSymbol} pts · ${room.label}`
          )
        : "Unknown";

    let state =
      "WAIT";

    let stateClass =
      "waiting";

    let action =
      "Wait for confirmation.";

    let blocker =
      "Setup is not ready.";

    if (!dominant.complete) {
      state =
        "DATA INCOMPLETE";

      stateClass =
        "incomplete";

      action =
        "Wait for fresh model, technical, target, and Order Flow data.";

      blocker =
        "One or more execution inputs are missing or stale.";
    }
    else if (!choice.candidate) {
      state =
        "NO CLEAR SETUP";

      stateClass =
        "blocked";

      action =
        "Stand aside. Wait for one scenario to reach 60+ and lead by at least 10.";

      blocker =
        `Scenario spread ${fmt(choice.spread, 0)} is not strong enough and/or the leading score is below 60.`;
    }
    else if (
      !room.valid
    ) {
      state =
        "WAIT FOR TARGET";

      stateClass =
        "waiting";

      action =
        "Do not enter until a valid target and room can be measured.";

      blocker =
        "Target room cannot be determined.";
    }
    else if (
      room.distance <= 0
    ) {
      state =
        "TARGET PASSED";

      stateClass =
        "blocked";

      action =
        "Do not chase. Wait for the next model cycle to establish a new target.";

      blocker =
        `${targetText} is no longer ahead of spot.`;
    }
    else if (
      room.pct <= 0.06
    ) {
      state =
        "DO NOT CHASE";

      stateClass =
        "blocked";

      action =
        "Target is too close for a fresh entry. Wait for a new target or a pullback that improves R:R.";

      blocker =
        `${targetText} is only ${roomText} away.`;
    }
    else if (
      gexGate.blocksEntry
    ) {
      state =
        gexGate.status === "SIGN_FLIP"
          ? "GEX REGIME CHANGE"
          : gexGate.status === "TARGET_SHIFT"
            ? "GEX TARGET SHIFT"
            : gexGate.status === "TARGET_LOST"
              ? "GEX TARGET LOST"
              : "GEX CONFLICT";

      stateClass =
        "blocked";

      action =
        gexGate.status === "SIGN_FLIP"
          ? "WAIT FOR NEXT GEX UPDATE. Confirm that the new sign/role persists before considering entry."
          : gexGate.status === "TARGET_SHIFT"
            ? "REASSESS TARGET. Wait one cycle for the new primary target to persist before entry."
            : gexGate.status === "TARGET_LOST"
              ? "DO NOT ENTER. Wait for a stable replacement target."
              : "DO NOT ENTER while the new opposing GEX acceleration structure is building.";

      blocker =
        gexGate.detail;
    }
    else if (
      marketCondition.execution_permission === "BLOCK"
    ) {
      const condition =
        String(
          marketCondition.condition ||
          ""
        ).toUpperCase();

      state =
        condition === "CHOPPY"
          ? "NO TRADE · CHOPPY"
          : condition === "CHAOTIC_VOLATILITY"
            ? "NO TRADE · CHAOTIC VOLATILITY"
            : "NO TRADE · MARKET CONDITION";

      stateClass =
        "blocked";

      action =
        condition === "CHOPPY"
          ? "STAND ASIDE. Wait for EMA/VWAP whipsaw and directional inefficiency to clear before using any 10m L/S signal."
          : condition === "CHAOTIC_VOLATILITY"
            ? "STAND ASIDE. Wait for range/wick contraction and any extreme-bar cooldown to finish before looking for an entry."
            : "STAND ASIDE until a valid market-condition reading is available.";

      blocker =
        marketCondition.detail ||
        marketConditionMetricText(
          marketCondition
        );
    }
    else if (
      crossMarketGate.blocksEntry
    ) {
      state =
        crossMarketGate.status === "STRONG_DIVERGENCE"
          ? "STRONG CROSS-MARKET DIVERGENCE"
          : crossMarketGate.status === "OTHER_DOMINANT"
            ? `${crossMarketGate.other.instrument} DOMINANT · WAIT`
            : "CROSS-MARKET CONFLICT";

      stateClass =
        "blocked";

      action =
        crossMarketGate.status === "STRONG_DIVERGENCE"
          ? "STAND ASIDE. MES and MNQ have strong opposing setups. Wait for index alignment or for one thesis to materially weaken."
          : `Do not take ${instrumentSymbol}. The opposing ${crossMarketGate.other.instrument} setup is clearly stronger.`;

      blocker =
        crossMarketGate.detail;
    }
    else if (
      !modelAligned
    ) {
      state =
        "WAIT MODEL ALIGNMENT";

      stateClass =
        "waiting";

      action =
        `Keep ${bias} on watch, but wait for the production model to align.`;

      blocker =
        `Dominant scenario is ${bias}, while production model is ${String(row?.bias || "N/A").replaceAll("_", " ")}.`;
    }
    else if (
      !techAligned
    ) {
      state =
        "WAIT 5m CONFIRMATION";

      stateClass =
        "waiting";

      action =
        sideSign > 0
          ? "Wait for 5m technical score ≥ +3 and price to reclaim/hold key execution structure."
          : "Wait for 5m technical score ≤ -3 and price to reject/hold below key execution structure.";

      blocker =
        `5m technical score ${techText}; ${positionText}.`;
    }
    else if (
      !of.fresh
    ) {
      state =
        "WAIT ORDER FLOW";

      stateClass =
        "waiting";

      action =
        `Technical setup is aligned, but wait for fresh ${of.futuresSymbol} Order Flow before entry.`;

      blocker =
        `${of.futuresSymbol} Order Flow is not fresh.`;
    }
    else if (
      regimeOpposed ||
      combinedOpposed
    ) {
      state =
        "ORDER FLOW CONFLICT";

      stateClass =
        "blocked";

      action =
        `Do not enter ${bias} while ${of.futuresSymbol} auction flow is materially opposing.`;

      blocker =
        `10m regime ${regimeText}; combined ${String(of.model?.bias || "MIXED").replaceAll("_", " ")}.`;
    }
    else if (
      regimeAligned &&
      triggerOpposed
    ) {
      state =
        "WAIT PULLBACK";

      stateClass =
        "waiting";

      action =
        sideSign > 0
          ? `Broader ${of.futuresSymbol} auction supports LONG, but the short-horizon trigger is bearish. Wait for it to turn neutral → bullish.`
          : `Broader ${of.futuresSymbol} auction supports SHORT, but the short-horizon trigger is bullish. Wait for it to turn neutral → bearish.`;

      blocker =
        `10m regime ${regimeText}; short-horizon trigger ${triggerText}.`;
    }
    else if (
      !triggerAligned
    ) {
      state =
        "WAIT ORDER FLOW TRIGGER";

      stateClass =
        "waiting";

      action =
        sideSign > 0
          ? `Wait for the ${of.futuresSymbol} short-horizon trigger to turn bullish.`
          : `Wait for the ${of.futuresSymbol} short-horizon trigger to turn bearish.`;

      blocker =
        `Short-horizon trigger is ${triggerText}.`;
    }
    else {
      if (crossMarketGate.caution) {
        state =
          crossMarketGate.status === "CURRENT_DOMINANT"
            ? `CROSS-MARKET · ${instrumentSymbol} DOMINANT`
            : "CROSS-MARKET DIVERGENCE · CAUTION";

        stateClass =
          "waiting";

        action =
          crossMarketGate.status === "CURRENT_DOMINANT"
            ? `${instrumentSymbol} remains the stronger eligible setup, but MES/MNQ disagree. Require the matching 10m L/S trigger, clean structure, and normal dollar risk; do not chase.`
            : "MES and MNQ disagree. Wait for cleaner cross-market confirmation or a clearly dominant setup before entry.";

        blocker =
          crossMarketGate.detail;
      }
      else if (
        String(
          marketCondition.execution_permission ||
          ""
        ).toUpperCase() !== "ALLOW"
      ) {
        const condition = String(
          marketCondition.condition ||
          "ORDERLY_MIXED"
        ).toUpperCase();

        state =
          condition === "VOLATILE_TREND"
            ? "VOLATILE TREND · WAIT 10m L/S"
            : "ORDERLY MIXED · WAIT 10m L/S";

        stateClass =
          "waiting";

        action =
          condition === "VOLATILE_TREND"
            ? (
                sideSign > 0
                  ? "Model, 5m technicals and Order Flow are aligned. Take only a clean LONG pullback/retest plus matching 10m L; keep normal dollar risk and do not widen the stop for volatility."
                  : "Model, 5m technicals and Order Flow are aligned. Take only a clean SHORT rejection/retest plus matching 10m S; keep normal dollar risk and do not widen the stop for volatility."
              )
            : (
                sideSign > 0
                  ? "Environment is orderly but not strongly trending. Take only a matching 10m L with clean structure and acceptable R:R; the remaining model gates are aligned."
                  : "Environment is orderly but not strongly trending. Take only a matching 10m S with clean structure and acceptable R:R; the remaining model gates are aligned."
              );

        blocker =
          marketCondition.detail ||
          marketConditionMetricText(
            marketCondition
          );
      }
      else if (gexGate.caution) {
        state =
          "GEX WEAKENING · CAUTION";

        stateClass =
          "waiting";

        action =
          sideSign > 0
            ? "Setup is otherwise aligned, but target GEX is weakening. Only consider a LONG on a clean 5m trigger with confirming Order Flow; do not chase."
            : "Setup is otherwise aligned, but target GEX is weakening. Only consider a SHORT on a clean 5m trigger with confirming Order Flow; do not chase.";

        blocker =
          gexGate.detail;
      }
      else {
        state =
          "MODEL READY · WAIT 10m L/S";

        stateClass =
          "ready";

        action =
          sideSign > 0
            ? "Environment is TRENDABLE and all model gates are aligned. Take only a matching 10m L signal, then use a structural stop and confirm sufficient R:R to the SPX/QQQ target."
            : "Environment is TRENDABLE and all model gates are aligned. Take only a matching 10m S signal, then use a structural stop and confirm sufficient R:R to the SPX/QQQ target.";

        blocker =
          "No model blocker remains. The 10m EMA/CCI L/S indicator is the final manual entry trigger.";
      }
    }

    // Hard cash-open gate:
    // during warm-up/pre-open, preserve the analytical bias/target
    // but block execution regardless of how attractive the setup looks.
    if (sessionGate.blocksReady) {
      state =
        sessionGate.phase === "WARMUP"
          ? "MARKET OPEN WARM-UP"
          : "PRE-OPEN";

      stateClass =
        "warmup";

      action =
        sessionGate.phase === "WARMUP"
          ? "OBSERVE ONLY. Let opening price discovery, VWAP, 5m structure, Flowline, and ES/NQ auction flow develop. Normal execution unlocks at 9:00 AM CT."
          : "OBSERVE ONLY. Cash-session execution is locked until 9:00 AM CT.";

      blocker =
        sessionGate.detail;
    }

    // V26_BACKEND_EXECUTION_OVERRIDE
    // Latest V26 snapshots use the exact backend execution decision saved in
    // source_status.execution_v26. Historical pre-V26 rows keep legacy logic.
    const v26Package = normalizeJsonObject(
      snapshot?.source_status?.execution_v26 ?? null
    );
    const v26Execution =
      v26Package?.instruments?.[instrumentSymbol] || null;

    if (
      v26Execution &&
      String(v26Package?.model_version || "").startsWith("V26_")
    ) {
      state = v26Execution.state || state;
      stateClass = v26Execution.state_class || stateClass;
      action = v26Execution.action || action;
      blocker =
        v26Execution.blocker === null
          ? "No blocker remains. V26 causal 5m + 10m structure is aligned."
          : (v26Execution.blocker || blocker);
    }

    const oppositeLabel =
      opposite?.side === "BULLISH"
        ? "Bull"
        : "Bear";

    const dominantLabel =
      dominant.side === "BULLISH"
        ? "Bull"
        : "Bear";

    const exitPlan =
      (
        `Primary: ${targetText}. ` +
        `Early exit/reassess if ${oppositeLabel} overtakes ${dominantLabel} by ≥10, ` +
        `the primary GEX target shifts/disappears/sign-flips, ` +
        `market condition deteriorates into CHOPPY/CHAOTIC, ` +
        `cross-market confirmation flips into strong opposing divergence, ` +
        `or 5m technicals + ${of.futuresSymbol} Order Flow reverse against the trade.`
      );

    return {
      bias,
      biasClass,
      state,
      stateClass,
      action,
      blocker,
      exitPlan,
      dominant,
      opposite,
      spread: choice.spread,
      room,
      roomText,
      techScore,
      techText,
      techPosition,
      positionText,
      modelAligned,
      of,
      regimeText,
      triggerText,
      regimeAligned,
      triggerAligned,
      targetText,
      executionAssetSymbol,
      executionSpot,
      spotText,
      executionTargetSummary,
      sessionGate,
      gexGate,
      marketCondition,
      crossMarketGate,
    };
  }

  // V26_3_4_LIGHT_CHART_EXECUTION_CONTEXT
  // DISPLAY ONLY. Reads already-saved shadow/context fields.

  function compactDirectionalClass(value, stale = false) {
    if (stale) return "unknown";
    const v = String(value || "").toUpperCase();

    if (v.includes("BULL") || v === "LONG" || v.includes("RISING")) {
      return "positive";
    }

    if (v.includes("BEAR") || v === "SHORT" || v.includes("FALLING")) {
      return "negative";
    }

    if (
      v.includes("NEUTRAL") ||
      v.includes("MIXED") ||
      v.includes("FLAT") ||
      v.includes("LOW_QUALITY")
    ) {
      return "neutral";
    }

    return "unknown";
  }

  function displayBias(value) {
    return String(value || "NO DATA").replaceAll("_", " ");
  }

  function optionFlow0dte15mState(snapshot, instrumentSymbol) {
    const assetSymbol = instrumentSymbol === "MES" ? "SPX" : "QQQ";

    const root =
      normalizeJsonObject(
        snapshot?.options_flow_0dte ??
        snapshot?.optionsFlow0dte ??
        null
      ) || {};

    const asset =
      root?.assets?.[assetSymbol] ||
      root?.symbols?.[assetSymbol] ||
      {};

    const window15 =
      asset?.windows?.["15m"] ||
      asset?.states?.["15m"] ||
      asset?.timeframes?.["15m"] ||
      asset?.["15m"] ||
      {};

    const bias =
      window15?.bias ||
      window15?.bias_label ||
      window15?.signal ||
      window15?.state ||
      asset?.shadow_signal_15m ||
      asset?.signal_15m ||
      asset?.shadow_signal ||
      "NO DATA";

    const quality = [
      window15?.quality,
      window15?.quality_score,
      window15?.signal_quality,
      asset?.quality_15m,
    ].map(Number).find(Number.isFinite);

    const pressure = [
      window15?.effective_pressure,
      window15?.quality_adjusted_effective_pressure,
      window15?.adjusted_pressure,
      window15?.pressure,
      asset?.effective_pressure_15m,
      asset?.pressure_15m,
    ].map(Number).find(Number.isFinite);

    const noData =
      !asset ||
      Object.keys(asset).length === 0 ||
      String(bias).toUpperCase() === "NO DATA";

    return {
      assetSymbol,
      bias,
      quality: Number.isFinite(quality) ? quality : null,
      pressure: Number.isFinite(pressure) ? pressure : null,
      noData,
      cls: compactDirectionalClass(bias, noData),
    };
  }

  function optionFlowlineState(snapshot, instrumentSymbol) {
    const assetSymbol = instrumentSymbol === "MES" ? "SPX" : "QQQ";
    const row = snapshot?.flowline?.symbols?.[assetSymbol] || null;
    const stale = !row || Boolean(row?.data_stale);
    const bias = stale
      ? (row ? "STALE" : "NO DATA")
      : (row?.flow_bias || row?.bias || "NO DATA");

    return {
      assetSymbol,
      bias,
      stale,
      cls: compactDirectionalClass(bias, stale),
    };
  }

  function executionDisplayContext(snapshot, instrumentSymbol) {
    return {
      optionFlow0dte: optionFlow0dte15mState(snapshot, instrumentSymbol),
      flowline: optionFlowlineState(snapshot, instrumentSymbol),
    };
  }

  function compact0dteDetail(row) {
    if (!row || row.noData) {
      return `${row?.assetSymbol || "SPX/QQQ"} · NO DATA`;
    }

    const pieces = [`${row.assetSymbol} ${displayBias(row.bias)}`];

    if (Number.isFinite(Number(row.quality))) {
      pieces.push(`Q${Number(row.quality).toFixed(0)}`);
    }

    if (Number.isFinite(Number(row.pressure))) {
      const n = Number(row.pressure);
      pieces.push(`${n > 0 ? "+" : ""}${n.toFixed(2)}`);
    }

    return pieces.join(" · ");
  }

  function compactFlowlineDetail(row) {
    if (!row) return "NO DATA";
    return `${row.assetSymbol} · ${displayBias(row.bias)}`;
  }
  function executionScenarioScores(execution) {
    const dominant = execution?.dominant;
    const opposite = execution?.opposite;

    let bull = null;
    let bear = null;

    [dominant, opposite].forEach(row => {
      if (!row) return;

      if (row.side === "BULLISH") {
        bull = Number(row.score);
      }
      else if (row.side === "BEARISH") {
        bear = Number(row.score);
      }
    });

    return {
      bull:
        Number.isFinite(bull)
          ? bull
          : null,
      bear:
        Number.isFinite(bear)
          ? bear
          : null,
    };
  }

  function compactOfClass(execution) {
    const side = String(
      execution?.regimeText || ""
    ).toUpperCase();

    if (side.includes("BULL")) {
      return "positive";
    }

    if (side.includes("BEAR")) {
      return "negative";
    }

    return "neutral";
  }

  function compactTechClass(execution) {
    const score = Number(
      execution?.techScore
    );

    if (!Number.isFinite(score)) {
      return "neutral";
    }

    if (score >= 3) {
      return "positive";
    }

    if (score <= -3) {
      return "negative";
    }

    return "neutral";
  }

  function renderExecutionState(execution) {
    const sideClass =
      execution.bias === "LONG"
        ? "bullish"
        : execution.bias === "SHORT"
          ? "bearish"
          : "neutral";

    const actionClass =
      execution.stateClass === "ready"
        ? "ready"
        : execution.stateClass === "blocked"
          ? "blocked"
          : execution.stateClass === "warmup"
            ? "warmup"
            : execution.stateClass === "incomplete"
              ? "incomplete"
              : "waiting";

    const scores =
      executionScenarioScores(
        execution
      );

    const bullScore =
      Number.isFinite(scores.bull)
        ? fmt(scores.bull, 0)
        : "—";

    const bearScore =
      Number.isFinite(scores.bear)
        ? fmt(scores.bear, 0)
        : "—";

    const displayContext =
      execution?.displayContext ||
      {};

    const option0dte =
      displayContext.optionFlow0dte ||
      null;

    const flowline =
      displayContext.flowline ||
      null;

    return `
      <div class="execution-state decision-view ${sideClass}">
        <div class="decision-state-row">
          <div>
            <div class="execution-eyebrow">DECISION</div>
            <div class="execution-bias ${execution.biasClass}">
              ${esc(execution.bias)}
            </div>
          </div>

          <div class="execution-state-badge ${execution.stateClass}">
            ${esc(execution.state)}
          </div>
        </div>

        <div class="decision-core-grid decision-core-grid-single">
          <div class="decision-core-item price-path">
            <span>CURRENT → TARGET</span>
            <strong>
              ${esc(execution.spotText || "N/A")}
              <b>→</b>
              ${esc(execution.executionTargetSummary || "N/A")}
            </strong>
            <small>
              ${esc(execution.roomText || "Room unknown")}
              · Setup spread ${fmt(execution.spread, 0)}
            </small>
          </div>
        </div>

        <div class="decision-condition-grid">
          <div class="decision-condition ${marketConditionClass(execution.marketCondition)}">
            <span>MARKET</span>
            <strong>${esc(marketConditionLabel(execution.marketCondition))}</strong>
          </div>

          <div class="decision-condition ${execution.gexGate?.cls || "unknown"}">
            <span>GEX</span>
            <strong>${esc(execution.gexGate?.label || "UNKNOWN")}</strong>
          </div>

          <div class="decision-condition ${execution.crossMarketGate?.cls || "unknown"}">
            <span>CROSS-MKT</span>
            <strong>${esc(execution.crossMarketGate?.label || "UNKNOWN")}</strong>
          </div>

          <div class="decision-condition ${compactOfClass(execution)}">
            <span>ORDER FLOW</span>
            <strong>
              ${esc(execution.regimeText || "N/A")}
              · trigger ${esc(execution.triggerText || "N/A")}
            </strong>
          </div>

          <div class="decision-condition ${option0dte?.cls || "unknown"}">
            <span>0DTE 15m · SHADOW</span>
            <strong>${esc(compact0dteDetail(option0dte))}</strong>
          </div>

          <div class="decision-condition ${flowline?.cls || "unknown"}">
            <span>OPTION FLOWLINE</span>
            <strong>${esc(compactFlowlineDetail(flowline))}</strong>
          </div>
        </div>

        <div class="execution-action decision-action ${actionClass}">
          <span>ACTION</span>
          <div>
            <strong>${esc(execution.action)}</strong>
            <small>${esc(execution.blocker)}</small>
          </div>
        </div>
      </div>
    `;
  }

  function renderExecutionDiagnostics(execution) {
    return `
      <div class="execution-diagnostics">
        <div class="session-gate ${execution.sessionGate?.cls || "unknown"}">
          <div class="session-gate-label">
            ${esc(execution.sessionGate?.label || "SESSION TIME UNKNOWN")}
          </div>
          <div class="session-gate-detail">
            ${esc(execution.sessionGate?.detail || "Snapshot time unavailable.")}
          </div>
        </div>

        <div class="gex-execution-gate ${execution.gexGate?.cls || "unknown"}">
          <div class="gex-execution-label">
            ${esc(execution.gexGate?.label || "GEX CHANGE UNKNOWN")}
          </div>
          <div class="gex-execution-detail">
            ${esc(execution.gexGate?.detail || "No GEX structural-change status.")}
          </div>
        </div>

        <div class="gex-execution-gate ${execution.crossMarketGate?.cls || "unknown"}">
          <div class="gex-execution-label">
            CROSS-MARKET · ${esc(execution.crossMarketGate?.label || "UNKNOWN")}
          </div>
          <div class="gex-execution-detail">
            ${esc(execution.crossMarketGate?.detail || "No cross-market status.")}
          </div>
        </div>

        <div class="market-condition-gate ${marketConditionClass(execution.marketCondition)}">
          <div>
            <div class="market-condition-label">
              MARKET CONDITION ·
              ${esc(marketConditionLabel(execution.marketCondition))}
            </div>
            <div class="market-condition-detail">
              ${esc(marketConditionMetricText(execution.marketCondition))}
            </div>
          </div>

          <div class="market-condition-score">
            <strong>
              ${execution.marketCondition?.environment_score ?? "—"}
            </strong>
            <span>ENV</span>
          </div>
        </div>

        <div class="execution-facts">
          <div>
            <span>Target</span>
            <strong>${esc(execution.targetText || "N/A")}</strong>
          </div>

          <div>
            <span>Room</span>
            <strong>${esc(execution.roomText || "Unknown")}</strong>
          </div>

          <div>
            <span>5m Tech</span>
            <strong>
              ${esc(execution.techText || "N/A")} ·
              ${esc(execution.positionText || "N/A")}
            </strong>
          </div>

          <div>
            <span>Order Flow</span>
            <strong>
              ${esc(execution.of?.futuresSymbol || "ES/NQ")} 10m
              ${esc(execution.regimeText || "N/A")} · trigger
              ${esc(execution.triggerText || "N/A")}
            </strong>
          </div>
        </div>

        <div class="execution-exit">
          <span>IF ENTERED · EXIT / REASSESS</span>
          <div>${esc(execution.exitPlan)}</div>
        </div>
      </div>
    `;
  }

  function renderScenarioFactor(label, value) {
    return `
      <div class="reco-factor">
        <div class="reco-factor-label">${esc(label)}</div>
        <div class="reco-factor-value">${fmt(value, 0)}</div>
      </div>
    `;
  }

  function renderTradeScenario(scenario) {
    const sideClass = scenario.side === "BULLISH" ? "bullish" : "bearish";
    const arrow = scenario.side === "BULLISH" ? "↑" : "↓";

    const targetDetail = scenario.target
      ? `
        <div class="reco-target">
          <span>${esc(scenario.targetText)}</span>
          <strong>${fmt(scenario.target.attraction_score, 1)}</strong>
        </div>
        <div class="reco-reaction">${esc(scenario.reaction)}</div>
      `
      : `
        <div class="reco-target unavailable">
          <span>${esc(scenario.targetText)}</span>
        </div>
      `;

    const ofText = scenario.freshOrderflow
      ? (
          `${scenario.futuresSymbol} ` +
          `${String(scenario.ofBias).replaceAll("_", " ")} · ` +
          `${fmtSigned(scenario.ofDirection, 3)} · ` +
          `Q${fmt(scenario.ofQuality, 0)}`
        )
      : `${scenario.futuresSymbol} ORDER FLOW NOT FRESH`;

    return `
      <div class="trade-reco ${sideClass}">
        <div class="reco-top">
          <div>
            <div class="reco-side">${scenario.side} ${arrow}</div>
            <div class="reco-status ${scenario.tier.cls}">
              ${esc(scenario.tier.label)}
            </div>
          </div>

          <div class="reco-score-wrap">
            <div class="reco-score">${fmt(scenario.score, 0)}</div>
            <div class="reco-score-label">SETUP SUPPORT</div>
          </div>
        </div>

        ${targetDetail}

        <div class="reco-factor-grid">
          ${renderScenarioFactor("MODEL", scenario.modelSupport)}
          ${renderScenarioFactor("TARGET", scenario.targetSupport)}
          ${renderScenarioFactor("ORDER FLOW", scenario.orderflowSupport)}
        </div>

        <div class="reco-context">
          <div>
            <span>Model</span>
            <strong class="${biasClass(scenario.modelBias)}">
              ${esc(String(scenario.modelBias).replaceAll("_", " "))}
            </strong>
          </div>

          <div>
            <span>5m Tech</span>
            <strong class="${biasClass(scenario.techBias)}">
              ${esc(String(scenario.techBias).replaceAll("_", " "))}
            </strong>
          </div>

          <div>
            <span>Order Flow</span>
            <strong class="${scenario.freshOrderflow ? biasClass(scenario.ofBias) : "muted"}">
              ${esc(ofText)}
            </strong>
          </div>
        </div>
      </div>
    `;
  }

  function renderInstrumentCards(snapshot, containerId) {
    const container = $(containerId);
    container.innerHTML = "";

    const preferred = snapshot?.preferred_instrument ||
      snapshot?.attraction?.preference?.preferred;

    ["MES", "MNQ"].forEach(symbol => {
      const row = instrumentData(snapshot, symbol);

      if (!row) {
        container.insertAdjacentHTML("beforeend", `
          <article class="instrument-card">
            <div class="instrument-symbol">${symbol}</div>
            <p class="muted">No model score for this cycle.</p>
          </article>
        `);
        return;
      }

      const components = row.components || {};

      const componentHtml = Object.entries(components)
        .map(([key, value]) => `
          <div class="component-pill">
            ${esc(key.replaceAll("_", " "))}:
            <strong>${fmtSigned(value?.direction_value, 2)}</strong>
          </div>
        `)
        .join("");

      const bullish = buildTradeScenario(
        snapshot,
        symbol,
        "BULLISH"
      );

      const bearish = buildTradeScenario(
        snapshot,
        symbol,
        "BEARISH"
      );

      const execution = executionState(
        snapshot,
        symbol,
        bullish,
        bearish
      );

      execution.displayContext =
        executionDisplayContext(
          snapshot,
          symbol
        );

      const headerScores =
        executionScenarioScores(
          execution
        );

      const headerBull =
        Number.isFinite(headerScores.bull)
          ? fmt(headerScores.bull, 0)
          : "—";

      const headerBear =
        Number.isFinite(headerScores.bear)
          ? fmt(headerScores.bear, 0)
          : "—";

      container.insertAdjacentHTML("beforeend", `
        <article class="instrument-card ${preferred === symbol ? "preferred" : ""}">
          <div class="instrument-top">
            <div>
              <div class="instrument-symbol-line">
                <div class="instrument-symbol">${symbol}</div>
                ${preferred === symbol ? `<span class="preferred-badge">★ PREFERRED</span>` : ""}
              </div>
              <div class="instrument-bias ${biasClass(row.bias)}">
                ${esc(String(row.bias || "N/A").replaceAll("_", " "))}
              </div>
            </div>

            <div class="instrument-score-cluster">
              <div class="instrument-support-compact">
                <div class="instrument-score-label">SETUP SUPPORT</div>
                <div class="instrument-support-values">
                  <span class="positive">Bull ${headerBull}</span>
                  <b>/</b>
                  <span class="negative">Bear ${headerBear}</span>
                </div>
              </div>

              <div class="instrument-confluence-compact">
                <div class="tradeability-number">${fmt(row.tradeability_score, 1)}</div>
                <div class="tradeability-label">
                  DIRECTIONAL CONFLUENCE ·
                  ${esc(String(row.tradeability_confidence || "N/A").replaceAll("_", " "))}
                </div>
              </div>
            </div>
          </div>

          ${renderExecutionState(execution)}

          <details class="decision-details">
            <summary>
              <span>Details & diagnostics</span>
              <small>Gates · components · scenarios · exit plan</small>
            </summary>

            <div class="decision-details-body">
              ${renderExecutionDiagnostics(execution)}

              <div class="diagnostic-section">
                <div class="diagnostic-section-title">PRODUCTION COMPONENTS</div>
                <div class="component-bar">${componentHtml}</div>
              </div>

              <div class="trade-reco-header">
                <div>
                  <div class="trade-reco-title">TRADE SCENARIOS</div>
                  <div class="trade-reco-caption">
                    70% production model · 30% target attraction · OF freshness/conflict gated
                  </div>
                </div>

                <div class="trade-reco-note">
                  DISPLAY OVERLAY · NOT WIN PROBABILITY
                </div>
              </div>

              <div class="trade-reco-grid">
                ${renderTradeScenario(bullish)}
                ${renderTradeScenario(bearish)}
              </div>
            </div>
          </details>
        </article>
      `);
    });
  }

  function renderTechnicalCards(snapshot, containerId) {
    const container = $(containerId);
    container.innerHTML = "";

    ["MES", "MNQ"].forEach(symbol => {
      const row = techData(snapshot, symbol);

      if (!row) {
        container.insertAdjacentHTML("beforeend", `
          <article class="technical-card">
            <div class="instrument-symbol">${symbol}</div>
            <p class="muted">No TradingView technical data.</p>
          </article>
        `);
        return;
      }

      const timeframes = row.timeframes || {};
      const tfKeys = ["5m", "15m", "30m", "1h", "2h", "4h"];

      const tfHtml = tfKeys.map(tf => {
        const tfRow = timeframes[tf] || (tf === "5m" ? row : null);
        const bias = tfRow?.technical_bias || "N/A";

        return `
          <div class="mtf-cell">
            <button
              type="button"
              class="tf-detail-button"
              data-symbol="${symbol}"
              data-timeframe="${tf}">
              <div class="tf-label">${tf.toUpperCase()}</div>
              <div class="tf-bias ${biasClass(bias)}">${esc(shortBias(bias))}</div>
              <div class="tiny muted">score ${tfRow?.technical_score ?? "—"}</div>
            </button>
          </div>
        `;
      }).join("");

      container.insertAdjacentHTML("beforeend", `
        <article class="technical-card">
          <div class="tech-header">
            <div>
              <div class="instrument-symbol">${symbol}</div>
              <div class="tiny muted">5m execution context + higher timeframe structure</div>
            </div>
            <span class="badge ${row.incomplete_last_bar_dropped ? "warn" : "good"}">
              ${row.incomplete_last_bar_dropped ? "FORMING 5m DROPPED" : "COMPLETED 5m"}
            </span>
          </div>

          <div class="mtf-grid">${tfHtml}</div>

          <div class="technical-market-condition ${marketConditionClass(row.market_condition)}">
            <div>
              <span>MARKET CONDITION</span>
              <strong>
                ${esc(marketConditionLabel(row.market_condition))}
              </strong>
            </div>
            <div class="tiny muted">
              ${esc(marketConditionMetricText(row.market_condition))}
            </div>
          </div>

          <div class="tech-meta">
            ${metaItem("VWAP", row.vwap_direction)}
            ${metaItem("EMA9", row.ema9_direction)}
            ${metaItem("EMA21", row.ema21_direction)}
            ${metaItem("15m", fmtSigned(row.price_change_15m))}
            ${metaItem("30m", fmtSigned(row.price_change_30m))}
            ${metaItem("45m", fmtSigned(row.price_change_45m))}
          </div>
        </article>
      `);
    });

    container.querySelectorAll(".tf-detail-button").forEach(button => {
      button.addEventListener("click", () => {
        openTimeframeDetail(
          snapshot,
          button.dataset.symbol,
          button.dataset.timeframe
        );
      });
    });
  }

  function metaItem(label, value) {
    const klass =
      String(value || "").includes("RISING") ? "positive" :
      String(value || "").includes("FALLING") ? "negative" :
      typeof value === "string" && value.startsWith("+") ? "positive" :
      typeof value === "string" && value.startsWith("-") ? "negative" : "";

    return `
      <div class="meta-item">
        <div class="label">${esc(label)}</div>
        <div class="value ${klass}">${esc(value ?? "N/A")}</div>
      </div>
    `;
  }

  function openTimeframeDetail(snapshot, symbol, tf) {
    const root = techData(snapshot, symbol);
    const row = root?.timeframes?.[tf] || (tf === "5m" ? root : null);

    if (!row) return;

    $("modalEyebrow").textContent = `${symbol} · ${tf.toUpperCase()}`;
    $("modalTitle").textContent = `${String(row.technical_bias || "N/A").replaceAll("_", " ")}`;

    const details = [
      ["Technical score", row.technical_score],
      ["Price", fmt(row.price)],
      ["VWAP", fmt(row.vwap)],
      ["EMA9", fmt(row.ema9)],
      ["EMA21", fmt(row.ema21)],
      ["VWAP direction", row.vwap_direction],
      ["EMA9 direction", row.ema9_direction],
      ["EMA21 direction", row.ema21_direction],
      ["EMA alignment", row.ema_alignment],
      ["Momentum", fmtSigned(row.timeframe_momentum_change)],
      ["Bar count", row.bar_count],
      ["Forming HTF bar", row.forming_timeframe_bar ? "YES" : "NO"],
    ];

    const reasons = (row.technical_reasons || [])
      .map(x => `<li>${esc(x)}</li>`)
      .join("");

    $("modalContent").innerHTML = `
      <div class="detail-grid">
        ${details.map(([label, value]) => `
          <div class="detail-item">
            <div class="label">${esc(label)}</div>
            <div class="value">${esc(value ?? "N/A")}</div>
          </div>
        `).join("")}
      </div>
      <h3>Bias reasons</h3>
      <ul class="reason-list">${reasons || "<li>No reasons recorded.</li>"}</ul>
    `;

    $("detailModal").classList.remove("hidden");
  }

  function destroyChart(name) {
    if (state.charts[name]) {
      state.charts[name].destroy();
      state.charts[name] = null;
    }
  }

  function gexChart(canvas, symbol, gex) {
    const ctx = canvas.getContext("2d");
    const levels = [...(gex?.ranked_all || [])]
      .filter(r => r.strike !== undefined && r.gex_millions !== undefined)
      .sort((a, b) => Number(b.strike) - Number(a.strike))
      .slice(0, 16);

    /*
      Draw the captured spot price as an unlabeled white dashed line.

      The GEX histogram uses a category Y-axis (strikes), so spot can
      fall between two displayed strikes. We interpolate between the
      pixel centers of the nearest strikes instead of snapping the line
      to a strike.

      If spot falls outside the displayed strike range, no line is
      drawn. This avoids showing a misleading line at the edge.
    */
    const spotLinePlugin = {
      id: `gexSpotLine_${symbol}_${canvas.id}`,

      afterDatasetsDraw(chart) {
        const spot = Number(gex?.price);

        if (!Number.isFinite(spot)) return;

        const yScale = chart.scales?.y;
        const chartArea = chart.chartArea;

        if (!yScale || !chartArea || !levels.length) return;

        const strikePixels = levels
          .map((row, index) => ({
            strike: Number(row.strike),
            pixel: yScale.getPixelForValue(index),
          }))
          .filter(
            point =>
              Number.isFinite(point.strike) &&
              Number.isFinite(point.pixel)
          )
          .sort((a, b) => a.strike - b.strike);

        if (!strikePixels.length) return;

        const minStrike = strikePixels[0].strike;
        const maxStrike = strikePixels[strikePixels.length - 1].strike;

        if (spot < minStrike || spot > maxStrike) return;

        let yPixel = null;

        const exact = strikePixels.find(
          point => Math.abs(point.strike - spot) < 1e-9
        );

        if (exact) {
          yPixel = exact.pixel;
        } else {
          for (let i = 0; i < strikePixels.length - 1; i++) {
            const lower = strikePixels[i];
            const upper = strikePixels[i + 1];

            if (spot >= lower.strike && spot <= upper.strike) {
              const strikeSpan = upper.strike - lower.strike;

              if (strikeSpan === 0) {
                yPixel = lower.pixel;
              } else {
                const ratio =
                  (spot - lower.strike) / strikeSpan;

                yPixel =
                  lower.pixel +
                  ratio * (upper.pixel - lower.pixel);
              }

              break;
            }
          }
        }

        if (!Number.isFinite(yPixel)) return;

        const drawCtx = chart.ctx;

        drawCtx.save();
        drawCtx.beginPath();
        drawCtx.setLineDash([6, 5]);
        drawCtx.lineDashOffset = 0;
        drawCtx.strokeStyle = "rgba(255,255,255,.95)";
        drawCtx.lineWidth = 1.25;
        drawCtx.moveTo(chartArea.left, yPixel);
        drawCtx.lineTo(chartArea.right, yPixel);
        drawCtx.stroke();
        drawCtx.restore();
      },
    };

    return new Chart(ctx, {
      type: "bar",
      data: {
        labels: levels.map(r => String(r.strike)),
        datasets: [{
          label: "GEX (millions)",
          data: levels.map(r => Number(r.gex_millions)),
          backgroundColor: levels.map(r =>
            Number(r.gex_millions) >= 0
              ? "rgba(55,185,90,.78)"
              : "rgba(239,64,54,.78)"
          ),
          borderWidth: 0,
        }],
      },

      // Local plugin: affects only this GEX histogram.
      plugins: [spotLinePlugin],

      options: {
        indexAxis: "y",
        maintainAspectRatio: false,
        responsive: true,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              afterLabel(context) {
                const row = levels[context.dataIndex];
                return [
                  `Priority: ${row.priority || "N/A"}`,
                  `Context: ${String(row.context || "").replaceAll("_", " ")}`,
                  `Distance: ${fmt(row.distance_abs_points)}`
                ];
              }
            }
          }
        },
        scales: {
          x: {
            grid: { color: "rgba(61,83,103,.25)" },
            ticks: { color: "#9dafbd" }
          },
          y: {
            grid: { display: false },
            ticks: { color: "#c8d3dc" }
          }
        }
      }
    });
  }

  function renderMarketCards(snapshot, containerId, prefix = "") {
    const container = $(containerId);
    container.innerHTML = "";

    ["SPX", "SPY", "QQQ"].forEach(symbol => {
      const { gex, flow, attraction } = marketData(snapshot, symbol);

      if (!gex) {
        container.insertAdjacentHTML("beforeend", `
          <article class="market-card" data-symbol="${symbol}">
            <div class="market-symbol">${symbol}</div>
            <p class="muted">No GEX context.</p>
          </article>
        `);
        return;
      }

      const up = attraction?.primary_up_target;
      const down = attraction?.primary_down_target;
      const flowStale = Boolean(flow?.data_stale);
      const flowBias = flowStale ? "NOT LIVE" : (flow?.flow_bias || "NO DATA");
      const netBias = attraction?.net_attraction_bias || "NO DATA";

      const canvasId = `${prefix}gex-${symbol}`;
      const isLiveView = prefix === "";
      const liveSpot = isLiveView
        ? livePriceState(symbol, gex.price)
        : { price: Number(gex.price), fresh: false, ageMinutes: null };
      const displaySpot = Number.isFinite(Number(liveSpot.price))
        ? Number(liveSpot.price)
        : Number(gex.price);

      container.insertAdjacentHTML("beforeend", `
        <article class="market-card ${state.marketFilter !== "all" && state.marketFilter !== symbol ? "hidden-filter" : ""}" data-symbol="${symbol}">
          <div class="market-top">
            <div>
              <div class="market-symbol">${symbol}</div>
              <div class="spot">
                ${isLiveView ? "Live" : "Spot"}
                <strong
                  ${isLiveView ? `data-live-spot-symbol="${symbol}" data-snapshot-spot="${Number(gex.price)}"` : ""}
                  class="${isLiveView && liveSpot.fresh ? "live-price-fresh" : ""}"
                >${fmt(displaySpot, symbol === "SPX" ? 1 : 2)}</strong>
              </div>
              ${isLiveView ? `<div class="snapshot-spot"><span data-live-spot-meta="${symbol}" data-snapshot-spot="${Number(gex.price)}">${liveSpot.fresh ? `LIVE · ${liveAgeText(liveSpot.ageMinutes)}` : "MODEL SNAPSHOT"}</span> · model ${fmt(gex.price, symbol === "SPX" ? 1 : 2)}</div>` : ""}
            </div>
            <span class="badge ${biasClass(netBias) === "positive" ? "good" : biasClass(netBias) === "negative" ? "bad" : "warn"}">
              ${esc(String(netBias).replaceAll("_", " "))}
            </span>
          </div>

          <div class="target-grid">
            ${targetBox("UP TARGET", up, "positive", isLiveView ? { symbol, side: "UP" } : null)}
            ${targetBox("DOWN TARGET", down, "negative", isLiveView ? { symbol, side: "DOWN" } : null)}
          </div>

          <div class="flow-row">
            <div>
              <div class="flow-label">FLOWLINE</div>
              <div class="flow-value ${flowStale ? "muted" : biasClass(flowBias)}">
                ${esc(String(flowBias).replaceAll("_", " "))}
              </div>
            </div>
            <div class="tiny muted">
              Calls ${esc(flow?.calls?.direction || "—")} ·
              Puts ${esc(flow?.puts?.direction || "—")}
            </div>
          </div>

          <div class="model-row">
            <div class="flow-label">SPOT STATE</div>
            <div class="flow-value">${esc(String(attraction?.spot_state || "N/A").replaceAll("_", " "))}</div>
          </div>

          <div class="market-chart-wrap">
            <canvas id="${canvasId}"></canvas>
          </div>

          <div class="market-actions">
            <button data-gex-table="${symbol}" data-snapshot-mode="${prefix ? "history" : "live"}">
              All GEX levels
            </button>
            <button data-target-detail="${symbol}" data-snapshot-mode="${prefix ? "history" : "live"}">
              Target details
            </button>
          </div>
        </article>
      `);

      setTimeout(() => {
        const canvas = $(canvasId);
        if (!canvas) return;
        const key = `${prefix}gex_${symbol}`;
        destroyChart(key);
        state.charts[key] = gexChart(canvas, symbol, gex);
      }, 0);
    });

    container.querySelectorAll("[data-gex-table]").forEach(button => {
      button.addEventListener("click", () => {
        const snap = button.dataset.snapshotMode === "history"
          ? state.selected
          : state.latest;
        openGexTable(snap, button.dataset.gexTable);
      });
    });

    container.querySelectorAll("[data-target-detail]").forEach(button => {
      button.addEventListener("click", () => {
        const snap = button.dataset.snapshotMode === "history"
          ? state.selected
          : state.latest;
        openTargetDetail(snap, button.dataset.targetDetail);
      });
    });
  }

  function targetBox(label, row, className, liveOptions = null) {
    if (!row) {
      return `
        <div class="target-box">
          <div class="target-side">${label}</div>
          <div class="target-strike">N/A</div>
        </div>
      `;
    }

    return `
      <div class="target-box">
        <div class="target-side">${label}</div>
        <div class="target-strike ${className}">${esc(row.strike)}</div>
        <div class="target-score">
          ${fmt(row.attraction_score, 0)} ·
          ${esc(String(row.attraction_confidence || "").replaceAll("_", " "))}
        </div>
        <div class="reaction">${esc(reactionShort(row.reaction))}</div>
        ${liveOptions ? `<div class="live-target-distance" data-live-target-distance data-symbol="${esc(liveOptions.symbol)}" data-side="${esc(liveOptions.side)}" data-strike="${esc(row.strike)}">${esc(targetDistanceText(liveOptions.symbol, row.strike, liveOptions.side))}</div>` : ""}
      </div>
    `;
  }

  function openGexTable(snapshot, symbol) {
    const gex = marketData(snapshot, symbol).gex;
    const rows = gex?.ranked_all || [];

    $("modalEyebrow").textContent = `${symbol} · GEX`;
    $("modalTitle").textContent = `All ranked levels`;

    $("modalContent").innerHTML = `
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Strike</th><th>GEX</th><th>Relation</th><th>Distance</th>
              <th>Priority</th><th>Context</th><th>Temporal</th><th>Score</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(row => `
              <tr>
                <td><strong>${esc(row.strike)}</strong></td>
                <td class="${Number(row.gex_millions) >= 0 ? "positive" : "negative"}">${fmtGex(row.gex_millions)}</td>
                <td>${esc(row.relation)}</td>
                <td>${fmt(row.distance_abs_points)}</td>
                <td>${esc(row.priority)}</td>
                <td>${esc(String(row.context || "").replaceAll("_", " "))}</td>
                <td>${esc(String(row.temporal_event || "").replaceAll("_", " "))}</td>
                <td>${fmt(row.priority_score, 1)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;

    $("detailModal").classList.remove("hidden");
  }

  function openTargetDetail(snapshot, symbol) {
    const a = marketData(snapshot, symbol).attraction;

    $("modalEyebrow").textContent = `${symbol} · ATTRACTION`;
    $("modalTitle").textContent = String(a?.net_attraction_bias || "NO DATA").replaceAll("_", " ");

    const rows = [
      ["Spot state", String(a?.spot_state || "N/A").replaceAll("_", " ")],
      ["Directional edge", fmtSigned(a?.directional_edge_points, 2)],
      ["GEX direction", fmtSigned(a?.gex_direction_value, 3)],
      ["GEX up strength", fmt(a?.gex_up_strength, 1)],
      ["GEX down strength", fmt(a?.gex_down_strength, 1)],
      ["Flow status", a?.flow_status || "N/A"],
      ["Flow bias", a?.flow_bias || "N/A"],
      ["Technical status", a?.technical_status || "N/A"],
      ["Technical bias", a?.technical_bias || "N/A"],
    ];

    $("modalContent").innerHTML = `
      <div class="detail-grid">
        ${rows.map(([label, value]) => `
          <div class="detail-item">
            <div class="label">${esc(label)}</div>
            <div class="value">${esc(value)}</div>
          </div>
        `).join("")}
      </div>
      <h3>Primary up target</h3>
      ${targetDetailHtml(a?.primary_up_target)}
      <h3>Primary down target</h3>
      ${targetDetailHtml(a?.primary_down_target)}
    `;

    $("detailModal").classList.remove("hidden");
  }

  function targetDetailHtml(row) {
    if (!row) return `<p class="muted">No target.</p>`;

    const components = row.components || {};
    return `
      <div class="detail-grid">
        ${[
          ["Strike", row.strike],
          ["GEX", fmtGex(row.gex_millions)],
          ["Distance", fmt(row.distance_points)],
          ["Attraction", fmt(row.attraction_score, 1)],
          ["Confidence", row.attraction_confidence],
          ["GEX-only score", fmt(row.gex_only_score, 1)],
          ["Reaction", reactionShort(row.reaction)],
          ["Temporal", row.temporal_event],
          ["Priority", fmt(row.priority_score, 1)],
        ].map(([label, value]) => `
          <div class="detail-item">
            <div class="label">${esc(label)}</div>
            <div class="value">${esc(value ?? "N/A")}</div>
          </div>
        `).join("")}
      </div>

      <div class="component-bar">
        ${Object.entries(components).map(([key, value]) => `
          <div class="component-pill">
            ${esc(key.replaceAll("_", " "))}: <strong>${fmt(value, 1)}</strong>
          </div>
        `).join("")}
      </div>
    `;
  }

  function zeroDteBiasClass(bias) {
    const text = String(bias || "").toUpperCase();
    if (text.includes("BULLISH")) return "bullish";
    if (text.includes("BEARISH")) return "bearish";
    return "neutral";
  }

  function zeroDtePressurePct(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    return `${n > 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;
  }

  function zeroDteMoney(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    const sign = n < 0 ? "-" : "";
    const x = Math.abs(n);
    if (x >= 1e6) return `${sign}$${(x / 1e6).toFixed(2)}M`;
    if (x >= 1e3) return `${sign}$${(x / 1e3).toFixed(1)}K`;
    return `${sign}$${x.toFixed(0)}`;
  }

  function zeroDteWindowCell(asset, windowName) {
    const row = asset?.windows?.[windowName] || null;
    if (!row) {
      return `
        <div class="odte-window-cell no-data">
          <span>${esc(windowName)}</span><strong>—</strong><small>No flow</small>
        </div>
      `;
    }
    return `
      <div class="odte-window-cell ${zeroDteBiasClass(row.bias)}">
        <span>${esc(windowName)}</span>
        <strong>${esc(String(row.bias || "NEUTRAL").replaceAll("_", " "))}</strong>
        <small>${zeroDtePressurePct(row.effective_pressure)} · Q ${fmt(row.quality, 0)} · ${zeroDteMoney(row.classified_premium_usd)}</small>
      </div>
    `;
  }

  function zeroDteClusterText(cluster, fallback) {
    if (!cluster) return fallback;
    return `${fmt(cluster.strike, 2)} · ${zeroDteMoney(cluster.signed_effective_usd)} · ${zeroDtePressurePct(cluster.pressure)}`;
  }

  function renderZeroDteFlowCards() {
    const container = $("zeroDteFlowCards");
    if (!container) return;
    const payload = state.latest?.options_flow_0dte || null;
    if (!payload) {
      container.innerHTML = `
        <article class="odte-card odte-no-data">
          <div class="odte-card-head"><strong>0DTE Live Flow</strong><span>SHADOW · 0%</span></div>
          <p>Waiting for the first paid Tradytics SPX/QQQ 0DTE flow snapshot.</p>
        </article>
      `;
      return;
    }

    container.innerHTML = ["SPX", "QQQ"].map(symbol => {
      const asset = payload.assets?.[symbol] || null;
      const mapped = symbol === "SPX" ? "MES" : "MNQ";
      if (!asset) {
        return `
          <article class="odte-card odte-no-data">
            <div class="odte-card-head"><div><strong>${symbol}</strong><small>${mapped} tactical derivatives layer</small></div><span>SHADOW · 0%</span></div>
            <p>No paid 0DTE flow snapshot for ${symbol}.</p>
          </article>
        `;
      }
      const bull = asset.clusters?.bullish?.[0] || null;
      const bear = asset.clusters?.bearish?.[0] || null;
      const signal = asset.shadow_signal || {};
      return `
        <article class="odte-card">
          <div class="odte-card-head">
            <div>
              <strong>${symbol} → ${mapped}</strong>
              <small>Paid Tradytics Live Flow · same-day options only</small>
            </div>
            <span>SHADOW · 0% MODEL WEIGHT</span>
          </div>
          <div class="odte-primary-row">
            <div>
              <span>15m shadow signal</span>
              <strong class="${zeroDteBiasClass(signal.bias)}">${esc(String(signal.bias || "NO DATA").replaceAll("_", " "))}</strong>
            </div>
            <div><span>Pressure</span><strong>${zeroDtePressurePct(signal.effective_pressure)}</strong></div>
            <div><span>Quality</span><strong>${fmt(signal.quality, 0)}</strong></div>
            <div><span>0DTE rows</span><strong>${Number(asset.row_count_0dte || 0)}</strong></div>
          </div>
          <div class="odte-window-grid">
            ${zeroDteWindowCell(asset, "5m")}
            ${zeroDteWindowCell(asset, "15m")}
            ${zeroDteWindowCell(asset, "30m")}
            ${zeroDteWindowCell(asset, "session")}
          </div>
          <div class="odte-meta-grid">
            <div><span>Latest spot</span><strong>${fmt(asset.latest_spot, 2)}</strong></div>
            <div><span>Reversal</span><strong>${esc(String(asset.reversal_state || "NONE").replaceAll("_", " "))}</strong></div>
            <div><span>Bull cluster</span><strong>${esc(zeroDteClusterText(bull, "None"))}</strong></div>
            <div><span>Bear cluster</span><strong>${esc(zeroDteClusterText(bear, "None"))}</strong></div>
          </div>
        </article>
      `;
    }).join("");
  }

  function renderZeroDtePressureHistory() {
    const canvas = $("zeroDtePressureChart");
    const select = $("zeroDteSymbolSelect");
    if (!canvas || !select) return;
    const symbol = select.value || "SPX";
    const labels = state.daySnapshots.map(r => localTime(r.captured_at));
    const series = windowName => state.daySnapshots.map(r => {
      const value = r.options_flow_0dte?.assets?.[symbol]?.windows?.[windowName]?.effective_pressure;
      return Number.isFinite(Number(value)) ? Number(value) * 100 : null;
    });

    destroyChart("zeroDtePressure");
    state.charts.zeroDtePressure = new Chart(
      canvas.getContext("2d"),
      {
        type: "line",
        data: {
          labels,
          datasets: [
            { label: "5m", data: series("5m"), borderColor: "#f4c95d", pointRadius: 2, tension: .20, spanGaps: true },
            { label: "15m", data: series("15m"), borderColor: "#55c2ff", pointRadius: 2, tension: .20, spanGaps: true },
            { label: "30m", data: series("30m"), borderColor: "#b38cff", pointRadius: 2, tension: .20, spanGaps: true },
          ],
        },
        options: chartOptions("0DTE effective pressure (%)"),
      }
    );
  }

  function renderFlowHistory() {
    const symbol = $("flowSymbolSelect").value;
    const labels = state.daySnapshots.map(r => localTime(r.captured_at));
    const calls = state.daySnapshots.map(r =>
      r.flowline?.symbols?.[symbol]?.calls?.current_millions ?? null
    );
    const puts = state.daySnapshots.map(r =>
      r.flowline?.symbols?.[symbol]?.puts?.current_millions ?? null
    );

    destroyChart("flowHistory");

    state.charts.flowHistory = new Chart(
      $("flowHistoryChart").getContext("2d"),
      {
        type: "line",
        data: {
          labels,
          datasets: [
            {
              label: "Calls",
              data: calls,
              borderColor: "#37b95a",
              backgroundColor: "rgba(55,185,90,.12)",
              pointRadius: 2,
              tension: .25,
              spanGaps: true,
            },
            {
              label: "Puts",
              data: puts,
              borderColor: "#ef4036",
              backgroundColor: "rgba(239,64,54,.12)",
              pointRadius: 2,
              tension: .25,
              spanGaps: true,
            },
          ],
        },
        options: chartOptions("Flowline (millions)"),
      }
    );
  }

  function renderAttractionHistory() {
    const symbol = $("attractionSymbolSelect").value;
    const labels = state.daySnapshots.map(r => localTime(r.captured_at));
    const up = state.daySnapshots.map(r =>
      r.attraction?.assets?.[symbol]?.primary_up_target?.attraction_score ?? null
    );
    const down = state.daySnapshots.map(r =>
      r.attraction?.assets?.[symbol]?.primary_down_target?.attraction_score ?? null
    );

    destroyChart("attractionHistory");

    state.charts.attractionHistory = new Chart(
      $("attractionHistoryChart").getContext("2d"),
      {
        type: "line",
        data: {
          labels,
          datasets: [
            {
              label: "Up target score",
              data: up,
              borderColor: "#37b95a",
              pointRadius: 2,
              tension: .25,
              spanGaps: true,
            },
            {
              label: "Down target score",
              data: down,
              borderColor: "#ef4036",
              pointRadius: 2,
              tension: .25,
              spanGaps: true,
            },
          ],
        },
        options: {
          ...chartOptions("Attraction score"),
          scales: {
            ...chartOptions("").scales,
            y: {
              min: 0,
              max: 100,
              grid: { color: "rgba(61,83,103,.25)" },
              ticks: { color: "#9dafbd" },
            },
          },
        },
      }
    );
  }

  function chartOptions(yTitle = "") {
    return {
      maintainAspectRatio: false,
      responsive: true,
      interaction: { intersect: false, mode: "index" },
      plugins: {
        legend: {
          labels: { color: "#c8d3dc", boxWidth: 12 },
        },
      },
      scales: {
        x: {
          grid: { color: "rgba(61,83,103,.16)" },
          ticks: { color: "#9dafbd", maxTicksLimit: 10 },
        },
        y: {
          title: {
            display: Boolean(yTitle),
            text: yTitle,
            color: "#9dafbd",
          },
          grid: { color: "rgba(61,83,103,.25)" },
          ticks: { color: "#9dafbd" },
        },
      },
    };
  }

  // ==========================================================
  // ACTIVE TRADE MANAGEMENT V2 — SUPABASE JOURNAL + CONTEXT
  // ==========================================================
  //
  // Pre-entry execution rules and active-trade management are intentionally
  // separate. DO NOT CHASE can block a fresh entry while an already-open
  // trade may instead be approaching its intended objective.
  //
  // The engine does NOT place orders and does NOT generate exact stop moves.
  // The user supplies the structural stop. Stop updates may tighten risk but
  // cannot widen it through this UI.
  // ==========================================================

  const ACTIVE_TRADE_STORAGE_KEY =
    "fm_active_trade_v1";

  const ACTIVE_TRADE_ARCHIVE_KEY =
    "fm_trade_archive_v1";

  const ACTIVE_TRADE_POINT_VALUE = {
    MES: 5,
    MNQ: 2,
  };

  function safeLocalStorageGet(key) {
    try {
      return window.localStorage.getItem(key);
    }
    catch (_error) {
      return null;
    }
  }

  function safeLocalStorageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
      return true;
    }
    catch (_error) {
      return false;
    }
  }

  function safeLocalStorageRemove(key) {
    try {
      window.localStorage.removeItem(key);
    }
    catch (_error) {
      // Browser-local persistence is helpful, but never a reason to break UI.
    }
  }

  function loadActiveTradeState() {
    if (state.activeTradeLoaded) {
      return state.activeTrade;
    }

    state.activeTradeLoaded = true;

    const raw =
      safeLocalStorageGet(
        ACTIVE_TRADE_STORAGE_KEY
      );

    if (!raw) {
      state.activeTrade = null;
      return null;
    }

    try {
      const parsed = JSON.parse(raw);

      if (
        parsed &&
        parsed.active === true &&
        ["MES", "MNQ"].includes(parsed.instrument) &&
        ["LONG", "SHORT"].includes(parsed.direction)
      ) {
        state.activeTrade = parsed;
        return parsed;
      }
    }
    catch (_error) {
      // Corrupt browser-local state is cleared below.
    }

    safeLocalStorageRemove(
      ACTIVE_TRADE_STORAGE_KEY
    );

    state.activeTrade = null;
    return null;
  }

  function persistActiveTradeState(trade) {
    state.activeTrade = trade;
    state.activeTradeLoaded = true;

    if (trade) {
      safeLocalStorageSet(
        ACTIVE_TRADE_STORAGE_KEY,
        JSON.stringify(trade)
      );
    }
    else {
      safeLocalStorageRemove(
        ACTIVE_TRADE_STORAGE_KEY
      );
    }
  }

  function activeTradeFuturesPrice(
    snapshot,
    instrument
  ) {
    const live = livePriceState(
      instrument,
      null
    );

    if (live.fresh && Number.isFinite(live.price)) {
      return {
        price: live.price,
        source: `${instrument} TradingView completed 1m`,
        live: true,
        ageMinutes: live.ageMinutes,
      };
    }

    const of =
      recommendationOrderflow(
        snapshot,
        instrument
      );

    const ofPrice = Number(
      of?.row?.latest_price
    );

    if (Number.isFinite(ofPrice)) {
      return {
        price: ofPrice,
        source: `${of.futuresSymbol} completed 1m`,
      };
    }

    const tech =
      techData(
        snapshot,
        instrument
      );

    const techPrice = Number(
      tech?.price ??
      tech?.timeframes?.["5m"]?.price
    );

    if (Number.isFinite(techPrice)) {
      return {
        price: techPrice,
        source: `${instrument} completed 5m`,
      };
    }

    return {
      price: null,
      source: "Price unavailable",
    };
  }

  function activeTradeAssetSymbol(
    instrument
  ) {
    return instrument === "MES"
      ? "SPX"
      : "QQQ";
  }

  function activeTradeUnderlyingSpot(
    snapshot,
    instrument
  ) {
    const symbol =
      activeTradeAssetSymbol(
        instrument
      );

    const snapshotPrice = Number(
      snapshot?.gex_context
        ?.symbols?.[symbol]
        ?.price
    );

    const live = livePriceState(
      symbol,
      snapshotPrice
    );

    return {
      symbol,
      price: Number.isFinite(live.price) ? live.price : null,
      live: live.fresh,
      source: live.source,
      ageMinutes: live.ageMinutes,
      snapshotPrice: Number.isFinite(snapshotPrice) ? snapshotPrice : null,
    };
  }

  function activeTradeTarget(
    snapshot,
    instrument,
    direction
  ) {
    const assetSymbol =
      activeTradeAssetSymbol(
        instrument
      );

    const asset =
      snapshot?.attraction
        ?.assets?.[assetSymbol] ||
      null;

    const target =
      direction === "LONG"
        ? asset?.primary_up_target
        : asset?.primary_down_target;

    return {
      assetSymbol,
      asset,
      target: target || null,
    };
  }

  function activeTradeNextTarget(
    snapshot,
    instrument,
    direction,
    currentTarget
  ) {
    const {
      asset,
    } = activeTradeTarget(
      snapshot,
      instrument,
      direction
    );

    const primaryStrike = Number(
      currentTarget?.strike
    );

    if (
      !asset ||
      !Number.isFinite(primaryStrike)
    ) {
      return null;
    }

    const rows =
      direction === "LONG"
        ? asset?.upside_candidates || []
        : asset?.downside_candidates || [];

    const farther =
      rows.filter(row => {
        const strike = Number(
          row?.strike
        );

        if (!Number.isFinite(strike)) {
          return false;
        }

        return direction === "LONG"
          ? strike > primaryStrike
          : strike < primaryStrike;
      });

    if (!farther.length) {
      return null;
    }

    return farther.reduce(
      (best, row) => {
        if (!best) return row;

        return (
          Math.abs(
            Number(row.strike) -
            primaryStrike
          ) <
          Math.abs(
            Number(best.strike) -
            primaryStrike
          )
        )
          ? row
          : best;
      },
      null
    );
  }

  function activeTradeGexType(target) {
    const reaction = String(
      target?.reaction ||
      ""
    ).toUpperCase();

    const sign = String(
      target?.sign ||
      ""
    ).toLowerCase();

    if (
      sign === "negative" ||
      reaction.includes(
        "ACCELERATION_IF_ACCEPTED"
      )
    ) {
      return {
        type: "ACCELERATION",
        label: "NEG GEX · ACCELERATION IF ACCEPTED",
      };
    }

    if (
      sign === "positive" ||
      reaction.includes("BRAKE")
    ) {
      return {
        type: "BRAKE",
        label: "POS GEX · BRAKE",
      };
    }

    return {
      type: "OTHER",
      label: "OTHER GEX STRUCTURE",
    };
  }

  function activeTradeDirectionSign(direction) {
    return direction === "LONG"
      ? 1
      : -1;
  }

  function activeTradeTargetReached(
    direction,
    spot,
    strike
  ) {
    if (
      !Number.isFinite(spot) ||
      !Number.isFinite(strike)
    ) {
      return false;
    }

    return direction === "LONG"
      ? spot >= strike
      : spot <= strike;
  }

  function activeTradeTargetRelation(
    trade,
    currentTarget
  ) {
    const entryStrike = Number(
      trade?.entryContext
        ?.target?.strike
    );

    const currentStrike = Number(
      currentTarget?.strike
    );

    if (!Number.isFinite(currentStrike)) {
      return {
        status: "LOST",
        label: "CURRENT TARGET LOST",
        caution: true,
      };
    }

    if (!Number.isFinite(entryStrike)) {
      return {
        status: "NEW",
        label: `CURRENT TARGET ${currentStrike}`,
        caution: false,
      };
    }

    if (currentStrike === entryStrike) {
      return {
        status: "SAME",
        label: `TARGET UNCHANGED ${currentStrike}`,
        caution: false,
      };
    }

    const extended =
      trade.direction === "LONG"
        ? currentStrike > entryStrike
        : currentStrike < entryStrike;

    return {
      status:
        extended
          ? "EXTENDED"
          : "CONTRACTED",
      label:
        extended
          ? `TARGET EXTENDED ${entryStrike} → ${currentStrike}`
          : `TARGET CONTRACTED ${entryStrike} → ${currentStrike}`,
      caution: !extended,
    };
  }

  function activeTradeContext(
    snapshot,
    trade
  ) {
    const instrument =
      trade.instrument;

    const direction =
      trade.direction;

    const sideSign =
      activeTradeDirectionSign(
        direction
      );

    const bullish =
      buildTradeScenario(
        snapshot,
        instrument,
        "BULLISH"
      );

    const bearish =
      buildTradeScenario(
        snapshot,
        instrument,
        "BEARISH"
      );

    const activeScenario =
      direction === "LONG"
        ? bullish
        : bearish;

    const oppositeScenario =
      direction === "LONG"
        ? bearish
        : bullish;

    const currentExecution =
      executionState(
        snapshot,
        instrument,
        bullish,
        bearish
      );

    const activeGexGate =
      buildGexExecutionGate(
        snapshot,
        instrument,
        activeScenario,
        oppositeScenario
      );

    const crossMarket =
      buildCrossMarketGate(
        snapshot,
        instrument
      );

    const marketCondition =
      marketConditionFor(
        snapshot,
        instrument
      );

    const row =
      instrumentData(
        snapshot,
        instrument
      );

    const tech =
      techData(
        snapshot,
        instrument
      );

    const techScore =
      technicalScore5m(
        tech
      );

    const of =
      recommendationOrderflow(
        snapshot,
        instrument
      );

    const price =
      activeTradeFuturesPrice(
        snapshot,
        instrument
      );

    const underlying =
      activeTradeUnderlyingSpot(
        snapshot,
        instrument
      );

    const targetRow =
      activeTradeTarget(
        snapshot,
        instrument,
        direction
      );

    const currentTarget =
      targetRow.target;

    const nextTarget =
      activeTradeNextTarget(
        snapshot,
        instrument,
        direction,
        currentTarget
      );

    const targetRelation =
      activeTradeTargetRelation(
        trade,
        currentTarget
      );

    const entryTarget =
      trade?.entryContext?.target ||
      null;

    const entryTargetStrike = Number(
      entryTarget?.strike
    );

    const currentTargetStrike = Number(
      currentTarget?.strike
    );

    const entryTargetReached =
      activeTradeTargetReached(
        direction,
        underlying.price,
        entryTargetStrike
      );

    const currentTargetReached =
      activeTradeTargetReached(
        direction,
        underlying.price,
        currentTargetStrike
      );

    const entryTargetType =
      activeTradeGexType(
        entryTarget
      );

    const currentTargetType =
      activeTradeGexType(
        currentTarget
      );

    const currentPrice =
      Number(price.price);

    const entry = Number(
      trade.entry
    );

    const avgEntry = Number(
      trade.avgEntry ??
      trade.entry
    );

    const initialRisk = Number(
      trade.initialRiskPoints
    );

    const initialRiskDollars = Number(
      trade.initialRiskDollars
    );

    const currentStop = Number(
      trade.currentStop
    );

    const pointValue =
      ACTIVE_TRADE_POINT_VALUE[
        instrument
      ];

    const contracts = Number(
      trade.openContracts ??
      trade.contracts
    );

    const realizedPnlDollars = Number(
      trade.realizedPnlDollars || 0
    );

    const openPoints =
      (
        Number.isFinite(currentPrice) &&
        Number.isFinite(avgEntry)
      )
        ? sideSign * (
            currentPrice - avgEntry
          )
        : null;

    const openDollars =
      (
        Number.isFinite(openPoints) &&
        Number.isFinite(pointValue) &&
        Number.isFinite(contracts)
      )
        ? openPoints *
          pointValue *
          contracts
        : null;

    const totalPnlDollars =
      (
        Number.isFinite(openDollars) &&
        Number.isFinite(realizedPnlDollars)
      )
        ? openDollars +
          realizedPnlDollars
        : null;

    const openR =
      (
        Number.isFinite(openDollars) &&
        Number.isFinite(initialRiskDollars) &&
        initialRiskDollars > 0
      )
        ? openDollars /
          initialRiskDollars
        : null;

    const totalR =
      (
        Number.isFinite(totalPnlDollars) &&
        Number.isFinite(initialRiskDollars) &&
        initialRiskDollars > 0
      )
        ? totalPnlDollars /
          initialRiskDollars
        : null;

    const stopBreached =
      (
        Number.isFinite(currentPrice) &&
        Number.isFinite(currentStop)
      )
        ? (
            direction === "LONG"
              ? currentPrice <= currentStop
              : currentPrice >= currentStop
          )
        : false;

    const modelSign =
      signOfBias(
        row?.bias
      );

    const productionOpposed =
      modelSign === -sideSign;

    const scenarioFlip = Boolean(
      Number(oppositeScenario?.score) >= 60 &&
      (
        Number(oppositeScenario?.score) -
        Number(activeScenario?.score)
      ) >= 10
    );

    const techOpposed = Boolean(
      Number.isFinite(techScore) &&
      (
        direction === "LONG"
          ? techScore <= -3
          : techScore >= 3
      )
    );

    const techAligned = Boolean(
      Number.isFinite(techScore) &&
      (
        direction === "LONG"
          ? techScore >= 3
          : techScore <= -3
      )
    );

    const regimeSign =
      of.fresh
        ? signWithDeadZone(
            of.model?.regime_direction
          )
        : 0;

    const triggerSign =
      of.fresh
        ? signWithDeadZone(
            of.model?.trigger_direction
          )
        : 0;

    const combinedSign =
      of.fresh
        ? signWithDeadZone(
            of.model?.effective_direction ?? of.model?.combined_direction
          )
        : 0;

    const ofOpposed = Boolean(
      of.fresh &&
      (
        regimeSign === -sideSign ||
        combinedSign === -sideSign
      )
    );

    const ofAligned = Boolean(
      of.fresh &&
      (
        regimeSign === sideSign ||
        combinedSign === sideSign
      )
    );

    const triggerOpposed = Boolean(
      of.fresh &&
      triggerSign === -sideSign
    );

    const crossDirection =
      crossMarket?.current?.direction;

    const crossStrongOpposed = Boolean(
      crossDirection &&
      crossDirection !== direction &&
      crossMarket?.blocksEntry
    );

    const crossCaution = Boolean(
      crossMarket?.caution ||
      (
        crossDirection &&
        crossDirection !== direction
      )
    );

    const gexInvalid = Boolean(
      [
        "SIGN_FLIP",
        "TARGET_LOST",
        "OPPOSING_ACCELERATION_BUILD",
      ].includes(
        activeGexGate?.status
      )
    );

    const gexCaution = Boolean(
      activeGexGate?.caution ||
      targetRelation.caution ||
      activeGexGate?.status === "TARGET_SHIFT"
    );

    const marketBlocked =
      String(
        marketCondition?.execution_permission ||
        ""
      ).toUpperCase() === "BLOCK";

    const marketConditional =
      !marketBlocked &&
      String(
        marketCondition?.execution_permission ||
        ""
      ).toUpperCase() !== "ALLOW";

    const invalidationCategories = [
      {
        key: "THESIS",
        active:
          scenarioFlip ||
          productionOpposed,
        text:
          scenarioFlip
            ? "Bull/Bear Setup Support has flipped materially against the active trade."
            : productionOpposed
              ? "Production model bias is opposing the active trade."
              : "",
      },
      {
        key: "5M_STRUCTURE",
        active: techOpposed,
        text:
          `5m technical score ${Number.isFinite(techScore) ? fmtSigned(techScore, 0) : "N/A"} materially opposes the trade.`,
      },
      {
        key: "AUCTION",
        active: ofOpposed,
        text:
          `${of.futuresSymbol} Order Flow regime/combined auction is opposing the trade.`,
      },
      {
        key: "CROSS_MARKET",
        active: crossStrongOpposed,
        text:
          `Cross-market state materially favors the opposite ${crossMarket?.other?.instrument || "index"} thesis.`,
      },
      {
        key: "GEX",
        active: gexInvalid,
        text:
          `Active-direction GEX structure is invalidated: ${activeGexGate?.label || "GEX change"}.`,
      },
    ].filter(row => row.active);

    const warnings = [];

    if (gexCaution && !gexInvalid) {
      warnings.push(
        activeGexGate?.detail ||
        targetRelation.label
      );
    }

    if (marketBlocked) {
      warnings.push(
        `Market Condition is ${marketConditionLabel(marketCondition)}. Existing trade may require tighter attention even though this is not an automatic exit by itself.`
      );
    }
    else if (marketConditional) {
      warnings.push(
        `Market Condition is ${marketConditionLabel(marketCondition)} / conditional.`
      );
    }

    if (crossCaution && !crossStrongOpposed) {
      warnings.push(
        `Cross-market confirmation is reduced: ${crossMarket?.label || "divergence"}.`
      );
    }

    if (triggerOpposed && !ofOpposed) {
      warnings.push(
        `${of.futuresSymbol} short-horizon Order Flow trigger is opposing while the broader auction has not fully reversed.`
      );
    }

    if (
      targetRelation.status === "CONTRACTED"
    ) {
      warnings.push(
        targetRelation.label
      );
    }

    const currentTargetDistance =
      (
        Number.isFinite(underlying.price) &&
        Number.isFinite(currentTargetStrike)
      )
        ? (
            direction === "LONG"
              ? currentTargetStrike - underlying.price
              : underlying.price - currentTargetStrike
          )
        : null;

    const currentTargetDistancePct =
      (
        Number.isFinite(currentTargetDistance) &&
        Number.isFinite(underlying.price) &&
        underlying.price !== 0
      )
        ? Math.max(
            currentTargetDistance,
            0
          ) /
          Math.abs(underlying.price) *
          100
        : null;

    const targetVeryNear = Boolean(
      Number.isFinite(currentTargetDistancePct) &&
      currentTargetDistancePct <= 0.03 &&
      currentTargetDistance > 0
    );

    let managementState =
      "HOLD";

    let managementClass =
      "hold";

    let action =
      "Original thesis remains intact. Hold according to structure, do not widen the stop, and reassess at the primary GEX objective or if multiple independent reversal signals appear.";

    let continuationWatch = false;

    if (stopBreached) {
      managementState =
        "EXIT · STOP LEVEL BREACHED";

      managementClass =
        "exit";

      action =
        "The latest completed futures price is at/through the structural stop. Broker execution is the source of truth; do not widen the stop to preserve the thesis.";
    }
    else if (
      invalidationCategories.length >= 2
    ) {
      managementState =
        "EXIT / REASSESS";

      managementClass =
        "exit";

      action =
        "At least two independent thesis categories have reversed against the position. Reassess/exit rather than widening risk. The structural stop remains the hard protection.";
    }
    else if (entryTargetReached) {
      if (
        entryTargetType.type ===
        "ACCELERATION"
      ) {
        managementState =
          "TAKE PROFIT / PROTECT";

        managementClass =
          "reduce";

        continuationWatch = true;

        action =
          "The original primary objective has been reached at a negative-GEX acceleration-if-accepted level. Protect realized gains / reduce according to plan. Continuation toward the next GEX level is RESEARCH ONLY this week and should not override profit protection.";
      }
      else {
        managementState =
          "TAKE PROFIT / REDUCE";

        managementClass =
          "reduce";

        action =
          "The original primary GEX objective has been reached at a brake/support-resistance structure. Take profit or reduce according to plan; keep a runner only if your structure remains valid.";
      }
    }
    else if (
      invalidationCategories.length === 1 ||
      warnings.length > 0 ||
      targetVeryNear
    ) {
      managementState =
        "HOLD · PROTECT";

      managementClass =
        "protect";

      if (
        targetVeryNear &&
        currentTargetType.type === "BRAKE"
      ) {
        action =
          "The trade remains valid but is approaching a positive-GEX brake. Do not add here. Protect the position using structure and prepare to reduce if the level rejects.";
      }
      else if (
        targetVeryNear &&
        currentTargetType.type === "ACCELERATION"
      ) {
        action =
          "The trade remains valid and is approaching a negative-GEX acceleration level. Protect the position and avoid adding immediately into the level; continuation requires acceptance and remains research-only this week.";
      }
      else {
        action =
          "The thesis is not fully invalidated, but one or more conditions have deteriorated. Hold only with protection from your existing structure; do not widen the stop and do not add until conditions improve.";
      }
    }

    return {
      snapshotId: snapshot?.id ?? null,
      capturedAt: snapshot?.captured_at ?? null,
      instrument,
      direction,
      sideSign,
      price,
      currentPrice:
        Number.isFinite(currentPrice)
          ? currentPrice
          : null,
      underlying,
      avgEntry,
      openPoints,
      openR,
      totalR,
      openDollars,
      totalPnlDollars,
      realizedPnlDollars,
      initialRisk,
      initialRiskDollars,
      currentStop,
      pointValue,
      contracts,
      bullish,
      bearish,
      activeScenario,
      oppositeScenario,
      currentExecution,
      activeGexGate,
      crossMarket,
      marketCondition,
      techScore,
      techAligned,
      techOpposed,
      of,
      ofAligned,
      ofOpposed,
      triggerOpposed,
      currentTarget,
      nextTarget,
      entryTarget,
      entryTargetReached,
      currentTargetReached,
      entryTargetType,
      currentTargetType,
      targetRelation,
      currentTargetDistance,
      currentTargetDistancePct,
      invalidationCategories,
      warnings,
      managementState,
      managementClass,
      action,
      continuationWatch,
    };
  }

  function activeTradeCaptureEntryContext(
    snapshot,
    instrument,
    direction
  ) {
    const targetRow =
      activeTradeTarget(
        snapshot,
        instrument,
        direction
      );

    const bullish =
      buildTradeScenario(
        snapshot,
        instrument,
        "BULLISH"
      );

    const bearish =
      buildTradeScenario(
        snapshot,
        instrument,
        "BEARISH"
      );

    const execution =
      executionState(
        snapshot,
        instrument,
        bullish,
        bearish
      );

    const target =
      targetRow.target;

    return {
      snapshotId:
        snapshot?.id ?? null,
      snapshotCapturedAt:
        snapshot?.captured_at ?? null,
      productionBias:
        instrumentData(
          snapshot,
          instrument
        )?.bias || null,
      executionState:
        execution?.state || null,
      setupSupport:
        direction === "LONG"
          ? bullish?.score
          : bearish?.score,
      target:
        target
          ? {
              strike: target.strike,
              sign: target.sign,
              reaction: target.reaction,
              temporal_event:
                target.temporal_event,
              attraction_score:
                target.attraction_score,
              gex_millions:
                target.gex_millions,
            }
          : null,
      marketCondition:
        marketConditionLabel(
          execution?.marketCondition
        ),
      crossMarket:
        execution?.crossMarketGate?.label ||
        null,
      gexState:
        execution?.gexGate?.label ||
        null,
      orderFlowRegime:
        execution?.regimeText ||
        null,
      orderFlowTrigger:
        execution?.triggerText ||
        null,
    };
  }

  function activeTradeRecordManagement(
    trade,
    management
  ) {
    if (
      !trade ||
      !management ||
      management.snapshotId === null
    ) {
      return trade;
    }

    const history =
      Array.isArray(trade.history)
        ? [...trade.history]
        : [];

    const last =
      history[
        history.length - 1
      ];

    if (
      last?.snapshotId ===
      management.snapshotId
    ) {
      return trade;
    }

    history.push({
      snapshotId:
        management.snapshotId,
      capturedAt:
        management.capturedAt,
      recordedAt:
        new Date().toISOString(),
      state:
        management.managementState,
      currentPrice:
        management.currentPrice,
      openPoints:
        management.openPoints,
      openR:
        management.openR,
      openDollars:
        management.openDollars,
      underlyingSymbol:
        management.underlying.symbol,
      underlyingSpot:
        management.underlying.price,
      targetStrike:
        management.currentTarget?.strike ??
        null,
      targetReaction:
        management.currentTarget?.reaction ??
        null,
      gexState:
        management.activeGexGate?.label ??
        null,
      marketCondition:
        marketConditionLabel(
          management.marketCondition
        ),
      crossMarket:
        management.crossMarket?.label ??
        null,
      techScore:
        management.techScore,
      orderFlowRegime:
        management.of?.shadow?.regime_bias ??
        null,
      orderFlowTrigger:
        management.of?.shadow?.trigger_bias ??
        null,
      invalidationCategories:
        management.invalidationCategories.map(
          row => row.key
        ),
      warnings:
        management.warnings,
    });

    const updated = {
      ...trade,
      history:
        history.slice(-250),
      lastManagementState:
        management.managementState,
      lastManagementSnapshotId:
        management.snapshotId,
    };

    persistActiveTradeState(
      updated
    );

    return updated;
  }

  function activeTradeStatusClass(value) {
    const text = String(
      value ||
      ""
    ).toUpperCase();

    if (text.includes("EXIT")) {
      return "exit";
    }

    if (
      text.includes("TAKE PROFIT") ||
      text.includes("REDUCE")
    ) {
      return "reduce";
    }

    if (text.includes("PROTECT")) {
      return "protect";
    }

    return "hold";
  }

  function activeTradeSignalClass(
    status
  ) {
    const text = String(
      status ||
      ""
    ).toUpperCase();

    if (
      text.includes("OPPOSE") ||
      text.includes("INVALID") ||
      text.includes("BLOCK") ||
      text.includes("LOST") ||
      text.includes("FLIP") ||
      text.includes("CHAOTIC") ||
      text.includes("CHOPPY")
    ) {
      return "bad";
    }

    if (
      text.includes("CAUTION") ||
      text.includes("MIXED") ||
      text.includes("WAIT") ||
      text.includes("SHIFT") ||
      text.includes("CONDITIONAL") ||
      text.includes("WEAK")
    ) {
      return "warn";
    }

    if (
      text.includes("ALIGN") ||
      text.includes("SUPPORT") ||
      text.includes("STABLE") ||
      text.includes("STRENGTH") ||
      text.includes("TRENDABLE") ||
      text.includes("CONFIRM")
    ) {
      return "good";
    }

    return "neutral";
  }

  function activeTradeManagementHistoryHtml(
    trade
  ) {
    const rows =
      Array.isArray(trade?.history)
        ? [...trade.history]
            .slice(-10)
            .reverse()
        : [];

    if (!rows.length) {
      return `
        <div class="active-trade-history-empty">
          Management history begins with the next saved market cycle.
        </div>
      `;
    }

    return `
      <div class="table-scroll active-trade-history-scroll">
        <table class="active-trade-history-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>State</th>
              <th>Price</th>
              <th>Open R</th>
              <th>Target</th>
              <th>Market</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(row => `
              <tr>
                <td>${localTime(row.capturedAt)}</td>
                <td>${esc(row.state || "—")}</td>
                <td>${fmt(row.currentPrice, 2)}</td>
                <td>${Number.isFinite(Number(row.openR)) ? `${fmtSigned(row.openR, 2)}R` : "—"}</td>
                <td>${esc(row.underlyingSymbol || "")} ${row.targetStrike ?? "—"}</td>
                <td>${esc(String(row.marketCondition || "—").replaceAll("_", " "))}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderActiveTradeManagement(options = {}) {
    const emitManagementSnapshot = options.emitManagementSnapshot !== false;

    const shell =
      $("activeTradeShell");

    if (!shell) return;

    let trade =
      loadActiveTradeState();

    const inactive =
      $("activeTradeInactive");

    const active =
      $("activeTradeActive");

    const badge =
      $("activeTradeModeBadge");

    if (!trade) {
      inactive?.classList.remove(
        "hidden"
      );

      active?.classList.add(
        "hidden"
      );

      if (badge) {
        badge.textContent =
          "NO ACTIVE TRADE";
        badge.className =
          "active-trade-mode-badge inactive";
      }

      updateActiveTradeCurrentHint();
      return;
    }

    inactive?.classList.add(
      "hidden"
    );

    active?.classList.remove(
      "hidden"
    );

    if (!state.latest) {
      if (badge) {
        badge.textContent =
          `${trade.instrument} ${trade.direction} · WAITING FOR DATA`;
        badge.className =
          "active-trade-mode-badge protect";
      }

      $("activeTradeManagement").innerHTML = `
        <div class="active-trade-no-data">
          Active trade is saved in Supabase. Waiting for the next market snapshot.
        </div>
      `;
      return;
    }

    const management =
      activeTradeContext(
        state.latest,
        trade
      );

    trade =
      activeTradeRecordManagement(
        trade,
        management
      );

    window.dispatchEvent(
      new CustomEvent(
        emitManagementSnapshot
          ? "fm-active-trade-management"
          : "fm-active-trade-live-price",
        { detail: { trade, management } }
      )
    );

    const statusClass =
      activeTradeStatusClass(
        management.managementState
      );

    if (badge) {
      badge.textContent =
        `${trade.instrument} ${trade.direction} · ACTIVE`;
      badge.className =
        `active-trade-mode-badge ${statusClass}`;
    }

    const entryTargetStrike =
      trade?.entryContext
        ?.target?.strike;

    const currentTargetStrike =
      management.currentTarget?.strike;

    const nextTargetStrike =
      management.nextTarget?.strike;

    const currentGexType =
      management.currentTargetType?.label ||
      "GEX target unavailable";

    const openRText =
      Number.isFinite(
        Number(management.openR)
      )
        ? `${fmtSigned(management.openR, 2)}R`
        : "—";

    const openDollarText =
      Number.isFinite(
        Number(management.openDollars)
      )
        ? `$${fmtSigned(management.openDollars, 0)}`
        : "—";

    const warningHtml = [
      ...management.invalidationCategories.map(
        row => row.text
      ),
      ...management.warnings,
    ];

    const modelStatus =
      management.invalidationCategories.some(
        row => row.key === "THESIS"
      )
        ? "OPPOSED"
        : management.currentExecution?.modelAligned
          ? "ALIGNED"
          : "NEUTRAL / MIXED";

    const techStatus =
      management.techOpposed
        ? `OPPOSED · ${fmtSigned(management.techScore, 0)}`
        : management.techAligned
          ? `ALIGNED · ${fmtSigned(management.techScore, 0)}`
          : `NEUTRAL · ${Number.isFinite(management.techScore) ? fmtSigned(management.techScore, 0) : "N/A"}`;

    const ofStatus =
      management.of?.fresh
        ? `${String(management.of.model?.regime_bias || "MIXED").replaceAll("_", " ")} · trigger ${String(management.of.model?.trigger_bias || "MIXED").replaceAll("_", " ")}`
        : "STALE";

    const continuationHtml =
      management.continuationWatch
        ? `
          <div class="active-trade-continuation-watch">
            <strong>⚡ CONTINUATION WATCH · RESEARCH ONLY</strong>
            <span>
              Primary target was a negative-GEX acceleration-if-accepted level.
              ${nextTargetStrike !== undefined && nextTargetStrike !== null ? `Next structural GEX: ${management.underlying.symbol} ${nextTargetStrike}.` : "No farther structural GEX target is currently available."}
              Do not let this shadow signal override your profit-protection plan this week.
            </span>
          </div>
        `
        : "";

    $("activeTradeManagement").innerHTML = `
      <div class="active-trade-management-top">
        <div>
          <div class="active-trade-symbol-line">
            <strong>${esc(trade.instrument)} ${esc(trade.direction)}</strong>
            <span>${trade.contracts} contract${Number(trade.contracts) === 1 ? "" : "s"}</span>
          </div>
          <div class="active-trade-entry-time">
            Activated ${localDateTime(trade.activatedAt)} · entry snapshot ${trade.entryContext?.snapshotCapturedAt ? localTime(trade.entryContext.snapshotCapturedAt) : "—"}
          </div>
        </div>

        <div class="active-trade-management-state ${statusClass}">
          <span>TRADE STATE</span>
          <strong>${esc(management.managementState)}</strong>
        </div>
      </div>

      <div class="active-trade-metrics">
        <div class="active-trade-metric">
          <span>Initial Entry</span>
          <strong>${fmt(trade.entry, 2)}</strong>
        </div>
        <div class="active-trade-metric">
          <span>Avg Entry</span>
          <strong>${fmt(trade.avgEntry ?? trade.entry, 2)}</strong>
          <small>after scales</small>
        </div>
        <div class="active-trade-metric">
          <span>Current</span>
          <strong>${fmt(management.currentPrice, 2)}</strong>
          <small class="${management.price.live ? "live-price-fresh" : ""}">${esc(management.price.source)}${management.price.live && Number.isFinite(management.price.ageMinutes) ? ` · ${esc(liveAgeText(management.price.ageMinutes))}` : ""}</small>
        </div>
        <div class="active-trade-metric">
          <span>Open Qty</span>
          <strong>${trade.openContracts ?? trade.contracts}</strong>
          <small>max ${trade.maxContracts ?? trade.contracts}</small>
        </div>
        <div class="active-trade-metric">
          <span>Structural Stop</span>
          <strong>${fmt(trade.currentStop, 2)}</strong>
          <small>Initial ${fmt(trade.initialStop, 2)}</small>
        </div>
        <div class="active-trade-metric">
          <span>Initial Risk</span>
          <strong>${fmt(trade.initialRiskPoints, 2)} pts</strong>
          <small>$${fmt(trade.initialRiskDollars, 0)}</small>
        </div>
        <div class="active-trade-metric">
          <span>Realized P/L</span>
          <strong>${formatMoney(trade.realizedPnlDollars || 0)}</strong>
          <small>trims / exits</small>
        </div>
        <div class="active-trade-metric emphasis">
          <span>Unrealized P/L</span>
          <strong>${fmtSigned(management.openPoints, 2)} pts</strong>
          <small>${formatMoney(management.openDollars)}</small>
        </div>
        <div class="active-trade-metric emphasis">
          <span>Total R</span>
          <strong>${Number.isFinite(Number(management.totalR)) ? `${fmtSigned(management.totalR, 2)}R` : "—"}</strong>
          <small>${formatMoney(management.totalPnlDollars)} vs initial risk</small>
        </div>
      </div>

      <div class="active-trade-target-strip">
        <div>
          <span>Underlying</span>
          <strong>${esc(management.underlying.symbol)} ${fmt(management.underlying.price, management.underlying.symbol === "SPX" ? 1 : 2)}</strong>
          <small class="${management.underlying.live ? "live-price-fresh" : ""}">${management.underlying.live ? "LIVE 1M" : "MODEL SNAPSHOT"}</small>
        </div>
        <div>
          <span>Entry Target</span>
          <strong>${entryTargetStrike ?? "—"}</strong>
          <small>${esc(management.entryTargetType?.label || "—")}</small>
        </div>
        <div>
          <span>Current Target</span>
          <strong>${currentTargetStrike ?? "—"}</strong>
          <small>${esc(management.targetRelation.label)}</small>
        </div>
        <div>
          <span>Next GEX</span>
          <strong>${nextTargetStrike ?? "—"}</strong>
          <small>${esc(currentGexType)}</small>
        </div>
      </div>

      <div class="active-trade-context-grid">
        <div class="active-trade-context-item ${activeTradeSignalClass(modelStatus)}">
          <span>MODEL / THESIS</span>
          <strong>${esc(modelStatus)}</strong>
          <small>Active setup ${fmt(management.activeScenario?.score, 0)} · Opp ${fmt(management.oppositeScenario?.score, 0)}</small>
        </div>

        <div class="active-trade-context-item ${activeTradeSignalClass(management.activeGexGate?.label)}">
          <span>GEX</span>
          <strong>${esc(management.activeGexGate?.label || "UNKNOWN")}</strong>
          <small>${esc(management.targetRelation.label)}</small>
        </div>

        <div class="active-trade-context-item ${activeTradeSignalClass(marketConditionLabel(management.marketCondition))}">
          <span>MARKET</span>
          <strong>${esc(marketConditionLabel(management.marketCondition))}</strong>
          <small>${esc(marketConditionMetricText(management.marketCondition))}</small>
        </div>

        <div class="active-trade-context-item ${activeTradeSignalClass(management.crossMarket?.label)}">
          <span>CROSS-MKT</span>
          <strong>${esc(management.crossMarket?.label || "UNKNOWN")}</strong>
          <small>${esc(management.crossMarket?.detail || "")}</small>
        </div>

        <div class="active-trade-context-item ${activeTradeSignalClass(techStatus)}">
          <span>5M TECH</span>
          <strong>${esc(techStatus)}</strong>
          <small>${esc(management.currentExecution?.positionText || "")}</small>
        </div>

        <div class="active-trade-context-item ${activeTradeSignalClass(management.ofOpposed ? "OPPOSED" : management.ofAligned ? "ALIGNED" : ofStatus)}">
          <span>ORDER FLOW</span>
          <strong>${esc(ofStatus)}</strong>
          <small>${esc(management.of?.futuresSymbol || "ES/NQ")} auction context</small>
        </div>
      </div>

      <div class="active-trade-action ${statusClass}">
        <span>ACTION</span>
        <strong>${esc(management.action)}</strong>
      </div>

      ${continuationHtml}

      ${warningHtml.length ? `
        <div class="active-trade-reasons">
          <span>WHY / WATCH</span>
          <ul>
            ${warningHtml.map(text => `<li>${esc(text)}</li>`).join("")}
          </ul>
        </div>
      ` : `
        <div class="active-trade-reasons clean">
          <span>WHY / WATCH</span>
          <strong>No material thesis deterioration is detected in the current completed data.</strong>
        </div>
      `}

      <div class="active-trade-controls">
        <form id="activeTradeStopUpdateForm" class="active-trade-stop-update">
          <label>
            <span>Update structural stop</span>
            <input id="activeTradeNewStop" type="number" step="0.25" value="${esc(trade.currentStop)}" required />
          </label>
          <button type="submit" class="ghost-button">Tighten stop</button>
        </form>

        <div class="active-trade-control-buttons">
          <button id="activeTradeExport" type="button" class="ghost-button">Export trade JSON</button>
          <button id="activeTradeEndLegacy" type="button" class="ghost-button danger">End trade</button>
        </div>
      </div>

      <div id="activeTradeControlError" class="error-text"></div>

      <details class="active-trade-history-details">
        <summary>
          <span>Management history</span>
          <small>Last ${Math.min((trade.history || []).length, 10)} saved cycles · Supabase journal</small>
        </summary>
        ${activeTradeManagementHistoryHtml(trade)}
      </details>

      <div class="active-trade-disclaimer">
        Context engine only. It does not know your broker fill state, intrabar stop execution or exact manual 10m L/S entry. Broker orders and your structural stop remain authoritative.
      </div>
    `;

    bindActiveTradeDynamicControls();
  }

  function updateActiveTradeCurrentHint() {
    const hint =
      $("activeTradeCurrentHint");

    if (!hint) return;

    const instrument =
      $("activeTradeInstrument")?.value ||
      "MES";

    if (!state.latest) {
      hint.textContent =
        "Current futures price: waiting for market data";
      return;
    }

    const row =
      activeTradeFuturesPrice(
        state.latest,
        instrument
      );

    hint.textContent =
      Number.isFinite(row.price)
        ? `Current futures price: ${fmt(row.price, 2)} · ${row.source}`
        : "Current futures price unavailable";
  }

  function startActiveTradeFromForm(event) {
    event.preventDefault();

    const error =
      $("activeTradeFormError");

    if (error) {
      error.textContent = "";
    }

    if (!state.latest) {
      if (error) {
        error.textContent =
          "Wait for a current market snapshot before activating trade management.";
      }
      return;
    }

    const instrument =
      $("activeTradeInstrument")?.value;

    const direction =
      $("activeTradeDirection")?.value;

    const entry = Number(
      $("activeTradeEntry")?.value
    );

    const stop = Number(
      $("activeTradeStop")?.value
    );

    const contracts = Number(
      $("activeTradeContracts")?.value
    );

    if (
      !["MES", "MNQ"].includes(instrument) ||
      !["LONG", "SHORT"].includes(direction) ||
      !Number.isFinite(entry) ||
      !Number.isFinite(stop) ||
      !Number.isInteger(contracts) ||
      contracts < 1
    ) {
      if (error) {
        error.textContent =
          "Enter a valid instrument, direction, entry, structural stop and whole-number contract count.";
      }
      return;
    }

    const validStop =
      direction === "LONG"
        ? stop < entry
        : stop > entry;

    if (!validStop) {
      if (error) {
        error.textContent =
          direction === "LONG"
            ? "For a LONG activation, the initial structural stop must be below entry."
            : "For a SHORT activation, the initial structural stop must be above entry.";
      }
      return;
    }

    const initialRiskPoints =
      Math.abs(
        entry - stop
      );

    const pointValue =
      ACTIVE_TRADE_POINT_VALUE[
        instrument
      ];

    const trade = {
      version:
        "ACTIVE_TRADE_MANAGEMENT_V1",
      active: true,
      instrument,
      direction,
      entry,
      initialStop: stop,
      currentStop: stop,
      initialRiskPoints,
      contracts,
      pointValue,
      initialRiskDollars:
        initialRiskPoints *
        pointValue *
        contracts,
      activatedAt:
        new Date().toISOString(),
      entryContext:
        activeTradeCaptureEntryContext(
          state.latest,
          instrument,
          direction
        ),
      history: [],
    };

    persistActiveTradeState(
      trade
    );

    renderActiveTradeManagement();
    toast(
      `${instrument} ${direction} trade management activated`
    );
  }

  function bindActiveTradeDynamicControls() {
    const stopForm =
      $("activeTradeStopUpdateForm");

    stopForm?.addEventListener(
      "submit",
      event => {
        event.preventDefault();

        const error =
          $("activeTradeControlError");

        if (error) {
          error.textContent = "";
        }

        const trade =
          loadActiveTradeState();

        if (!trade || !state.latest) {
          return;
        }

        const newStop = Number(
          $("activeTradeNewStop")?.value
        );

        const current =
          activeTradeFuturesPrice(
            state.latest,
            trade.instrument
          ).price;

        if (
          !Number.isFinite(newStop) ||
          !Number.isFinite(current)
        ) {
          if (error) {
            error.textContent =
              "A valid stop and current completed futures price are required.";
          }
          return;
        }

        const oldStop = Number(
          trade.currentStop
        );

        const tightens =
          trade.direction === "LONG"
            ? newStop >= oldStop &&
              newStop < current
            : newStop <= oldStop &&
              newStop > current;

        if (!tightens) {
          if (error) {
            error.textContent =
              trade.direction === "LONG"
                ? "A LONG stop can only tighten upward and must remain below the current completed price."
                : "A SHORT stop can only tighten downward and must remain above the current completed price.";
          }
          return;
        }

        const updated = {
          ...trade,
          currentStop: newStop,
          stopUpdatedAt:
            new Date().toISOString(),
        };

        persistActiveTradeState(
          updated
        );

        renderActiveTradeManagement();
        toast(
          `Structural stop updated to ${fmt(newStop, 2)}`
        );
      }
    );

    $("activeTradeExport")?.addEventListener(
      "click",
      () => {
        const trade =
          loadActiveTradeState();

        if (!trade) return;

        const management =
          state.latest
            ? activeTradeContext(
                state.latest,
                trade
              )
            : null;

        downloadText(
          `active-trade-${trade.instrument}-${trade.direction}-${new Date(trade.activatedAt).toISOString().replaceAll(":", "-")}.json`,
          JSON.stringify(
            {
              trade,
              latestManagement:
                management,
            },
            null,
            2
          ),
          "application/json"
        );
      }
    );

    $("activeTradeEnd")?.addEventListener(
      "click",
      () => {
        const trade =
          loadActiveTradeState();

        if (!trade) return;

        const archiveRaw =
          safeLocalStorageGet(
            ACTIVE_TRADE_ARCHIVE_KEY
          );

        let archive = [];

        try {
          archive = archiveRaw
            ? JSON.parse(archiveRaw)
            : [];
        }
        catch (_error) {
          archive = [];
        }

        archive.push({
          ...trade,
          active: false,
          endedAt:
            new Date().toISOString(),
          finalManagement:
            state.latest
              ? activeTradeContext(
                  state.latest,
                  trade
                )
              : null,
        });

        safeLocalStorageSet(
          ACTIVE_TRADE_ARCHIVE_KEY,
          JSON.stringify(
            archive.slice(-25)
          )
        );

        persistActiveTradeState(
          null
        );

        renderActiveTradeManagement();
        toast(
          "Legacy local end disabled"
        );
      }
    );
  }

  window.FM_ACTIVE_TRADE_HELPERS = {
    load: loadActiveTradeState,
    persist: persistActiveTradeState,
    render: renderActiveTradeManagement,
    context: activeTradeContext,
    futuresPrice: activeTradeFuturesPrice,
    captureEntryContext: activeTradeCaptureEntryContext,
  };

  function renderLive() {
    if (!state.latest) {
      $("currentCycleBadge").textContent = "NO DATA";
      return;
    }

    $("currentCycleBadge").textContent = localDateTime(state.latest.captured_at);

    renderActiveTradeManagement();
    renderInstrumentCards(state.latest, "instrumentCards");
    renderEntrySignalCards();
    renderTechnicalCards(state.latest, "technicalCards");
    renderMarketCards(state.latest, "marketCards");

    renderZeroDteFlowCards();
    renderZeroDtePressureHistory();
    renderFlowHistory();
    renderAttractionHistory();

    updateExplorer();
  }

  // Refresh scenario cards if Order Flow is recovered after initial page load.
  window.addEventListener("fm-orderflow-recovered", () => {
    if (state.latest) {
      renderActiveTradeManagement();
      renderInstrumentCards(
        state.latest,
        "instrumentCards"
      );
      renderEntrySignalCards();
    }

    if (state.selected) {
      renderInstrumentCards(
        state.selected,
        "historyInstrumentCards"
      );
    }
  });

  function populateHistoryTimes() {
    const select = $("historyTimeSelect");
    select.innerHTML = "";

    [...state.daySnapshots]
      .reverse()
      .forEach(row => {
        const option = document.createElement("option");
        option.value = String(row.id);
        option.textContent = `${localTime(row.captured_at)} · ${row.preferred_instrument || "No preference"}`;
        select.appendChild(option);
      });

    if (state.latest && state.daySnapshots.some(r => r.id === state.latest.id)) {
      select.value = String(state.latest.id);
    }
  }

  function renderHistorySelected() {
    const id = Number($("historyTimeSelect").value);
    const row = state.daySnapshots.find(r => Number(r.id) === id) ||
      state.daySnapshots[state.daySnapshots.length - 1];

    state.selected = normalizeSnapshot(row || null);
    notifyOrderflowState("history-selection");

    if (!state.selected) return;

    $("historySummary").textContent =
      `Viewing ${localDateTime(state.selected.captured_at)}. ` +
      `This is the exact structured model snapshot saved for that cycle.`;

    renderInstrumentCards(state.selected, "historyInstrumentCards");
    renderTechnicalCards(state.selected, "historyTechnicalCards");
    renderMarketCards(state.selected, "historyMarketCards", "history-");
    updateExplorer();
  }

  async function loadHistoryDate() {
    const date = $("historyDate").value;
    if (!date) return;

    await fetchDay(date);
    populateHistoryTimes();
    renderHistorySelected();
  }

  function renderTradeabilityChart() {
    destroyChart("tradeability");

    state.charts.tradeability = new Chart(
      $("tradeabilityChart").getContext("2d"),
      {
        type: "line",
        data: {
          labels: state.daySnapshots.map(r => localTime(r.captured_at)),
          datasets: [
            {
              label: "MES",
              data: state.daySnapshots.map(r => r.mes_tradeability),
              borderColor: "#35a9d9",
              pointRadius: 2,
              tension: .2,
            },
            {
              label: "MNQ",
              data: state.daySnapshots.map(r => r.mnq_tradeability),
              borderColor: "#e98a19",
              pointRadius: 2,
              tension: .2,
            },
          ],
        },
        options: {
          ...chartOptions("Directional Confluence"),
          scales: {
            ...chartOptions("").scales,
            y: {
              min: 0, max: 100,
              grid: { color: "rgba(61,83,103,.25)" },
              ticks: { color: "#9dafbd" },
            },
          },
        },
      }
    );
  }

  function renderBiasDistribution() {
    const counts = {};

    state.daySnapshots.forEach(row => {
      ["MES", "MNQ"].forEach(symbol => {
        const bias = instrumentData(row, symbol)?.bias || "NO_DATA";
        const key = String(bias).replaceAll("_", " ");
        counts[key] = (counts[key] || 0) + 1;
      });
    });

    destroyChart("biasDistribution");

    state.charts.biasDistribution = new Chart(
      $("biasDistributionChart").getContext("2d"),
      {
        type: "bar",
        data: {
          labels: Object.keys(counts),
          datasets: [{
            label: "Snapshot count",
            data: Object.values(counts),
            backgroundColor: "#2683c7",
          }],
        },
        options: chartOptions("Count"),
      }
    );
  }

  function percent(numerator, denominator) {
    if (!denominator) return null;
    return numerator / denominator * 100;
  }

  function outcomeMetadata(row) {
    const raw = row?.reaction_outcome;

    if (!raw) {
      return {};
    }

    if (
      typeof raw === "object" &&
      !Array.isArray(raw)
    ) {
      return raw;
    }

    try {
      const parsed = JSON.parse(raw);
      return (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      )
        ? parsed
        : {};
    }
    catch {
      return {};
    }
  }

  function normalizedOutcomeState(row) {
    return String(
      row?.confidence ||
      outcomeMetadata(row)?.final_execution_state ||
      "UNKNOWN"
    )
      .replaceAll("_", " ")
      .trim();
  }

  function predictionKey(row) {
    return [
      row?.snapshot_id ?? "NO_SNAPSHOT",
      row?.instrument ?? "NO_INSTRUMENT",
      row?.model_bias ?? "NO_BIAS",
      row?.target_symbol ?? "NO_TARGET",
      row?.target_strike ?? "NO_STRIKE",
      row?.target_side ?? "NO_SIDE",
    ].join("|");
  }

  function groupPredictionRows(rows = state.outcomes) {
    const groups = new Map();

    rows.forEach(row => {
      const key = predictionKey(row);

      if (!groups.has(key)) {
        groups.set(key, {
          key,
          snapshotId: row.snapshot_id,
          instrument: row.instrument,
          bias: row.model_bias,
          setup: Number(row.model_score),
          state: normalizedOutcomeState(row),
          capturedAt: row.captured_at,
          targetSymbol: row.target_symbol,
          targetStrike: row.target_strike,
          targetSide: row.target_side,
          horizons: {},
          metadata: outcomeMetadata(row),
        });
      }

      const group = groups.get(key);
      const horizon = Number(row.horizon_minutes);

      if (Number.isFinite(horizon)) {
        group.horizons[horizon] = row;
      }

      // V1.1 rows all share these values, but keep the latest nonempty form.
      group.state = normalizedOutcomeState(row) || group.state;
      group.metadata = Object.keys(outcomeMetadata(row)).length
        ? outcomeMetadata(row)
        : group.metadata;
    });

    return [...groups.values()]
      .sort(
        (a, b) =>
          new Date(b.capturedAt) -
          new Date(a.capturedAt)
      );
  }

  function horizonOutcomeClass(row) {
    if (!row || row.bias_correct === null) {
      return "pending";
    }

    return row.bias_correct === true
      ? "correct"
      : "wrong";
  }

  function renderHorizonCell(row) {
    if (!row) {
      return `
        <span class="horizon-outcome pending">
          <strong>—</strong>
          <small>pending</small>
        </span>
      `;
    }

    const cls = horizonOutcomeClass(row);

    return `
      <span class="horizon-outcome ${cls}">
        <strong>${fmtSigned(row.return_points)}</strong>
        <small>
          ${
            row.bias_correct === null
              ? "pending"
              : row.bias_correct
                ? "correct"
                : "wrong"
          }
        </small>
      </span>
    `;
  }

  function predictionTargetSummary(group) {
    const rows = Object.values(
      group.horizons
    )
      .filter(Boolean)
      .sort(
        (a, b) =>
          Number(a.horizon_minutes) -
          Number(b.horizon_minutes)
      );

    const hit = rows.find(
      row => row.target_hit === true
    );

    const farthest = rows[
      rows.length - 1
    ];

    let status = "PENDING";
    let cls = "pending";

    if (hit) {
      status = `HIT ${fmt(hit.target_hit_minutes, 1)}m`;
      cls = "correct";
    }
    else if (
      farthest &&
      farthest.target_hit === false
    ) {
      status = `MISS ≤${farthest.horizon_minutes}m`;
      cls = "wrong";
    }

    const arrow =
      String(
        group.targetSide ||
        ""
      ).toUpperCase() === "UP"
        ? "↑"
        : String(
            group.targetSide ||
            ""
          ).toUpperCase() === "DOWN"
          ? "↓"
          : "";

    return `
      <div class="prediction-target">
        <strong>
          ${esc(group.targetSymbol || "—")}
          ${group.targetStrike ?? ""}
          ${arrow}
        </strong>
        <small class="${cls}">
          ${status}
        </small>
      </div>
    `;
  }

  function predictionDetailHtml(group) {
    const horizons = [
      15,
      30,
      45,
      60,
    ];

    const meta =
      group.metadata ||
      {};

    const market =
      meta.market_condition ||
      meta.market_condition_payload?.condition ||
      "—";

    const cross =
      meta.cross_market ||
      "—";

    const gex =
      meta.gex_gate ||
      "—";

    const orderFlow =
      meta.orderflow ||
      "—";

    const preferred =
      meta.preferred_instrument ||
      "—";

    const dncShadow =
      meta.do_not_chase_shadow;

    const dncShadowHtml =
      (
        dncShadow &&
        dncShadow.research_only === true
      )
        ? `
          <div class="dnc-prediction-shadow">
            <div>
              <span>SHADOW GEX</span>
              <strong>${esc(String(dncShadow.primary?.shadow_type || "—").replaceAll("_", " "))}</strong>
            </div>
            <div>
              <span>PRIMARY</span>
              <strong>${esc(dncShadow.primary?.symbol || "")} ${dncShadow.primary?.strike ?? "—"}</strong>
            </div>
            <div>
              <span>NEXT TARGET</span>
              <strong>${dncShadow.second_target?.strike ?? "—"}</strong>
            </div>
            <div>
              <span>ACCEPTED</span>
              <strong>${dncShadow.observation?.accepted_through_primary ? "YES" : "NO"}</strong>
            </div>
            <div>
              <span>2ND HIT</span>
              <strong>${dncShadow.observation?.second_target_hit === null ? "—" : dncShadow.observation?.second_target_hit ? "YES" : "NO"}</strong>
            </div>
          </div>
        `
        : "";

    return `
      <div class="prediction-detail-wrap">
        ${dncShadowHtml}
        <div class="prediction-detail-context">
          <div>
            <span>Market</span>
            <strong>${esc(String(market).replaceAll("_", " "))}</strong>
          </div>
          <div>
            <span>Cross-Market</span>
            <strong>${esc(String(cross).replaceAll("_", " "))}</strong>
          </div>
          <div>
            <span>GEX</span>
            <strong>${esc(String(gex).replaceAll("_", " "))}</strong>
          </div>
          <div>
            <span>Order Flow</span>
            <strong>${esc(String(orderFlow).replaceAll("_", " "))}</strong>
          </div>
          <div>
            <span>Preferred</span>
            <strong>${esc(preferred)}</strong>
          </div>
        </div>

        <div class="horizon-detail-grid">
          ${horizons.map(horizon => {
            const row =
              group.horizons[
                horizon
              ];

            if (!row) {
              return `
                <article class="horizon-detail-card pending">
                  <div class="horizon-detail-title">${horizon}m</div>
                  <div class="horizon-detail-empty">Not mature</div>
                </article>
              `;
            }

            const cls =
              horizonOutcomeClass(
                row
              );

            return `
              <article class="horizon-detail-card ${cls}">
                <div class="horizon-detail-title">
                  ${horizon}m
                  <span>
                    ${
                      row.bias_correct === null
                        ? "PENDING"
                        : row.bias_correct
                          ? "CORRECT"
                          : "WRONG"
                    }
                  </span>
                </div>

                <div class="horizon-detail-metrics">
                  <div>
                    <span>Return</span>
                    <strong>${fmtSigned(row.return_points)}</strong>
                  </div>
                  <div>
                    <span>MFE</span>
                    <strong class="positive">${fmtSigned(row.mfe_points)}</strong>
                  </div>
                  <div>
                    <span>MAE</span>
                    <strong class="negative">${fmtSigned(row.mae_points)}</strong>
                  </div>
                </div>
              </article>
            `;
          }).join("")}
        </div>
      </div>
    `;
  }

  function syncPredictionStateFilter(groups) {
    const select =
      $("predictionStateFilter");

    if (!select) return;

    const current =
      select.value ||
      "ALL";

    const states = [
      ...new Set(
        groups
          .map(group => group.state)
          .filter(Boolean)
      )
    ].sort();

    select.innerHTML =
      `<option value="ALL">All states</option>` +
      states.map(value => `
        <option value="${esc(value)}">
          ${esc(value)}
        </option>
      `).join("");

    select.value =
      states.includes(current)
        ? current
        : "ALL";
  }

  function renderGroupedPredictions() {
    const table =
      $("groupedPredictionsTable");

    if (!table) return;

    const allGroups =
      groupPredictionRows();

    syncPredictionStateFilter(
      allGroups
    );

    const instrument =
      $("predictionInstrumentFilter")?.value ||
      "ALL";

    const bias =
      $("predictionBiasFilter")?.value ||
      "ALL";

    const stateFilter =
      $("predictionStateFilter")?.value ||
      "ALL";

    const groups =
      allGroups.filter(group => {
        if (
          instrument !== "ALL" &&
          group.instrument !== instrument
        ) {
          return false;
        }

        if (
          bias !== "ALL" &&
          group.bias !== bias
        ) {
          return false;
        }

        if (
          stateFilter !== "ALL" &&
          group.state !== stateFilter
        ) {
          return false;
        }

        return true;
      });

    const body =
      table.querySelector(
        "tbody"
      );

    if (!groups.length) {
      body.innerHTML = `
        <tr>
          <td colspan="10" class="empty-table-cell">
            No predictions match the current filters.
          </td>
        </tr>
      `;

      $("predictionCountNote").textContent =
        `0 of ${allGroups.length} predictions shown`;

      return;
    }

    body.innerHTML =
      groups.map((group, index) => `
        <tr
          class="prediction-main-row"
          data-prediction-toggle="${index}"
          title="Click for MFE / MAE detail"
        >
          <td>${localTime(group.capturedAt)}</td>
          <td><strong>${esc(group.instrument)}</strong></td>
          <td class="${biasClass(group.bias)}">
            ${esc(group.bias)}
          </td>
          <td>
            <strong>${fmt(group.setup, 1)}</strong>
          </td>
          <td>
            <span class="prediction-state">
              ${esc(group.state)}
            </span>
          </td>
          <td>${renderHorizonCell(group.horizons[15])}</td>
          <td>${renderHorizonCell(group.horizons[30])}</td>
          <td>${renderHorizonCell(group.horizons[45])}</td>
          <td>${renderHorizonCell(group.horizons[60])}</td>
          <td>${predictionTargetSummary(group)}</td>
        </tr>

        <tr
          class="prediction-detail-row hidden"
          data-prediction-detail="${index}"
        >
          <td colspan="10">
            ${predictionDetailHtml(group)}
          </td>
        </tr>
      `).join("");

    $$(
      "#groupedPredictionsTable [data-prediction-toggle]"
    ).forEach(row => {
      row.addEventListener(
        "click",
        () => {
          const key =
            row.dataset
              .predictionToggle;

          const detail =
            $(
              `[data-prediction-detail="${key}"]`
            );

          if (!detail) return;

          detail.classList.toggle(
            "hidden"
          );

          row.classList.toggle(
            "expanded",
            !detail.classList.contains(
              "hidden"
            )
          );
        }
      );
    });

    $("predictionCountNote").textContent =
      `${groups.length} of ${allGroups.length} predictions shown`;
  }

  function researchAccuracy(
    sample,
    instrument
  ) {
    const rows =
      sample.filter(row =>
        row.instrument === instrument &&
        row.bias_correct !== null
      );

    return percent(
      rows.filter(row =>
        row.bias_correct === true
      ).length,
      rows.length
    );
  }

  function renderResearchTable(
    tableId,
    keySelector
  ) {
    const table =
      $(tableId);

    if (!table) return;

    const horizon =
      Number(
        $("analyticsResearchHorizon")?.value ||
        15
      );

    const rows =
      state.outcomes.filter(row =>
        Number(row.horizon_minutes) === horizon
      );

    const grouped =
      new Map();

    rows.forEach(row => {
      const key =
        keySelector(row) ||
        "UNKNOWN";

      if (!grouped.has(key)) {
        grouped.set(
          key,
          []
        );
      }

      grouped
        .get(key)
        .push(row);
    });

    const result =
      [...grouped.entries()]
        .map(([label, sample]) => {
          const setupValues =
            sample
              .map(row =>
                Number(
                  row.model_score
                )
              )
              .filter(
                Number.isFinite
              );

          const avgSetup =
            setupValues.length
              ? setupValues.reduce(
                  (a, b) => a + b,
                  0
                ) /
                setupValues.length
              : null;

          return {
            label,
            n: sample.length,
            avgSetup,
            mes:
              researchAccuracy(
                sample,
                "MES"
              ),
            mnq:
              researchAccuracy(
                sample,
                "MNQ"
              ),
          };
        })
        .sort(
          (a, b) =>
            b.n - a.n
        );

    const body =
      table.querySelector(
        "tbody"
      );

    if (!result.length) {
      body.innerHTML = `
        <tr>
          <td colspan="5" class="empty-table-cell">
            No ${horizon}m outcomes yet.
          </td>
        </tr>
      `;
      return;
    }

    const accuracyText =
      value =>
        value === null
          ? "—"
          : `${fmt(value, 1)}%`;

    const accuracyClass =
      value => {
        if (value === null) {
          return "neutral";
        }

        if (value >= 55) {
          return "positive";
        }

        if (value < 45) {
          return "negative";
        }

        return "neutral";
      };

    body.innerHTML =
      result.map(row => `
        <tr>
          <td>
            <strong>
              ${esc(
                String(
                  row.label
                ).replaceAll(
                  "_",
                  " "
                )
              )}
            </strong>
          </td>
          <td>${row.n}</td>
          <td>${fmt(row.avgSetup, 1)}</td>
          <td class="${accuracyClass(row.mes)}">
            ${accuracyText(row.mes)}
          </td>
          <td class="${accuracyClass(row.mnq)}">
            ${accuracyText(row.mnq)}
          </td>
        </tr>
      `).join("");
  }

  function dncShadowPayload(row) {
    const meta =
      outcomeMetadata(row);

    const shadow =
      meta?.do_not_chase_shadow;

    return (
      shadow &&
      shadow.research_only === true
    )
      ? shadow
      : null;
  }

  function renderDncShadowResearch() {
    const table =
      $("dncShadowTable");

    if (!table) return;

    const horizon =
      Number(
        $("analyticsResearchHorizon")?.value ||
        15
      );

    const rows =
      state.outcomes.filter(row =>
        Number(row.horizon_minutes) === horizon &&
        normalizedOutcomeState(row) === "DO NOT CHASE" &&
        dncShadowPayload(row)
      );

    const groups =
      new Map();

    rows.forEach(row => {
      const shadow =
        dncShadowPayload(row);

      const type =
        shadow?.primary?.shadow_type ||
        "OTHER_GEX_STRUCTURE";

      if (!groups.has(type)) {
        groups.set(type, []);
      }

      groups.get(type).push({
        row,
        shadow,
      });
    });

    const pctText =
      (num, den) => {
        const value =
          percent(num, den);

        return value === null
          ? "—"
          : `${fmt(value, 1)}%`;
      };

    const avgValue =
      values => {
        const cleanValues =
          values
            .map(Number)
            .filter(Number.isFinite);

        return cleanValues.length
          ? cleanValues.reduce(
              (a, b) => a + b,
              0
            ) / cleanValues.length
          : null;
      };

    const displayType =
      type => {
        if (type === "NEGATIVE_GEX_ACCELERATION") {
          return "NEG GEX · ACCELERATION";
        }
        if (type === "POSITIVE_GEX_BRAKE") {
          return "POS GEX · BRAKE";
        }
        return String(type).replaceAll("_", " ");
      };

    const result =
      [...groups.entries()]
        .map(([type, sample]) => {
          const primaryHits =
            sample.filter(item =>
              item.shadow?.observation?.primary_hit === true
            ).length;

          const accepted =
            sample.filter(item =>
              item.shadow?.observation?.accepted_through_primary === true
            ).length;

          const altEligible =
            sample.filter(item =>
              item.shadow?.second_target?.hypothetical_candidate_60_10 === true
            ).length;

          const secondEvaluable =
            sample.filter(item =>
              item.shadow?.observation?.second_target_hit !== null
            );

          const secondHits =
            secondEvaluable.filter(item =>
              item.shadow?.observation?.second_target_hit === true
            ).length;

          const continuation =
            avgValue(
              sample.map(item =>
                item.shadow?.observation?.max_underlying_continuation_points_after_acceptance
              )
            );

          const postAcceptMfe =
            avgValue(
              sample.map(item =>
                item.shadow?.observation?.post_acceptance_futures_mfe_points
              )
            );

          return {
            type,
            n: sample.length,
            primaryHits,
            accepted,
            altEligible,
            secondEvaluable: secondEvaluable.length,
            secondHits,
            continuation,
            postAcceptMfe,
          };
        })
        .sort((a, b) =>
          b.n - a.n
        );

    const body =
      table.querySelector("tbody");

    if (!result.length) {
      body.innerHTML = `
        <tr>
          <td colspan="8" class="empty-table-cell">
            No DO NOT CHASE shadow outcomes are available at ${horizon}m yet.
            Run the V1.2 evaluator with --force to backfill existing rows.
          </td>
        </tr>
      `;

      $("dncShadowFootnote").textContent =
        "Live DO NOT CHASE execution remains unchanged.";

      return;
    }

    body.innerHTML =
      result.map(row => `
        <tr>
          <td><strong>${esc(displayType(row.type))}</strong></td>
          <td>${row.n}</td>
          <td>${pctText(row.primaryHits, row.n)}</td>
          <td>${pctText(row.accepted, row.n)}</td>
          <td>${pctText(row.altEligible, row.n)}</td>
          <td>${pctText(row.secondHits, row.secondEvaluable)}</td>
          <td>${row.continuation === null ? "—" : fmtSigned(row.continuation)}</td>
          <td>${row.postAcceptMfe === null ? "—" : fmtSigned(row.postAcceptMfe)}</td>
        </tr>
      `).join("");

    $("dncShadowFootnote").textContent =
      `${horizon}m shadow horizon · acceptance = two consecutive saved SPX/QQQ cycles beyond primary by ≥0.01% · live DO NOT CHASE rule unchanged.`;
  }

  function renderModelResearch() {
    renderDncShadowResearch();

    renderResearchTable(
      "stateResearchTable",
      row =>
        normalizedOutcomeState(
          row
        )
    );

    renderResearchTable(
      "marketResearchTable",
      row => {
        const meta =
          outcomeMetadata(
            row
          );

        return (
          meta.market_condition ||
          meta.market_condition_payload?.condition ||
          "UNKNOWN"
        );
      }
    );

    renderResearchTable(
      "crossResearchTable",
      row => {
        const meta =
          outcomeMetadata(
            row
          );

        return (
          meta.cross_market ||
          "UNKNOWN"
        );
      }
    );
  }

  function renderRawOutcomes() {
    const table =
      $("outcomesTable");

    if (!table) return;

    const rows =
      [...state.outcomes]
        .sort(
          (a, b) =>
            new Date(b.captured_at) -
            new Date(a.captured_at) ||
            Number(a.horizon_minutes) -
            Number(b.horizon_minutes)
        );

    table.querySelector(
      "tbody"
    ).innerHTML =
      rows.map(r => `
        <tr>
          <td>${localTime(r.captured_at)}</td>
          <td>${esc(r.instrument)}</td>
          <td class="${biasClass(r.model_bias)}">${esc(String(r.model_bias || "").replaceAll("_", " "))}</td>
          <td>${fmt(r.model_score, 1)}</td>
          <td>${esc(String(r.confidence || "—").replaceAll("_", " "))}</td>
          <td>${r.horizon_minutes}m</td>
          <td>${fmtSigned(r.return_points)}</td>
          <td class="positive">${fmtSigned(r.mfe_points)}</td>
          <td class="negative">${fmtSigned(r.mae_points)}</td>
          <td>${r.bias_correct === null ? "—" : r.bias_correct ? "YES" : "NO"}</td>
          <td>${r.target_symbol || "—"} ${r.target_strike ?? ""} ${r.target_side || ""}</td>
          <td>${r.target_hit === null ? "—" : r.target_hit ? "YES" : "NO"}</td>
          <td>${r.target_hit_minutes ?? "—"}</td>
        </tr>
      `).join("");
  }

  function renderOutcomeAnalytics() {
    const rows = state.outcomes;

    if (!rows.length) {
      $("outcomeNotice").classList.remove("hidden");
      $("outcomeNotice").innerHTML =
        `<strong>No mature rolling outcomes exist for this date yet.</strong><br>` +
        `The evaluator begins with the 15-minute horizon, then adds 30m, 45m and 60m as forward data becomes available. ` +
        `Futures return/MFE/MAE use the saved ES/NQ 1-minute data as the MES/MNQ point-move proxy. ` +
        `SPX/QQQ target hits are cycle-observed at the saved snapshot cadence, so a touch that reverses between snapshots can be missed.`;

      $("outcomesTable").querySelector("tbody").innerHTML = "";

      [
        "stateResearchTable",
        "marketResearchTable",
        "crossResearchTable",
        "groupedPredictionsTable",
      ].forEach(id => {
        const table = $(id);
        if (table) {
          table.querySelector("tbody").innerHTML = "";
        }
      });

      if ($("predictionCountNote")) {
        $("predictionCountNote").textContent = "No evaluated predictions yet.";
      }

      renderEmptyOutcomeCharts();
      renderAnalyticsStats();
      return;
    }

    $("outcomeNotice").classList.remove("hidden");
    $("outcomeNotice").innerHTML =
      `<strong>Rolling evaluator active.</strong> ` +
      `Score = final Setup Support (70% production model · 30% target attraction; Order Flow is already capped inside production and remains separately gated). ` +
      `State is the final V8 execution state at prediction time. Outcome horizons begin when the final Attraction Engine result is generated—not when the GEX cycle starts. ` +
      `Futures outcomes use ES/NQ 1m when available; SPX/QQQ target hits are observed from saved cycle spots.`;

    const horizons = [...new Set(
      rows.map(r => Number(r.horizon_minutes))
    )]
      .filter(Number.isFinite)
      .sort((a, b) => a - b);

    const accuracyFor = (instrument, horizon) => {
      const sample = rows.filter(r =>
        r.instrument === instrument &&
        Number(r.horizon_minutes) === horizon &&
        r.bias_correct !== null
      );

      return percent(
        sample.filter(r => r.bias_correct === true).length,
        sample.length
      );
    };

    destroyChart("accuracy");
    state.charts.accuracy = new Chart(
      $("accuracyChart").getContext("2d"),
      {
        type: "bar",
        data: {
          labels: horizons.map(h => `${h}m`),
          datasets: [
            {
              label: "MES directional accuracy %",
              data: horizons.map(h => accuracyFor("MES", h)),
              backgroundColor: "#37b95a",
            },
            {
              label: "MNQ directional accuracy %",
              data: horizons.map(h => accuracyFor("MNQ", h)),
              backgroundColor: "#2683c7",
            },
          ],
        },
        options: {
          ...chartOptions("Accuracy %"),
          scales: {
            ...chartOptions("").scales,
            y: {
              min: 0, max: 100,
              grid: { color: "rgba(61,83,103,.25)" },
              ticks: { color: "#9dafbd" },
            }
          }
        }
      }
    );

    const buckets = [
      { label: "0–39", min: 0, max: 39 },
      { label: "40–59", min: 40, max: 59 },
      { label: "60–74", min: 60, max: 74 },
      { label: "75–100", min: 75, max: 100 },
    ];

    const calibration = buckets.map(bucket => {
      const sample = rows.filter(r =>
        Number(r.model_score) >= bucket.min &&
        Number(r.model_score) <= bucket.max &&
        r.bias_correct !== null
      );

      return {
        label: `${bucket.label} (n=${sample.length})`,
        directionalAccuracy: percent(
          sample.filter(r => r.bias_correct === true).length,
          sample.length
        ),
      };
    });

    destroyChart("calibration");
    state.charts.calibration = new Chart(
      $("calibrationChart").getContext("2d"),
      {
        type: "line",
        data: {
          labels: calibration.map(x => x.label),
          datasets: [{
            label: "Observed directional accuracy %",
            data: calibration.map(x => x.directionalAccuracy),
            borderColor: "#e98a19",
            pointRadius: 5,
            tension: .15,
            spanGaps: true,
          }],
        },
        options: {
          ...chartOptions("Observed %"),
          scales: {
            ...chartOptions("").scales,
            y: {
              min: 0, max: 100,
              grid: { color: "rgba(61,83,103,.25)" },
              ticks: { color: "#9dafbd" },
            }
          }
        }
      }
    );

    renderModelResearch();
    renderGroupedPredictions();
    renderRawOutcomes();
    renderAnalyticsStats();
  }

  function renderEmptyOutcomeCharts() {
    ["accuracy", "calibration"].forEach(name => {
      destroyChart(name);
    });

    state.charts.accuracy = new Chart(
      $("accuracyChart").getContext("2d"),
      emptyChartConfig("No evaluated outcomes")
    );

    state.charts.calibration = new Chart(
      $("calibrationChart").getContext("2d"),
      emptyChartConfig("No evaluated outcomes")
    );
  }

  function emptyChartConfig(label) {
    return {
      type: "bar",
      data: { labels: [label], datasets: [{ data: [0], backgroundColor: "#29445d" }] },
      options: { ...chartOptions(""), plugins: { legend: { display: false } } },
    };
  }

  function renderAnalyticsStats() {
    const outcomes =
      state.outcomes;

    const groups =
      groupPredictionRows(
        outcomes
      );

    const accuracyAt =
      (instrument, horizon) => {
        const sample =
          outcomes.filter(row =>
            row.instrument === instrument &&
            Number(row.horizon_minutes) === horizon &&
            row.bias_correct !== null
          );

        return {
          value: percent(
            sample.filter(row =>
              row.bias_correct === true
            ).length,
            sample.length
          ),
          n: sample.length,
        };
      };

    const bestHorizon =
      instrument => {
        const options =
          [15, 30, 45, 60]
            .map(horizon => ({
              horizon,
              ...accuracyAt(
                instrument,
                horizon
              ),
            }))
            .filter(row =>
              row.value !== null
            )
            .sort((a, b) =>
              b.value - a.value ||
              b.n - a.n
            );

        return (
          options[0] ||
          {
            horizon: null,
            value: null,
            n: 0,
          }
        );
      };

    const excursionAt15 =
      instrument => {
        const sample =
          outcomes.filter(row =>
            row.instrument === instrument &&
            Number(row.horizon_minutes) === 15
          );

        const avg =
          values =>
            values.length
              ? values.reduce(
                  (a, b) => a + b,
                  0
                ) / values.length
              : null;

        return {
          mfe: avg(
            sample
              .map(row =>
                Number(
                  row.mfe_points
                )
              )
              .filter(
                Number.isFinite
              )
          ),
          mae: avg(
            sample
              .map(row =>
                Number(
                  row.mae_points
                )
              )
              .filter(
                Number.isFinite
              )
          ),
          n: sample.length,
        };
      };

    const mes15 =
      accuracyAt(
        "MES",
        15
      );

    const mnq15 =
      accuracyAt(
        "MNQ",
        15
      );

    const bestMes =
      bestHorizon(
        "MES"
      );

    const bestMnq =
      bestHorizon(
        "MNQ"
      );

    const mesExc =
      excursionAt15(
        "MES"
      );

    const mnqExc =
      excursionAt15(
        "MNQ"
      );

    // Count each prediction target once, using the farthest mature horizon.
    const targetRows =
      groups
        .map(group => {
          const rows =
            Object.values(
              group.horizons
            )
              .filter(Boolean)
              .sort(
                (a, b) =>
                  Number(
                    a.horizon_minutes
                  ) -
                  Number(
                    b.horizon_minutes
                  )
              );

          const hit =
            rows.find(row =>
              row.target_hit === true
            );

          if (hit) {
            return true;
          }

          const farthest =
            rows[
              rows.length - 1
            ];

          return (
            farthest &&
            farthest.target_hit !== null
          )
            ? farthest.target_hit
            : null;
        })
        .filter(value =>
          value !== null
        );

    const targetRate =
      percent(
        targetRows.filter(Boolean).length,
        targetRows.length
      );

    const accuracyText =
      row =>
        row.value === null
          ? "—"
          : `${fmt(row.value, 1)}%`;

    const bestText =
      row =>
        row.value === null
          ? "—"
          : `${row.horizon}m · ${fmt(row.value, 1)}%`;

    const cards = [
      [
        "MES 15m accuracy",
        accuracyText(mes15),
        `${mes15.n} predictions`,
      ],
      [
        "MNQ 15m accuracy",
        accuracyText(mnq15),
        `${mnq15.n} predictions`,
      ],
      [
        "Best MES horizon",
        bestText(bestMes),
        `${bestMes.n} evaluated predictions`,
      ],
      [
        "Best MNQ horizon",
        bestText(bestMnq),
        `${bestMnq.n} evaluated predictions`,
      ],
      [
        "MES 15m MFE / MAE",
        `${fmtSigned(mesExc.mfe)} / ${fmtSigned(mesExc.mae)}`,
        `${mesExc.n} predictions · MES points`,
      ],
      [
        "MNQ 15m MFE / MAE",
        `${fmtSigned(mnqExc.mfe)} / ${fmtSigned(mnqExc.mae)}`,
        `${mnqExc.n} predictions · MNQ points`,
      ],
      [
        "Observed target hit",
        targetRate === null
          ? "—"
          : `${fmt(targetRate, 1)}%`,
        `${targetRows.length} unique prediction targets`,
      ],
      [
        "Evaluated predictions",
        groups.length,
        `${outcomes.length} horizon rows`,
      ],
    ];

    $("analyticsStatCards").innerHTML =
      cards.map(
        ([label, value, sub]) => `
          <article class="stat-card">
            <div class="stat-label">${esc(label)}</div>
            <div class="stat-value">${esc(value)}</div>
            <div class="stat-sub">${esc(sub)}</div>
          </article>
        `
      ).join("");
  }


  async function renderAnalytics() {
    const date = $("analyticsDate").value;
    if (!date) return;

    await fetchDay(date);
    await fetchOutcomes(date);

    renderAnalyticsStats();
    renderTradeabilityChart();
    renderBiasDistribution();
    renderOutcomeAnalytics();
  }

  function currentExplorerSnapshot() {
    if (state.activeTab === "history" && state.selected) return state.selected;
    return state.latest;
  }

  function updateExplorer() {
    const snapshot = currentExplorerSnapshot();
    if (!snapshot) return;

    const symbol = $("explorerSymbol").value;
    const sort = $("explorerSort").value;
    const gex = marketData(snapshot, symbol).gex;
    let rows = [...(gex?.ranked_all || [])];

    if (sort === "strike_desc") rows.sort((a,b) => Number(b.strike)-Number(a.strike));
    if (sort === "gex_desc") rows.sort((a,b) => Math.abs(Number(b.gex_millions))-Math.abs(Number(a.gex_millions)));
    if (sort === "priority_desc") rows.sort((a,b) => priorityRank(b.priority)-priorityRank(a.priority));
    if (sort === "distance_asc") rows.sort((a,b) => Number(a.distance_abs_points)-Number(b.distance_abs_points));

    $("explorerTitle").textContent = `${symbol} Levels`;

    $("gexExplorerTable").querySelector("tbody").innerHTML = rows.map(row => `
      <tr>
        <td><strong>${esc(row.strike)}</strong></td>
        <td class="${Number(row.gex_millions) >= 0 ? "positive" : "negative"}">${fmtGex(row.gex_millions)}</td>
        <td>${esc(row.relation)}</td>
        <td>${fmt(row.distance_abs_points)}</td>
        <td>${esc(row.priority)}</td>
        <td>${esc(String(row.context || "").replaceAll("_", " "))}</td>
        <td>${esc(String(row.temporal_event || "").replaceAll("_", " "))}</td>
      </tr>
    `).join("");

    $("rawJson").textContent = JSON.stringify(snapshot, null, 2);
  }

  function downloadText(filename, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportDayJson() {
    const date = $("historyDate").value || state.latest?.trading_date || "day";
    downloadText(
      `futures-dashboard-${date}.json`,
      JSON.stringify(state.daySnapshots, null, 2),
      "application/json"
    );
  }

  function exportSnapshotJson() {
    const snap = currentExplorerSnapshot();
    if (!snap) return;
    downloadText(
      `market-snapshot-${snap.trading_date}-${localTime(snap.captured_at).replaceAll(":", "-").replaceAll(" ", "")}.json`,
      JSON.stringify(snap, null, 2),
      "application/json"
    );
  }

  function exportDayCsv() {
    const rows = state.daySnapshots.map(s => ({
      captured_at: s.captured_at,
      mes_bias: s.mes_bias,
      mes_tradeability: s.mes_tradeability,
      mnq_bias: s.mnq_bias,
      mnq_tradeability: s.mnq_tradeability,
      preferred: s.preferred_instrument,
      spx_spot: s.gex_context?.symbols?.SPX?.price,
      spx_flow: s.flowline?.symbols?.SPX?.flow_bias,
      spx_up_target: s.attraction?.assets?.SPX?.primary_up_target?.strike,
      spx_up_score: s.attraction?.assets?.SPX?.primary_up_target?.attraction_score,
      spx_down_target: s.attraction?.assets?.SPX?.primary_down_target?.strike,
      spx_down_score: s.attraction?.assets?.SPX?.primary_down_target?.attraction_score,
      qqq_spot: s.gex_context?.symbols?.QQQ?.price,
      qqq_flow: s.flowline?.symbols?.QQQ?.flow_bias,
      qqq_up_target: s.attraction?.assets?.QQQ?.primary_up_target?.strike,
      qqq_up_score: s.attraction?.assets?.QQQ?.primary_up_target?.attraction_score,
      qqq_down_target: s.attraction?.assets?.QQQ?.primary_down_target?.strike,
      qqq_down_score: s.attraction?.assets?.QQQ?.primary_down_target?.attraction_score,
    }));

    if (!rows.length) return;

    const headers = Object.keys(rows[0]);
    const quote = value => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const csv = [
      headers.join(","),
      ...rows.map(row => headers.map(h => quote(row[h])).join(","))
    ].join("\n");

    const date = $("historyDate").value || state.latest?.trading_date || "day";
    downloadText(
      `futures-dashboard-${date}.csv`,
      csv,
      "text/csv"
    );
  }

  function updateStatus() {
    if (!state.latest) {
      $("connectionStatus").textContent = "No data";
      $("liveDot").className = "status-dot stale";
      return;
    }

    const ageMin = (Date.now() - new Date(state.latest.captured_at).getTime()) / 60000;
    const isFresh = ageMin <= 10;

    $("connectionStatus").textContent = isFresh ? "Model snapshot current" : "Model snapshot stale";
    $("liveDot").className = `status-dot ${isFresh ? "online" : "stale"}`;
    $("lastUpdateText").textContent = localDateTime(state.latest.captured_at);

    const next = new Date(new Date(state.latest.captured_at).getTime() + 5 * 60000);
    $("nextUpdateText").textContent = localTime(next);
  }

  async function refreshAll({ preserveHistory = false } = {}) {
    try {
      await fetchLatest();
      await fetchLiveMarket();
      await fetchEntrySignals();

      if (!state.latest) {
        updateStatus();
        return;
      }

      await fetchDay(state.latest.trading_date);

      if (!preserveHistory) {
        $("historyDate").value = state.latest.trading_date;
        $("analyticsDate").value = state.latest.trading_date;
      }

      renderLive();
      updateLiveMarketDom();
      updateLiveFeedStatus();
      updateStatus();

      if (state.activeTab === "history" && preserveHistory) {
        await loadHistoryDate();
      }

      if (state.activeTab === "analytics") {
        await renderAnalytics();
      }

    } catch (error) {
      console.error(error);
      $("connectionStatus").textContent = "Connection error";
      $("liveDot").className = "status-dot stale";
      toast(`Refresh failed: ${error.message}`);
    }
  }

  function subscribeRealtime() {
    if (state.realtimeChannel) {
      client.removeChannel(state.realtimeChannel);
    }

    state.realtimeChannel = client
      .channel("market-snapshot-live")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "market_snapshots",
        },
        async () => {
          toast("New market snapshot received");
          await refreshAll({ preserveHistory: state.activeTab === "history" });
        }
      )
      .subscribe();
  }

  async function startDashboard() {
    await fetchAvailableDates();
    await fetchLiveMarket();
    await refreshAll();
    subscribeRealtime();
    subscribeLiveMarket();
    subscribeEntrySignals();

    clearInterval(state.refreshTimer);
    state.refreshTimer = setInterval(
      () => refreshAll({ preserveHistory: state.activeTab === "history" }),
      Math.max(30, Number(cfg.pollSeconds || 60)) * 1000
    );
  }

  function switchTab(tabName) {
    state.activeTab = tabName;

    $$(".tab").forEach(button => {
      button.classList.toggle("active", button.dataset.tab === tabName);
    });

    $$(".tab-panel").forEach(panel => {
      panel.classList.toggle("active", panel.id === `tab-${tabName}`);
    });

    if (tabName === "history") {
      loadHistoryDate();
    }

    if (tabName === "model") {
      // These Chart.js canvases live in a hidden tab on first load.
      // Re-render after the tab becomes visible so sizing is correct.
      window.setTimeout(() => {
        if (state.latest) {
          renderMarketCards(state.latest, "marketCards");
          renderTechnicalCards(state.latest, "technicalCards");
        }
        renderFlowHistory();
        renderAttractionHistory();
        notifyOrderflowState("model-tab-visible");
      }, 0);
    }

    if (tabName === "analytics") {
      renderAnalytics();
    }

    if (tabName === "explorer") {
      updateExplorer();
    }
  }

  // ----------------------------------------------------------
  // EVENTS
  // ----------------------------------------------------------

  $("loginForm").addEventListener("submit", async event => {
    event.preventDefault();
    $("loginError").textContent = "";
    $("loginButton").disabled = true;
    $("loginButton").textContent = "Signing in…";

    try {
      await signIn(
        $("emailInput").value.trim(),
        $("passwordInput").value
      );
      await startDashboard();
    } catch (error) {
      $("loginError").textContent = error.message;
    } finally {
      $("loginButton").disabled = false;
      $("loginButton").textContent = "Sign in";
    }
  });

  $("signOutButton").addEventListener("click", async () => {
    await client.auth.signOut();
    location.reload();
  });

  $("refreshButton").addEventListener("click", async () => {
    await refreshAll({ preserveHistory: state.activeTab === "history" });
    toast("Dashboard refreshed");
  });

  $$(".tab").forEach(button => {
    button.addEventListener("click", () => switchTab(button.dataset.tab));
  });

  $$(".seg[data-market-filter]").forEach(button => {
    button.addEventListener("click", () => {
      state.marketFilter = button.dataset.marketFilter;
      $$(".seg[data-market-filter]").forEach(x =>
        x.classList.toggle("active", x === button)
      );
      $$("#marketCards .market-card").forEach(card => {
        card.classList.toggle(
          "hidden-filter",
          state.marketFilter !== "all" &&
          card.dataset.symbol !== state.marketFilter
        );
      });
    });
  });

  $("activeTradeForm")?.addEventListener(
    "submit",
    startActiveTradeFromForm
  );

  $("activeTradeInstrument")?.addEventListener(
    "change",
    updateActiveTradeCurrentHint
  );

  $("activeTradeUseCurrent")?.addEventListener(
    "click",
    () => {
      if (!state.latest) return;

      const instrument =
        $("activeTradeInstrument")?.value ||
        "MES";

      const current =
        activeTradeFuturesPrice(
          state.latest,
          instrument
        );

      if (
        Number.isFinite(current.price)
      ) {
        $("activeTradeEntry").value =
          Number(current.price).toFixed(2);
      }
    }
  );

  $("zeroDteSymbolSelect")?.addEventListener("change", renderZeroDtePressureHistory);
  $("flowSymbolSelect").addEventListener("change", renderFlowHistory);
  $("attractionSymbolSelect").addEventListener("change", renderAttractionHistory);

  $("historyDate").addEventListener("change", loadHistoryDate);
  $("historyTimeSelect").addEventListener("change", renderHistorySelected);
  $("loadHistoryButton").addEventListener("click", loadHistoryDate);

  $("analyticsDate").addEventListener("change", renderAnalytics);

  $("analyticsResearchHorizon")?.addEventListener(
    "change",
    renderModelResearch
  );

  [
    "predictionInstrumentFilter",
    "predictionBiasFilter",
    "predictionStateFilter",
  ].forEach(id => {
    $(id)?.addEventListener(
      "change",
      renderGroupedPredictions
    );
  });

  $("explorerSymbol").addEventListener("change", updateExplorer);
  $("explorerSort").addEventListener("change", updateExplorer);

  $("exportDayCsvButton").addEventListener("click", exportDayCsv);
  $("exportDayJsonButton").addEventListener("click", exportDayJson);
  $("exportSnapshotJsonButton").addEventListener("click", exportSnapshotJson);

  $$("[data-close-modal]").forEach(node => {
    node.addEventListener("click", () => $("detailModal").classList.add("hidden"));
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape") $("detailModal").classList.add("hidden");
  });

  initAuth();
})();
