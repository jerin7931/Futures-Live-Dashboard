(() => {
  "use strict";

  const state = window.FM_ORDERFLOW_STATE;
  const client = window.FM_ORDERFLOW_CLIENT;

  if (!state || !client) {
    console.warn("V25 charts: dashboard state/client unavailable.");
    return;
  }

  const LW = window.LightweightCharts;
  const charts = {};
  const history = { MES: [], MNQ: [] };
  const live1mHistory = { MES: [], MNQ: [] };
  const overlayData = {
    entry10m: { MES: [], MNQ: [] },
    shadow: { MES: [], MNQ: [] },
    blockers: { MES: [], MNQ: [] },
    trades: { MES: [], MNQ: [] },
  };

  const LIVE_1M_STALE_SECONDS = 180;
  const viewTf = { MES: "5m", MNQ: "5m" };
  const layerState = {
    MES: { model: true, entry: false, structure: true, gex: true, zones: true },
    MNQ: { model: true, entry: false, structure: true, gex: true, zones: true },
  };

  let initialized = false;
  let loadingBars = false;
  let loadingOverlays = false;
  let overlayPoll = null;
  let selectedChartSymbol = "MES"; // V26_1_CHART_CLARITY

  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

  function fmt(value, digits = 2) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toFixed(digits) : "—";
  }

  function normalizeJson(value, fallback = {}) {
    if (value && typeof value === "object") return value;
    if (typeof value !== "string") return fallback;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : fallback;
    } catch (_error) {
      return fallback;
    }
  }

  function chartColors() {
    return {
      bg: "#08131f",
      text: "#b8c7d6",
      grid: "rgba(107, 135, 160, .105)",
      up: "#2dd4bf",
      down: "#fb7185",
      supplyFill: "rgba(244, 114, 182, .075)",
      supplyBorder: "rgba(244, 114, 182, .52)",
      demandFill: "rgba(45, 212, 191, .075)",
      demandBorder: "rgba(45, 212, 191, .52)",
      modelLong: "#38bdf8",
      modelShort: "#f59e0b",
      structureLong: "#22c55e",
      structureShort: "#ef4444",
      entryLong: "#a3e635",
      entryShort: "#f472b6",
      trade: "#facc15",
      exit: "#e2e8f0",
    };
  }

  function injectV25Styles() {
    if ($("v25ChartStyles")) return;
    const style = document.createElement("style");
    style.id = "v25ChartStyles";
    style.textContent = `
      .structure-chart-grid{grid-template-columns:1fr!important;gap:1.25rem!important}
      .structure-chart-panel{min-width:0;overflow:hidden}
      .structure-chart-host{min-height:600px!important;height:clamp(560px,50vw,720px)!important}
      .structure-chart-panel-head{gap:1rem;align-items:flex-start}
      .structure-chart-controls{display:flex;align-items:center;gap:.35rem;flex-wrap:wrap;justify-content:flex-end}
      .v25-layer-row{display:flex;gap:.3rem;flex-wrap:wrap;justify-content:flex-end;margin-top:.45rem}
      .v25-layer-btn{border:1px solid rgba(80,112,140,.55);background:rgba(255,255,255,.025);color:#8fa7ba;border-radius:7px;padding:.3rem .48rem;font-size:.63rem;font-weight:800;letter-spacing:.03em}
      .v25-layer-btn.active{background:#16324a;color:#f8fbff;border-color:#3c759d}
      .structure-chart-foot{flex-wrap:wrap;gap:.65rem}
      .v25-legend-dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px;vertical-align:0}
      .v25-legend-dot.model{background:#35a9d9}.v25-legend-dot.entry{background:#37b95a}.v25-legend-dot.structure{background:#54c6a5}.v25-legend-dot.trade{background:#f2c94c}
      @media(max-width:720px){.structure-chart-host{min-height:390px!important;height:430px!important}.structure-chart-panel-head{flex-direction:column}.structure-chart-controls,.v25-layer-row{justify-content:flex-start}}
    `;
    document.head.appendChild(style);

    const grid = document.querySelector(".structure-chart-grid");
    if (grid) grid.style.gridTemplateColumns = "1fr";
  }

  function zoneStatusClass(status) {
    const s = String(status || "").toUpperCase();
    if (s === "FRESH") return "fresh";
    if (s === "TESTED") return "tested";
    if (s === "WEAKENING") return "weakening";
    return "neutral";
  }

  function currentSupplyDemand(symbol) {
    return state.latest?.supply_demand?.instruments?.[symbol] || null;
  }

  function zoneCard(symbol, label, zone, type) {
    if (!zone) {
      return `
        <div class="sd-zone-box ${type.toLowerCase()} empty">
          <div class="sd-zone-label">${label}</div>
          <strong>No material zone ≥ 55</strong>
          <small>Shadow detector found no actionable ${type.toLowerCase()} nearby.</small>
        </div>`;
    }
    const gex = Array.isArray(zone.gex_confluence) && zone.gex_confluence.length
      ? `${zone.gex_confluence[0].underlying} ${zone.gex_confluence[0].strike} ${zone.gex_confluence[0].sign === "negative" ? "−GEX" : "+GEX"}`
      : "None";
    return `
      <div class="sd-zone-box ${type.toLowerCase()}">
        <div class="sd-zone-box-top">
          <div><div class="sd-zone-label">${label}</div><strong>${fmt(zone.low)} – ${fmt(zone.high)}</strong></div>
          <span class="sd-score">${fmt(zone.materiality_score, 0)}</span>
        </div>
        <div class="sd-zone-meta">
          <span>${esc(zone.materiality || "—")}</span>
          <span>${esc((zone.confluence_timeframes || [zone.timeframe]).join(" + ").toUpperCase())}</span>
          <span class="${zoneStatusClass(zone.status)}">${esc(zone.status || "—")}</span>
        </div>
        <div class="sd-zone-detail">
          <span>${fmt(zone.distance_points)} pts away</span>
          <span>${Number(zone.touch_count || 0)} touch${Number(zone.touch_count || 0) === 1 ? "" : "es"}</span>
          <span>OF ${esc(String(zone.orderflow_origin || "NO_DATA").replaceAll("_", " "))}</span>
          <span>GEX ${esc(gex)}</span>
        </div>
      </div>`;
  }

  function renderSupplyDemandCards() {
    const container = $("supplyDemandCards");
    if (!container) return;
    const payload = state.latest?.supply_demand || null;
    if (!payload) {
      container.innerHTML = `<article class="sd-instrument-card no-data"><div class="sd-instrument-title"><strong>Supply / Demand</strong><span>SHADOW</span></div><p>Waiting for the first V22 supply/demand snapshot. Existing production decisions are unchanged.</p></article>`;
      return;
    }
    container.innerHTML = ["MES", "MNQ"].map(symbol => {
      const row = payload.instruments?.[symbol] || {};
      return `<article class="sd-instrument-card">
        <div class="sd-instrument-title"><div><strong>${symbol}</strong><small>Material zones · 15m/1h discovery · 5m refinement</small></div><span>SHADOW · 0% MODEL WEIGHT</span></div>
        <div class="sd-zone-pair">${zoneCard(symbol, "NEAREST SUPPLY", row.nearest_supply, "SUPPLY")}${zoneCard(symbol, "NEAREST DEMAND", row.nearest_demand, "DEMAND")}</div>
      </article>`;
    }).join("");
  }

  function normalizeBar(row) {
    const p = row?.payload || {};
    const time = Math.floor(Number(row.bar_open_ms) / 1000);
    const open = Number(p.open), high = Number(p.high), low = Number(p.low), close = Number(p.close);
    if (![time, open, high, low, close].every(Number.isFinite)) return null;
    return { time, open, high, low, close, barCloseMs: Number(row.bar_close_ms), receivedAt: row.received_at || null };
  }

  function aggregateBars(bars, seconds, minCount = 1) {
    const groups = new Map();
    for (const bar of bars) {
      const bucket = Math.floor(bar.time / seconds) * seconds;
      if (!groups.has(bucket)) {
        groups.set(bucket, { time: bucket, open: bar.open, high: bar.high, low: bar.low, close: bar.close, count: 1 });
      } else {
        const g = groups.get(bucket);
        g.high = Math.max(g.high, bar.high);
        g.low = Math.min(g.low, bar.low);
        g.close = bar.close;
        g.count += 1;
      }
    }
    return [...groups.values()].filter(g => g.count >= minCount).map(({ count, ...bar }) => bar).sort((a, b) => a.time - b.time);
  }

  function aggregate10m(bars) {
    return aggregateBars(bars, 600, 2);
  }

  function latestLive1m(symbol) {
    const rows = live1mHistory[symbol] || [];
    return rows.length ? rows[rows.length - 1] : null;
  }

  function live1mAgeSeconds(symbol) {
    const row = latestLive1m(symbol);
    if (!row) return null;
    const closeMs = Number(row.barCloseMs);
    if (Number.isFinite(closeMs) && closeMs > 0) return Math.max(0, (Date.now() - closeMs) / 1000);
    if (row.receivedAt) {
      const received = Date.parse(row.receivedAt);
      if (Number.isFinite(received)) return Math.max(0, (Date.now() - received) / 1000);
    }
    return null;
  }

  function isLive1mFresh(symbol) {
    const age = live1mAgeSeconds(symbol);
    return age !== null && age <= LIVE_1M_STALE_SECONDS;
  }

  function currentLiveDisplayBar(symbol) {
    const rows = live1mHistory[symbol] || [];
    if (!rows.length) return null;
    const seconds = viewTf[symbol] === "10m" ? 600 : 300;
    const grouped = aggregateBars(rows, seconds, 1);
    return grouped.length ? grouped[grouped.length - 1] : null;
  }

  function displayedBars(symbol) {
    const base = viewTf[symbol] === "10m" ? aggregate10m(history[symbol]) : [...history[symbol]];
    const liveBar = currentLiveDisplayBar(symbol);
    if (!liveBar) return base;
    const out = [...base];
    const idx = out.findIndex(bar => bar.time === liveBar.time);
    if (idx >= 0) out[idx] = liveBar;
    else if (!out.length || liveBar.time > out[out.length - 1].time) out.push(liveBar);
    return out.sort((a, b) => a.time - b.time);
  }

  async function fetchChartBars() {
    if (loadingBars) return;
    loadingBars = true;
    try {
      const symbols = ["MES", "MNQ"];
      const queries = [];
      symbols.forEach(symbol => {
        queries.push(client.from("tv_market_bars").select("data_type,symbol,timeframe,bar_open_ms,bar_close_ms,payload,received_at").eq("data_type", "ohlcv").eq("symbol", symbol).eq("timeframe", "5m").order("bar_open_ms", { ascending: false }).limit(420));
        queries.push(client.from("tv_market_bars").select("data_type,symbol,timeframe,bar_open_ms,bar_close_ms,payload,received_at").eq("data_type", "ohlcv").eq("symbol", symbol).eq("timeframe", "1m").order("bar_open_ms", { ascending: false }).limit(40));
      });
      const results = await Promise.all(queries);
      symbols.forEach((symbol, idx) => {
        const result5m = results[idx * 2];
        const result1m = results[idx * 2 + 1];
        if (result5m.error) throw result5m.error;
        if (result1m.error) throw result1m.error;
        history[symbol] = (result5m.data || []).map(normalizeBar).filter(Boolean).sort((a, b) => a.time - b.time);
        live1mHistory[symbol] = (result1m.data || []).map(normalizeBar).filter(Boolean).sort((a, b) => a.time - b.time);
      });
      renderAllStructureCharts(true);
    } catch (error) {
      console.warn("V25 chart history query failed:", error);
    } finally {
      loadingBars = false;
    }
  }

  async function safeQuery(promise, label) {
    try {
      const result = await promise;
      if (result?.error) {
        console.warn(`V25 ${label}:`, result.error.message || result.error);
        return [];
      }
      return result?.data || [];
    } catch (error) {
      console.warn(`V25 ${label}:`, error);
      return [];
    }
  }

  async function fetchOverlayData() {
    if (loadingOverlays) return;
    loadingOverlays = true;
    try {
      const [entryRows, shadowRows, blockerRows, tradeRows] = await Promise.all([
        safeQuery(client.from("tv_entry_signals").select("symbol,timeframe,bar_open_ms,bar_close_ms,signal,direction,family,strong_tier,quality_score,close,payload,received_at").in("symbol", ["MES", "MNQ"]).order("bar_open_ms", { ascending: false }).limit(500), "tv_entry_signals"),
        safeQuery(client.from("shadow_signal_events").select("symbol,engine,timeframe,bar_open_ms,bar_close_ms,event_type,direction,price,quality_score,metadata,received_at").in("symbol", ["MES", "MNQ"]).order("bar_open_ms", { ascending: false }).limit(1200), "shadow_signal_events (run V25 SQL if not installed yet)"),
        safeQuery(client.from("model_blocker_events").select("snapshot_id,captured_at,instrument,model_bias,final_state,underlying_blocker,setup_support,scenario_spread,tech_score,orderflow_quality,target_symbol,target_strike,gate_trace").in("instrument", ["MES", "MNQ"]).order("captured_at", { ascending: false }).limit(600), "model_blocker_events"),
        safeQuery(client.from("trades").select("id,instrument,direction,status,opened_at,closed_at,avg_entry_price,avg_exit_price,initial_entry_price,realized_pnl_dollars").in("instrument", ["MES", "MNQ"]).order("opened_at", { ascending: false }).limit(100), "trades"),
      ]);

      ["MES", "MNQ"].forEach(symbol => {
        overlayData.entry10m[symbol] = entryRows.filter(row => String(row.symbol).toUpperCase() === symbol);
        overlayData.shadow[symbol] = shadowRows.filter(row => String(row.symbol).toUpperCase() === symbol);
        overlayData.blockers[symbol] = blockerRows.filter(row => String(row.instrument).toUpperCase() === symbol).sort((a, b) => Date.parse(a.captured_at) - Date.parse(b.captured_at));
        overlayData.trades[symbol] = tradeRows.filter(row => String(row.instrument).toUpperCase() === symbol);
      });
      renderAllStructureCharts(false);
    } finally {
      loadingOverlays = false;
    }
  }

  function modelFuturesPrice(symbol) {
    const row = state.latest?.technicals?.symbols?.[symbol] || null;
    const value = Number(row?.price ?? row?.timeframes?.["5m"]?.price);
    return Number.isFinite(value) ? value : null;
  }

  function liveUnderlyingRow(underlying) {
    const row = state.liveBars?.[underlying] || null;
    if (!row || row.data_type !== "ohlcv" || row.timeframe !== "1m" || String(row.symbol || "").toUpperCase() !== underlying) return null;
    return row;
  }

  function rawRowAgeSeconds(row) {
    if (!row) return null;
    const closeMs = Number(row.bar_close_ms);
    if (Number.isFinite(closeMs) && closeMs > 0) return Math.max(0, (Date.now() - closeMs) / 1000);
    const receivedMs = Date.parse(row.received_at || "");
    return Number.isFinite(receivedMs) ? Math.max(0, (Date.now() - receivedMs) / 1000) : null;
  }

  function liveGexMappingPair(symbol) {
    const underlying = symbol === "MES" ? "SPX" : "QQQ";
    const futRow = latestLive1m(symbol);
    const underRow = liveUnderlyingRow(underlying);
    const futPrice = Number(futRow?.close);
    const underPrice = Number(underRow?.payload?.close);
    if (!Number.isFinite(futPrice) || !Number.isFinite(underPrice) || underPrice === 0 || !isLive1mFresh(symbol)) return null;
    const underAge = rawRowAgeSeconds(underRow);
    if (underAge === null || underAge > LIVE_1M_STALE_SECONDS) return null;
    const futOpenMs = Number(futRow.time) * 1000;
    const underOpenMs = Number(underRow.bar_open_ms);
    if (!Number.isFinite(futOpenMs) || !Number.isFinite(underOpenMs) || Math.abs(futOpenMs - underOpenMs) > 5000) return null;
    return { underlying, futuresPrice: futPrice, underlyingPrice: underPrice, mode: "LIVE_1M", barOpenMs: futOpenMs };
  }

  function snapshotGexMappingPair(symbol) {
    const underlying = symbol === "MES" ? "SPX" : "QQQ";
    const block = state.latest?.gex_context?.symbols?.[underlying] || null;
    const futuresPrice = modelFuturesPrice(symbol);
    const underlyingPrice = Number(block?.price);
    if (!block || !Number.isFinite(futuresPrice) || !Number.isFinite(underlyingPrice) || underlyingPrice === 0) return null;
    return { underlying, futuresPrice, underlyingPrice, mode: "SNAPSHOT", barOpenMs: null };
  }

  function gexMappingPair(symbol) {
    return liveGexMappingPair(symbol) || snapshotGexMappingPair(symbol);
  }

  function mapUnderlyingStrikeToFutures(symbol, strike, pair = null) {
    const level = Number(strike);
    const ctx = pair || gexMappingPair(symbol);
    if (!ctx || !Number.isFinite(level)) return null;
    if (symbol === "MES") return ctx.futuresPrice + (level - ctx.underlyingPrice);
    const beta = ctx.futuresPrice / ctx.underlyingPrice;
    if (!Number.isFinite(beta) || beta === 0) return null;
    return ctx.futuresPrice + (level - ctx.underlyingPrice) * beta;
  }

  function relevantGex(symbol) {
    const underlying = symbol === "MES" ? "SPX" : "QQQ";
    const block = state.latest?.gex_context?.symbols?.[underlying] || null;
    const pair = gexMappingPair(symbol);
    if (!block || !pair) return [];
    const primaryAsset = state.latest?.attraction?.assets?.[underlying] || {};
    const primaryStrikes = new Set([Number(primaryAsset?.primary_up_target?.strike), Number(primaryAsset?.primary_down_target?.strike)].filter(Number.isFinite));
    const rows = (block.ranked_all || [])
      .filter(row => row?.material !== false)
      .map(row => ({ ...row, strikeNum: Number(row.strike), priorityNum: Number(row.priority_score || 0) }))
      .filter(row => Number.isFinite(row.strikeNum) && (row.priorityNum >= 65 || primaryStrikes.has(row.strikeNum)))
      .map(row => ({ ...row, mappedPrice: mapUnderlyingStrikeToFutures(symbol, row.strikeNum, pair), isPrimary: primaryStrikes.has(row.strikeNum) }))
      .filter(row => Number.isFinite(row.mappedPrice))
      .sort((a, b) => a.isPrimary !== b.isPrimary ? (a.isPrimary ? -1 : 1) : b.priorityNum - a.priorityNum);
    const unique = [];
    for (const row of rows) {
      if (unique.some(x => Math.abs(x.mappedPrice - row.mappedPrice) < 0.35)) continue;
      unique.push(row);
      if (unique.length >= 5) break;
    }
    return unique.map(row => ({ underlying, strike: row.strikeNum, price: row.mappedPrice, sign: row.sign, priority: row.priority, isPrimary: row.isPrimary, mappingMode: pair.mode }));
  }

  function currentTargetMapped(symbol) {
    const trade = state.activeTrade;
    if (!trade || trade.active !== true || trade.instrument !== symbol) return null;
    const underlying = symbol === "MES" ? "SPX" : "QQQ";
    const asset = state.latest?.attraction?.assets?.[underlying] || null;
    const pair = gexMappingPair(symbol);
    if (!asset || !pair) return null;
    const target = trade.direction === "LONG" ? asset.primary_up_target : asset.primary_down_target;
    const strike = Number(target?.strike);
    if (!Number.isFinite(strike)) return null;
    const price = mapUnderlyingStrikeToFutures(symbol, strike, pair);
    return Number.isFinite(price) ? { price, strike, underlying, mappingMode: pair.mode } : null;
  }

  function clearPriceLines(ctx) {
    if (!ctx?.candles || !Array.isArray(ctx.priceLines)) return;
    ctx.priceLines.forEach(line => { try { ctx.candles.removePriceLine(line); } catch (_e) {} });
    ctx.priceLines = [];
  }

  function applyStructureLines(symbol) {
    const ctx = charts[symbol];
    if (!ctx) return;
    clearPriceLines(ctx);
    const layers = layerState[symbol];
    if (layers.gex) {
      relevantGex(symbol).forEach(row => {
        ctx.priceLines.push(ctx.candles.createPriceLine({
          price: row.price,
          color: row.sign === "negative" ? "#d85d57" : "#4aa7c7",
          lineWidth: row.isPrimary ? 2 : 1,
          lineStyle: row.isPrimary ? LW.LineStyle.Dashed : LW.LineStyle.Dotted,
          axisLabelVisible: true,
          title: `${row.underlying} ${row.strike} ${row.sign === "negative" ? "−GEX" : "+GEX"}${row.isPrimary ? " ★" : ""}`,
        }));
      });
    }

    // V25 intentionally removes the redundant LIVE 1M horizontal price line.
    // Completed 1m bars still update the visible candle and GEX mapping underneath.

    {
      const trade = state.activeTrade;
      if (trade?.active === true && trade.instrument === symbol) {
        const entry = Number(trade.avgEntry ?? trade.entry);
        const stop = Number(trade.currentStop ?? trade.initialStop);
        if (Number.isFinite(entry)) ctx.priceLines.push(ctx.candles.createPriceLine({ price: entry, color: "#f2c94c", lineWidth: 2, lineStyle: LW.LineStyle.Solid, axisLabelVisible: true, title: `TRADE ENTRY ${trade.direction}` }));
        if (Number.isFinite(stop)) ctx.priceLines.push(ctx.candles.createPriceLine({ price: stop, color: "#ff6b6b", lineWidth: 2, lineStyle: LW.LineStyle.Dashed, axisLabelVisible: true, title: "ACTIVE STOP" }));
        const target = currentTargetMapped(symbol);
        if (target) ctx.priceLines.push(ctx.candles.createPriceLine({ price: target.price, color: "#63d297", lineWidth: 2, lineStyle: LW.LineStyle.Dashed, axisLabelVisible: true, title: `${target.underlying} ${target.strike} TARGET` }));
      }
    }
  }

  function alignEventTime(row, tf, preferClose = true) {
    const seconds = tf === "10m" ? 600 : 300;
    const closeMs = Number(row?.bar_close_ms);
    const openMs = Number(row?.bar_open_ms);
    const baseMs = preferClose && Number.isFinite(closeMs) ? closeMs - 1 : openMs;
    if (!Number.isFinite(baseMs)) return null;
    return Math.floor(baseMs / 1000 / seconds) * seconds;
  }

  function alignIsoTime(value, tf) {
    const ms = Date.parse(value || "");
    if (!Number.isFinite(ms)) return null;
    const seconds = tf === "10m" ? 600 : 300;
    return Math.floor(ms / 1000 / seconds) * seconds;
  }

  function signalMarker(row, tf, source) {
    const colors = chartColors();
    const dir = String(row.direction || "").toUpperCase();
    const isLong = dir === "LONG";
    const time = alignEventTime(row, tf, true);
    if (!Number.isFinite(time)) return null;

    const raw = String(row.signal || row.event_type || "").toUpperCase();
    const timeframe = source === "TV10" ? "10m" : "5m";
    const continuation = raw.includes("C");
    const strong = raw.includes("+");
    const family = continuation ? "CONTINUATION" : "EMA / CCI";
    const text = `${timeframe} ${family} ${dir}${strong ? " · STRONG" : ""}`;

    return {
      time,
      position: isLong ? "belowBar" : "aboveBar",
      color: isLong ? colors.entryLong : colors.entryShort,
      shape: isLong ? "arrowUp" : "arrowDown",
      text,
      size: 1,
    };
  }

  function structureMarker(row, tf) {
    const colors = chartColors();
    const dir = String(row.direction || "").toUpperCase();
    const isLong = dir === "LONG";
    const time = alignEventTime(row, tf, true);
    if (!Number.isFinite(time)) return null;

    const rawEvent = String(row.event_type || "STRUCTURE").toUpperCase();
    const eventName = rawEvent === "CHOCH" ? "CHoCH" : "BOS";
    const timeframe = String(row.timeframe) === "10m" ? "10m" : "5m";

    return {
      time,
      position: isLong ? "belowBar" : "aboveBar",
      color: isLong ? colors.structureLong : colors.structureShort,
      shape: isLong ? "arrowUp" : "arrowDown",
      text: `${timeframe} ${eventName} ${dir}`,
      size: String(row.timeframe) === "10m" ? 1.05 : 0.9,
    };
  }

  function isReadyBlocker(value) {
    return String(value || "").toUpperCase().startsWith("WAIT_10M_");
  }

  function buildModelMarkers(symbol, tf) {
    const colors = chartColors();
    const rows = overlayData.blockers[symbol] || [];
    const markers = [];
    let lastThesis = null;
    let lastReady = null;

    for (const row of rows) {
      const trace = normalizeJson(row.gate_trace, {});
      const bias = String(row.model_bias || trace.bias || "").toUpperCase();
      if (!["LONG", "SHORT"].includes(bias)) continue;
      const candidate = Boolean(trace.candidate_60_10 && trace.production_model?.aligned);
      const ready = isReadyBlocker(row.underlying_blocker);
      const time = alignIsoTime(row.captured_at, tf);
      if (!Number.isFinite(time)) continue;
      const isLong = bias === "LONG";

      if (candidate && lastThesis !== bias) {
        markers.push({
          time,
          position: isLong ? "belowBar" : "aboveBar",
          color: isLong ? colors.modelLong : colors.modelShort,
          shape: "square",
          text: `MODEL ${isLong ? "LONG" : "SHORT"}`,
          size: 0.8,
        });
        lastThesis = bias;
      }
      if (!candidate) lastThesis = null;

      if (ready && lastReady !== bias) {
        markers.push({
          time,
          position: isLong ? "belowBar" : "aboveBar",
          color: isLong ? colors.modelLong : colors.modelShort,
          shape: "circle",
          text: `GATES READY ${isLong ? "LONG" : "SHORT"}`,
          size: 1,
        });
        lastReady = bias;
      }
      if (!ready) lastReady = null;
    }
    return markers;
  }

  function buildTradeMarkers(symbol, tf) {
    const colors = chartColors();
    const markers = [];
    for (const row of overlayData.trades[symbol] || []) {
      const dir = String(row.direction || "").toUpperCase();
      const isLong = dir === "LONG";
      const openTime = alignIsoTime(row.opened_at, tf);
      if (Number.isFinite(openTime)) {
        markers.push({ time: openTime, position: isLong ? "belowBar" : "aboveBar", color: colors.trade, shape: isLong ? "arrowUp" : "arrowDown", text: isLong ? "BUY" : "SELL", size: 1.2 });
      }
      const closeTime = alignIsoTime(row.closed_at, tf);
      if (Number.isFinite(closeTime)) {
        const pnl = Number(row.realized_pnl_dollars);
        const suffix = Number.isFinite(pnl) ? ` ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(0)}` : "";
        markers.push({ time: closeTime, position: isLong ? "aboveBar" : "belowBar", color: colors.exit, shape: "circle", text: `EXIT${suffix}`, size: 0.9 });
      }
    }
    return markers;
  }

  function buildMarkers(symbol) {
    const tf = viewTf[symbol];
    const layers = layerState[symbol];
    const markers = [];

    if (layers.model) markers.push(...buildModelMarkers(symbol, tf));

    if (layers.entry) {
      for (const row of overlayData.entry10m[symbol] || []) {
        const marker = signalMarker(row, tf, "TV10");
        if (marker) markers.push(marker);
      }
      for (const row of overlayData.shadow[symbol] || []) {
        if (String(row.engine || "").toUpperCase().startsWith("EMA_CCI") && String(row.timeframe) === "5m") {
          const marker = signalMarker(row, tf, "EMA5");
          if (marker) markers.push(marker);
        }
      }
    }

    if (layers.structure) {
      for (const row of overlayData.shadow[symbol] || []) {
        if (!String(row.engine || "").toUpperCase().startsWith("STRUCTURE")) continue;
        if (!["5m", "10m"].includes(String(row.timeframe))) continue;
        const marker = structureMarker(row, tf);
        if (marker) markers.push(marker);
      }
    }


    const bars = displayedBars(symbol);
    if (!bars.length) return [];
    const minTime = bars[0].time;
    const maxTime = bars[bars.length - 1].time;
    const dedupe = new Map();
    markers
      .filter(marker => marker.time >= minTime && marker.time <= maxTime)
      .sort((a, b) => a.time - b.time)
      .forEach((marker, idx) => {
        let time = marker.time;
        const keyBase = `${time}|${marker.position}|${marker.text}`;
        if (!dedupe.has(keyBase)) dedupe.set(keyBase, marker);
        else dedupe.set(`${keyBase}|${idx}`, marker);
      });
    const sorted = [...dedupe.values()].sort((a, b) => a.time - b.time);
    const labelStart = Math.max(0, sorted.length - 18);
    return sorted.map((marker, index) => (
      index < labelStart
        ? { ...marker, text: "" }
        : marker
    ));
  }

  function applyMarkers(symbol) {
    const ctx = charts[symbol];
    if (!ctx?.markers) return;
    ctx.markers.setMarkers(buildMarkers(symbol));
  }

  function redrawZoneOverlay(symbol) {
    const ctx = charts[symbol];
    if (!ctx?.overlay || !ctx?.candles) return;
    const canvas = ctx.overlay;
    const host = ctx.host;
    const dpr = window.devicePixelRatio || 1;
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (width <= 0 || height <= 0) return;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    const c = canvas.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, width, height);
    if (!layerState[symbol].zones) return;
    const colors = chartColors();
    const rightScaleWidth = ctx.chart.priceScale("right").width();
    const plotWidth = Math.max(40, width - rightScaleWidth);
    const row = currentSupplyDemand(symbol);
    const zones = [...(row?.demand_zones || []).slice(0, 2), ...(row?.supply_zones || []).slice(0, 2)];
    zones.forEach(zone => {
      const y1 = ctx.candles.priceToCoordinate(Number(zone.high));
      const y2 = ctx.candles.priceToCoordinate(Number(zone.low));
      if (!Number.isFinite(y1) || !Number.isFinite(y2)) return;
      const top = Math.min(y1, y2);
      const bottom = Math.max(y1, y2);
      const fill = zone.type === "DEMAND" ? colors.demandFill : colors.supplyFill;
      const border = zone.type === "DEMAND" ? colors.demandBorder : colors.supplyBorder;
      c.fillStyle = fill;
      c.fillRect(0, top, plotWidth, Math.max(2, bottom - top));
      c.strokeStyle = border;
      c.lineWidth = 1;
      c.strokeRect(0.5, top + 0.5, plotWidth - 1, Math.max(1, bottom - top - 1));
      const label = `${zone.type} ${fmt(zone.low)}–${fmt(zone.high)} · ${fmt(zone.materiality_score, 0)} ${String(zone.timeframe || "").toUpperCase()} ${zone.status || ""}`;
      c.font = "11px system-ui, -apple-system, Segoe UI, sans-serif";
      const tw = c.measureText(label).width + 12;
      const ly = Math.max(14, Math.min(height - 6, top + 15));
      c.fillStyle = "rgba(5, 13, 21, .82)";
      c.fillRect(6, ly - 12, tw, 16);
      c.fillStyle = border;
      c.fillText(label, 12, ly);
    });
  }

  function scheduleOverlayLoop(symbol) {
    const ctx = charts[symbol];
    if (!ctx || ctx.overlayTimer) return;
    ctx.overlayTimer = window.setInterval(() => redrawZoneOverlay(symbol), 450);
  }

  function initChart(symbol) {
    const host = $(`${symbol.toLowerCase()}StructureChart`);
    if (!host || !LW) return null;
    host.innerHTML = "";
    host.style.position = "relative";
    const colors = chartColors();
    const chart = LW.createChart(host, {
      autoSize: true,
      layout: { background: { type: LW.ColorType.Solid, color: colors.bg }, textColor: colors.text, attributionLogo: true },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
      rightPriceScale: { borderColor: "rgba(104,129,151,.3)", scaleMargins: { top: 0.10, bottom: 0.10 } },
      timeScale: { borderColor: "rgba(104,129,151,.3)", timeVisible: true, secondsVisible: false, rightOffset: 5 },
      crosshair: { mode: LW.CrosshairMode.MagnetOHLC },
      handleScale: true,
      handleScroll: true,
    });
    const candles = chart.addSeries(LW.CandlestickSeries, {
      upColor: colors.up,
      downColor: colors.down,
      wickUpColor: colors.up,
      wickDownColor: colors.down,
      borderVisible: false,
      priceLineVisible: true,
      lastValueVisible: true,
      priceFormat: { type: "price", precision: 2, minMove: 0.25 },
    });
    const markers = LW.createSeriesMarkers(candles, [], { autoScale: true });
    const overlay = document.createElement("canvas");
    overlay.className = "sd-chart-overlay";
    host.appendChild(overlay);
    const ctx = { symbol, host, chart, candles, markers, overlay, priceLines: [], overlayTimer: null };
    charts[symbol] = ctx;
    scheduleOverlayLoop(symbol);
    return ctx;
  }

  function latestBlockerRow(symbol) {
    const rows = overlayData.blockers[symbol] || [];
    if (!rows.length) return null;
    return [...rows].sort((a, b) => Date.parse(a.captured_at || 0) - Date.parse(b.captured_at || 0)).at(-1) || null;
  }

  function latestStructureEvent(symbol, timeframe) {
    const rows = (overlayData.shadow[symbol] || [])
      .filter(row => String(row.engine || "").toUpperCase().startsWith("STRUCTURE"))
      .filter(row => String(row.timeframe) === timeframe)
      .sort((a, b) => Number(a.bar_close_ms || 0) - Number(b.bar_close_ms || 0));
    return rows.at(-1) || null;
  }

  function v26Execution(symbol) {
    const sourceStatus = normalizeJson(state.latest?.source_status, {});
    const pkg = normalizeJson(sourceStatus?.execution_v26, {});
    return pkg?.instruments?.[symbol] || null;
  }

  function decisionTone(stateClass, stateText) {
    const cls = String(stateClass || "").toLowerCase();
    const text = String(stateText || "").toUpperCase();
    if (cls === "ready" || text.includes("STRUCTURE CONFIRMED")) return "ready";
    if (cls === "blocked" || text.includes("NO TRADE") || text.includes("DO NOT CHASE") || text.includes("GEX TARGET")) return "blocked";
    if (cls === "warmup" || cls === "waiting" || text.includes("WAIT") || text.includes("CAUTION")) return "waiting";
    return "neutral";
  }

  function renderChartDecisionSummary(symbol) {
    const host = $("chartDecisionSummary");
    if (!host || symbol !== selectedChartSymbol) return;

    const exec = v26Execution(symbol);
    const blocker = latestBlockerRow(symbol);
    const bias = String(exec?.bias || blocker?.model_bias || "MIXED").toUpperCase();
    const stateText = exec?.state || blocker?.final_state || "MODEL CONTEXT";
    const tone = decisionTone(exec?.state_class, stateText);

    const setup = Number(exec?.setup_support ?? blocker?.setup_support);
    const spread = Number(exec?.spread ?? blocker?.scenario_spread);
    const targetSymbol = exec?.target_symbol || blocker?.target_symbol || (symbol === "MES" ? "SPX" : "QQQ");
    const target = Number(exec?.target ?? blocker?.target_strike);

    const s5 = exec?.structure?.five_min || latestStructureEvent(symbol, "5m") || {};
    const s10 = exec?.structure?.ten_min || latestStructureEvent(symbol, "10m") || {};

    const s5Dir = String(s5.direction || "MIXED").toUpperCase();
    const s10Dir = String(s10.direction || "MIXED").toUpperCase();
    const s5Event = String(s5.event_type || "STRUCTURE").replaceAll("_", " ");
    const s10Event = String(s10.event_type || "STRUCTURE").replaceAll("_", " ");

    const action = exec?.action
      || (blocker?.underlying_blocker
        ? `Current blocker: ${String(blocker.underlying_blocker).replaceAll("_", " ")}`
        : "Waiting for the latest execution state.");

    host.className = `chart-decision-summary ${tone}`;
    host.innerHTML = `
      <div class="chart-summary-primary">
        <div class="chart-summary-symbol">${esc(symbol)}</div>
        <div class="chart-summary-bias ${bias === "LONG" ? "long" : bias === "SHORT" ? "short" : "mixed"}">${esc(bias)}</div>
        <div class="chart-summary-state">${esc(String(stateText).replaceAll("_", " "))}</div>
      </div>
      <div class="chart-summary-metrics">
        <div><span>Setup Support</span><strong>${Number.isFinite(setup) ? `${setup.toFixed(1)}%` : "—"}</strong></div>
        <div><span>Scenario Spread</span><strong>${Number.isFinite(spread) ? spread.toFixed(1) : "—"}</strong></div>
        <div><span>Primary Target</span><strong>${Number.isFinite(target) ? `${esc(targetSymbol)} ${fmt(target, 0)}` : "—"}</strong></div>
        <div><span>5m Structure</span><strong>${esc(`${s5Dir} · ${s5Event}`)}</strong></div>
        <div><span>10m Structure</span><strong>${esc(`${s10Dir} · ${s10Event}`)}</strong></div>
      </div>
      <div class="chart-summary-action">${esc(action)}</div>
    `;
  }

  function applySelectedChartPanel() {
    document.querySelectorAll("[data-structure-panel]").forEach(panel => {
      panel.classList.toggle("hidden", panel.dataset.structurePanel !== selectedChartSymbol);
    });
    document.querySelectorAll("[data-chart-symbol]").forEach(button => {
      button.classList.toggle("active", button.dataset.chartSymbol === selectedChartSymbol);
    });

    window.requestAnimationFrame(() => {
      renderStructureChart(selectedChartSymbol, true);
      renderChartDecisionSummary(selectedChartSymbol);
    });
  }

  function renderStructureChart(symbol, fit = false) {
    const ctx = charts[symbol] || initChart(symbol);
    if (!ctx) return;
    const bars = displayedBars(symbol);
    ctx.candles.setData(bars);
    applyStructureLines(symbol);
    applyMarkers(symbol);
    redrawZoneOverlay(symbol);
    if (fit && bars.length) {
      const windowBars = viewTf[symbol] === "10m" ? 90 : 150;
      const from = Math.max(0, bars.length - windowBars);
      ctx.chart.timeScale().setVisibleLogicalRange({ from, to: bars.length + 5 });
    }
    const badge = $(`${symbol.toLowerCase()}ChartStatus`);
    if (badge) {
      const zonePayload = currentSupplyDemand(symbol);
      const age = live1mAgeSeconds(symbol);
      const feed = age === null ? "1m pending" : `${isLive1mFresh(symbol) ? "1m feed fresh" : "1m feed stale"} · ${Math.round(age)}s`;
      const mapMode = gexMappingPair(symbol)?.mode === "LIVE_1M" ? "GEX live-map" : "GEX snapshot-map";
      const signalCount = buildMarkers(symbol).length;
      badge.textContent = `${viewTf[symbol]} · ${feed} · ${mapMode} · ${zonePayload ? "zones live" : "zones pending"} · ${signalCount} visible markers`;
    }
    if (symbol === selectedChartSymbol) renderChartDecisionSummary(symbol);
  }

  function renderAllStructureCharts(fit = false) {
    renderStructureChart(selectedChartSymbol, fit);
    renderChartDecisionSummary(selectedChartSymbol);
  }

  function installLayerControls() {
    ["MES", "MNQ"].forEach(symbol => {
      const panel = $(`${symbol.toLowerCase()}StructureChart`)?.closest(".structure-chart-panel");
      const controls = panel?.querySelector(".structure-chart-controls");
      if (!controls || controls.querySelector(".v25-layer-row")) return;

      // Make 5m the V25 default execution view.
      controls.querySelectorAll("[data-structure-tf]").forEach(button => {
        button.classList.toggle("active", button.dataset.structureTf === "5m");
      });

      const row = document.createElement("div");
      row.className = "v25-layer-row";
      const labels = [
        ["model", "Model"],
        ["structure", "BOS / CHoCH"],
        ["entry", "EMA / CCI"],
        ["gex", "GEX Levels"],
        ["zones", "Zones"],
      ];
      labels.forEach(([key, label]) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `v25-layer-btn${layerState[symbol][key] ? " active" : ""}`;
        btn.dataset.chartLayer = key;
        btn.dataset.symbol = symbol;
        btn.textContent = label;
        row.appendChild(btn);
      });
      controls.appendChild(row);
    });

    document.querySelectorAll(".structure-chart-foot").forEach(foot => {
      if (foot.querySelector(".v25-legend-dot")) return;
      const link = foot.querySelector("a");
      const html = `<span><i class="v25-legend-dot model"></i> Model thesis / gates</span><span><i class="v25-legend-dot structure"></i> BOS / CHoCH</span><span><i class="v25-legend-dot entry"></i> EMA / CCI timing</span><span><i class="v25-legend-dot trade"></i> Active trade levels</span>`;
      if (link) link.insertAdjacentHTML("beforebegin", html);
      else foot.insertAdjacentHTML("beforeend", html);
    });

    applySelectedChartPanel();
  }

  function bindControls() {
    document.querySelectorAll("[data-chart-symbol]").forEach(button => {
      button.addEventListener("click", () => {
        const symbol = String(button.dataset.chartSymbol || "").toUpperCase();
        if (!["MES", "MNQ"].includes(symbol)) return;
        selectedChartSymbol = symbol;
        applySelectedChartPanel();
      });
    });

    document.querySelectorAll("[data-structure-tf]").forEach(button => {
      button.addEventListener("click", () => {
        const symbol = button.dataset.symbol;
        const tf = button.dataset.structureTf;
        if (!["MES", "MNQ"].includes(symbol) || !["5m", "10m"].includes(tf)) return;
        viewTf[symbol] = tf;
        document.querySelectorAll(`[data-structure-tf][data-symbol="${symbol}"]`).forEach(x => x.classList.toggle("active", x.dataset.structureTf === tf));
        renderStructureChart(symbol, true);
      });
    });

    document.addEventListener("click", event => {
      const button = event.target.closest("[data-chart-layer]");
      if (!button) return;
      const symbol = button.dataset.symbol;
      const layer = button.dataset.chartLayer;
      if (!layerState[symbol] || !(layer in layerState[symbol])) return;
      layerState[symbol][layer] = !layerState[symbol][layer];
      button.classList.toggle("active", layerState[symbol][layer]);
      renderStructureChart(symbol, false);
    });
  }

  function upsertRealtime5m(row) {
    if (row?.data_type !== "ohlcv" || row?.timeframe !== "5m") return false;
    const symbol = String(row.symbol || "").toUpperCase();
    if (!["MES", "MNQ"].includes(symbol)) return false;
    const bar = normalizeBar(row);
    if (!bar) return false;
    const rows = history[symbol];
    const idx = rows.findIndex(x => x.time === bar.time);
    if (idx >= 0) rows[idx] = bar;
    else rows.push(bar);
    rows.sort((a, b) => a.time - b.time);
    if (rows.length > 460) rows.splice(0, rows.length - 460);
    if (symbol === selectedChartSymbol) renderStructureChart(symbol, false);
    return true;
  }

  function upsertRealtime1m(row) {
    if (row?.data_type !== "ohlcv" || row?.timeframe !== "1m") return false;
    const symbol = String(row.symbol || "").toUpperCase();
    if (!["MES", "MNQ"].includes(symbol)) return false;
    const bar = normalizeBar(row);
    if (!bar) return false;
    const rows = live1mHistory[symbol];
    const idx = rows.findIndex(x => x.time === bar.time);
    if (idx >= 0) rows[idx] = bar;
    else rows.push(bar);
    rows.sort((a, b) => a.time - b.time);
    if (rows.length > 60) rows.splice(0, rows.length - 60);
    if (symbol === selectedChartSymbol) renderStructureChart(symbol, false);
    return true;
  }

  async function initialize() {
    if (initialized) return;
    initialized = true;
    injectV25Styles();
    installLayerControls();
    bindControls();
    renderSupplyDemandCards();
    await Promise.all([fetchChartBars(), fetchOverlayData()]);
    overlayPoll = window.setInterval(() => fetchOverlayData(), 60000);
  }

  window.addEventListener("fm-orderflow-state-updated", async () => {
    await initialize();
    renderSupplyDemandCards();
    renderAllStructureCharts(false);
    window.setTimeout(() => fetchOverlayData(), 2500);
  });

  window.addEventListener("fm-live-market-updated", event => {
    const row = event.detail;
    if (upsertRealtime1m(row)) return;
    if (upsertRealtime5m(row)) return;
    if (row?.data_type === "ohlcv" && row?.timeframe === "1m") {
      const liveSymbol = String(row.symbol || "").toUpperCase();
      if (liveSymbol === "SPX") return renderStructureChart("MES", false);
      if (liveSymbol === "QQQ") return renderStructureChart("MNQ", false);
    }
  });

  window.addEventListener("fm-active-trade-management", () => { fetchOverlayData(); renderAllStructureCharts(false); });
  window.addEventListener("fm-active-trade-live-price", () => renderAllStructureCharts(false));

  window.addEventListener("beforeunload", () => {
    if (overlayPoll) window.clearInterval(overlayPoll);
    Object.values(charts).forEach(ctx => { if (ctx?.overlayTimer) window.clearInterval(ctx.overlayTimer); });
  });

  window.setTimeout(() => initialize().catch(error => console.warn("V25 chart init:", error)), 800);
})();
