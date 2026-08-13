(() => {
  "use strict";

  const state = window.FM_ORDERFLOW_STATE;
  const client = window.FM_ORDERFLOW_CLIENT;

  if (!state || !client) {
    console.warn("Structure charts: dashboard state/client unavailable.");
    return;
  }

  const charts = {};
  const history = { MES: [], MNQ: [] };
  // V23.1 live display layer: completed 1m bars are kept separately so
  // the visual chart can update every minute without changing the confirmed
  // 5m technical/model inputs.
  const live1mHistory = { MES: [], MNQ: [] };
  const LIVE_1M_STALE_SECONDS = 180;
  const viewTf = { MES: "10m", MNQ: "10m" };
  let initialized = false;
  let loading = false;

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
        </div>
      `;
    }
    const gex = Array.isArray(zone.gex_confluence) && zone.gex_confluence.length
      ? `${zone.gex_confluence[0].underlying} ${zone.gex_confluence[0].strike} ${zone.gex_confluence[0].sign === "negative" ? "−GEX" : "+GEX"}`
      : "None";
    return `
      <div class="sd-zone-box ${type.toLowerCase()}">
        <div class="sd-zone-box-top">
          <div>
            <div class="sd-zone-label">${label}</div>
            <strong>${fmt(zone.low)} – ${fmt(zone.high)}</strong>
          </div>
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
      </div>
    `;
  }

  function renderSupplyDemandCards() {
    const container = $("supplyDemandCards");
    if (!container) return;
    const payload = state.latest?.supply_demand || null;
    if (!payload) {
      container.innerHTML = `
        <article class="sd-instrument-card no-data">
          <div class="sd-instrument-title"><strong>Supply / Demand</strong><span>SHADOW</span></div>
          <p>Waiting for the first V22 supply/demand snapshot. Existing production decisions are unchanged.</p>
        </article>
      `;
      return;
    }

    container.innerHTML = ["MES", "MNQ"].map(symbol => {
      const row = payload.instruments?.[symbol] || {};
      return `
        <article class="sd-instrument-card">
          <div class="sd-instrument-title">
            <div>
              <strong>${symbol}</strong>
              <small>Material zones · 15m/1h discovery · 5m refinement</small>
            </div>
            <span>SHADOW · 0% MODEL WEIGHT</span>
          </div>
          <div class="sd-zone-pair">
            ${zoneCard(symbol, "NEAREST SUPPLY", row.nearest_supply, "SUPPLY")}
            ${zoneCard(symbol, "NEAREST DEMAND", row.nearest_demand, "DEMAND")}
          </div>
        </article>
      `;
    }).join("");
  }

  function normalizeBar(row) {
    const p = row?.payload || {};
    const time = Math.floor(Number(row.bar_open_ms) / 1000);
    const open = Number(p.open), high = Number(p.high), low = Number(p.low), close = Number(p.close);
    if (![time, open, high, low, close].every(Number.isFinite)) return null;
    return {
      time, open, high, low, close,
      barCloseMs: Number(row.bar_close_ms),
      receivedAt: row.received_at || null,
    };
  }

  function aggregateBars(bars, seconds, minCount = 1) {
    const groups = new Map();
    for (const bar of bars) {
      const bucket = Math.floor(bar.time / seconds) * seconds;
      if (!groups.has(bucket)) {
        groups.set(bucket, {
          time: bucket,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          count: 1,
        });
      } else {
        const g = groups.get(bucket);
        g.high = Math.max(g.high, bar.high);
        g.low = Math.min(g.low, bar.low);
        g.close = bar.close;
        g.count += 1;
      }
    }
    return [...groups.values()]
      .filter(g => g.count >= minCount)
      .map(({ count, ...bar }) => bar)
      .sort((a, b) => a.time - b.time);
  }

  function aggregate10m(bars) {
    // Two confirmed 5m bars are required for a confirmed historical 10m bar.
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
    if (Number.isFinite(closeMs) && closeMs > 0) {
      return Math.max(0, (Date.now() - closeMs) / 1000);
    }
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
    // Historical candles remain confirmed 5m/10m data. The newest visual candle
    // is synthesized only from COMPLETED 1m bars and is display-only. It never
    // feeds technicals, GEX mapping, Supply/Demand, Attraction, or evaluation.
    const base = viewTf[symbol] === "10m"
      ? aggregate10m(history[symbol])
      : [...history[symbol]];
    const liveBar = currentLiveDisplayBar(symbol);
    if (!liveBar) return base;

    const out = [...base];
    const idx = out.findIndex(bar => bar.time === liveBar.time);
    if (idx >= 0) out[idx] = liveBar;
    else if (!out.length || liveBar.time > out[out.length - 1].time) out.push(liveBar);
    return out.sort((a, b) => a.time - b.time);
  }

  async function fetchChartBars() {
    if (loading) return;
    loading = true;
    try {
      const symbols = ["MES", "MNQ"];
      const queries = [];
      symbols.forEach(symbol => {
        queries.push(
          client
            .from("tv_market_bars")
            .select("data_type,symbol,timeframe,bar_open_ms,bar_close_ms,payload,received_at")
            .eq("data_type", "ohlcv")
            .eq("symbol", symbol)
            .eq("timeframe", "5m")
            .order("bar_open_ms", { ascending: false })
            .limit(220)
        );
        // Pull enough completed 1m bars to immediately reconstruct the current
        // partial 5m/10m display candle after a page load.
        queries.push(
          client
            .from("tv_market_bars")
            .select("data_type,symbol,timeframe,bar_open_ms,bar_close_ms,payload,received_at")
            .eq("data_type", "ohlcv")
            .eq("symbol", symbol)
            .eq("timeframe", "1m")
            .order("bar_open_ms", { ascending: false })
            .limit(30)
        );
      });

      const results = await Promise.all(queries);
      symbols.forEach((symbol, idx) => {
        const result5m = results[idx * 2];
        const result1m = results[idx * 2 + 1];
        if (result5m.error) throw result5m.error;
        if (result1m.error) throw result1m.error;
        history[symbol] = (result5m.data || [])
          .map(normalizeBar)
          .filter(Boolean)
          .sort((a, b) => a.time - b.time);
        live1mHistory[symbol] = (result1m.data || [])
          .map(normalizeBar)
          .filter(Boolean)
          .sort((a, b) => a.time - b.time);
      });
      renderAllStructureCharts(true);
    } catch (error) {
      console.warn("Structure chart history query failed:", error);
      ["MES", "MNQ"].forEach(symbol => {
        const host = $(`${symbol.toLowerCase()}StructureChart`);
        if (host && !host.children.length) {
          host.innerHTML = `<div class="structure-chart-error">Price history unavailable · ${esc(error?.message || error)}</div>`;
        }
      });
    } finally {
      loading = false;
    }
  }

  function chartColors() {
    return {
      bg: "#09131d",
      text: "#9fb3c6",
      grid: "rgba(70, 99, 125, .18)",
      up: "#37b95a",
      down: "#ef5350",
      supplyFill: "rgba(239,83,80,.13)",
      supplyBorder: "rgba(239,83,80,.70)",
      demandFill: "rgba(55,185,90,.13)",
      demandBorder: "rgba(55,185,90,.70)",
    };
  }

  function clearPriceLines(ctx) {
    if (!ctx?.candles || !Array.isArray(ctx.priceLines)) return;
    ctx.priceLines.forEach(line => {
      try { ctx.candles.removePriceLine(line); } catch (_e) {}
    });
    ctx.priceLines = [];
  }

  function modelFuturesPrice(symbol) {
    const row = state.latest?.technicals?.symbols?.[symbol] || null;
    const value = Number(row?.price ?? row?.timeframes?.["5m"]?.price);
    return Number.isFinite(value) ? value : null;
  }

  function relevantGex(symbol) {
    const underlying = symbol === "MES" ? "SPX" : "QQQ";
    const block = state.latest?.gex_context?.symbols?.[underlying] || null;
    const futPrice = modelFuturesPrice(symbol);
    const spot = Number(block?.price);
    if (!block || !Number.isFinite(futPrice) || !Number.isFinite(spot) || spot === 0) return [];
    const ratio = futPrice / spot;
    const primaryAsset = state.latest?.attraction?.assets?.[underlying] || {};
    const primaryStrikes = new Set([
      Number(primaryAsset?.primary_up_target?.strike),
      Number(primaryAsset?.primary_down_target?.strike),
    ].filter(Number.isFinite));

    const rows = (block.ranked_all || [])
      .filter(row => row?.material !== false)
      .map(row => ({
        ...row,
        strikeNum: Number(row.strike),
        priorityNum: Number(row.priority_score || 0),
      }))
      .filter(row => Number.isFinite(row.strikeNum) && (row.priorityNum >= 65 || primaryStrikes.has(row.strikeNum)))
      .map(row => ({
        ...row,
        mappedPrice: row.strikeNum * ratio,
        isPrimary: primaryStrikes.has(row.strikeNum),
      }))
      .sort((a, b) => {
        if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
        return b.priorityNum - a.priorityNum;
      });

    const unique = [];
    for (const row of rows) {
      if (unique.some(x => Math.abs(x.mappedPrice - row.mappedPrice) < 0.35)) continue;
      unique.push(row);
      if (unique.length >= 5) break;
    }
    return unique.map(row => ({
      underlying,
      strike: row.strikeNum,
      price: row.mappedPrice,
      sign: row.sign,
      priority: row.priority,
      isPrimary: row.isPrimary,
    }));
  }

  function currentTargetMapped(symbol) {
    const trade = state.activeTrade;
    if (!trade || trade.active !== true || trade.instrument !== symbol) return null;
    const underlying = symbol === "MES" ? "SPX" : "QQQ";
    const block = state.latest?.gex_context?.symbols?.[underlying] || null;
    const asset = state.latest?.attraction?.assets?.[underlying] || null;
    const futPrice = modelFuturesPrice(symbol);
    const spot = Number(block?.price);
    if (!asset || !Number.isFinite(futPrice) || !Number.isFinite(spot) || spot === 0) return null;
    const target = trade.direction === "LONG" ? asset.primary_up_target : asset.primary_down_target;
    const strike = Number(target?.strike);
    if (!Number.isFinite(strike)) return null;
    return { price: strike * (futPrice / spot), strike, underlying };
  }

  function applyStructureLines(symbol) {
    const ctx = charts[symbol];
    if (!ctx) return;
    clearPriceLines(ctx);
    const LW = window.LightweightCharts;
    const colors = chartColors();

    relevantGex(symbol).forEach(row => {
      const line = ctx.candles.createPriceLine({
        price: row.price,
        color: row.sign === "negative" ? "#d85d57" : "#4aa7c7",
        lineWidth: row.isPrimary ? 2 : 1,
        lineStyle: row.isPrimary ? LW.LineStyle.Dashed : LW.LineStyle.Dotted,
        axisLabelVisible: true,
        title: `${row.underlying} ${row.strike} ${row.sign === "negative" ? "−GEX" : "+GEX"}${row.isPrimary ? " ★" : ""}`,
      });
      ctx.priceLines.push(line);
    });

    // Always plot the newest completed 1m futures price. This is a visual
    // execution layer only; model/GEX/S&D state remains frozen to its cycle.
    const live = latestLive1m(symbol);
    const livePrice = Number(live?.close);
    if (Number.isFinite(livePrice)) {
      const fresh = isLive1mFresh(symbol);
      ctx.priceLines.push(ctx.candles.createPriceLine({
        price: livePrice,
        color: fresh ? "#d7e5f2" : "#7f8b96",
        lineWidth: fresh ? 2 : 1,
        lineStyle: LW.LineStyle.Dotted,
        axisLabelVisible: true,
        title: fresh ? "LIVE 1M" : "1M STALE",
      }));
    }

    const trade = state.activeTrade;
    if (trade?.active === true && trade.instrument === symbol) {
      const entry = Number(trade.avgEntry ?? trade.entry);
      const stop = Number(trade.currentStop ?? trade.initialStop);
      if (Number.isFinite(entry)) {
        ctx.priceLines.push(ctx.candles.createPriceLine({
          price: entry,
          color: "#f2c94c",
          lineWidth: 2,
          lineStyle: LW.LineStyle.Solid,
          axisLabelVisible: true,
          title: `TRADE ENTRY ${trade.direction}`,
        }));
      }
      if (Number.isFinite(stop)) {
        ctx.priceLines.push(ctx.candles.createPriceLine({
          price: stop,
          color: "#ff6b6b",
          lineWidth: 2,
          lineStyle: LW.LineStyle.Dashed,
          axisLabelVisible: true,
          title: "ACTIVE STOP",
        }));
      }
      const target = currentTargetMapped(symbol);
      if (target) {
        ctx.priceLines.push(ctx.candles.createPriceLine({
          price: target.price,
          color: "#63d297",
          lineWidth: 2,
          lineStyle: LW.LineStyle.Dashed,
          axisLabelVisible: true,
          title: `${target.underlying} ${target.strike} TARGET`,
        }));
      }
    }
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
    const colors = chartColors();
    const rightScaleWidth = ctx.chart.priceScale("right").width();
    const plotWidth = Math.max(40, width - rightScaleWidth);
    const row = currentSupplyDemand(symbol);
    const zones = [
      ...(row?.demand_zones || []).slice(0, 3),
      ...(row?.supply_zones || []).slice(0, 3),
    ];
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
      const label = `${zone.type} ${fmt(zone.low)}–${fmt(zone.high)} · ${fmt(zone.materiality_score, 0)} ${zone.timeframe.toUpperCase()} ${zone.status}`;
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
    ctx.overlayTimer = window.setInterval(() => redrawZoneOverlay(symbol), 350);
  }

  function initChart(symbol) {
    const host = $(`${symbol.toLowerCase()}StructureChart`);
    if (!host || !window.LightweightCharts) return null;
    host.innerHTML = "";
    host.style.position = "relative";
    const colors = chartColors();
    const chart = window.LightweightCharts.createChart(host, {
      autoSize: true,
      layout: {
        background: { type: window.LightweightCharts.ColorType.Solid, color: colors.bg },
        textColor: colors.text,
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: colors.grid },
        horzLines: { color: colors.grid },
      },
      rightPriceScale: { borderColor: "rgba(104,129,151,.3)", scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { borderColor: "rgba(104,129,151,.3)", timeVisible: true, secondsVisible: false, rightOffset: 4 },
      crosshair: { mode: window.LightweightCharts.CrosshairMode.MagnetOHLC },
      handleScale: true,
      handleScroll: true,
    });
    const candles = chart.addSeries(window.LightweightCharts.CandlestickSeries, {
      upColor: colors.up,
      downColor: colors.down,
      wickUpColor: colors.up,
      wickDownColor: colors.down,
      borderVisible: false,
      priceLineVisible: true,
      lastValueVisible: true,
      priceFormat: { type: "price", precision: 2, minMove: 0.25 },
    });
    const overlay = document.createElement("canvas");
    overlay.className = "sd-chart-overlay";
    host.appendChild(overlay);
    const ctx = { symbol, host, chart, candles, overlay, priceLines: [], overlayTimer: null };
    charts[symbol] = ctx;
    scheduleOverlayLoop(symbol);
    return ctx;
  }

  function renderStructureChart(symbol, fit = false) {
    let ctx = charts[symbol] || initChart(symbol);
    if (!ctx) return;
    const bars = displayedBars(symbol);
    ctx.candles.setData(bars);
    applyStructureLines(symbol);
    redrawZoneOverlay(symbol);
    if (fit && bars.length) {
      const windowBars = viewTf[symbol] === "10m" ? 72 : 96;
      const from = Math.max(0, bars.length - windowBars);
      ctx.chart.timeScale().setVisibleLogicalRange({ from, to: bars.length + 4 });
    }
    const badge = $(`${symbol.toLowerCase()}ChartStatus`);
    if (badge) {
      const zonePayload = currentSupplyDemand(symbol);
      const live = latestLive1m(symbol);
      const age = live1mAgeSeconds(symbol);
      const liveText = live
        ? `${isLive1mFresh(symbol) ? "LIVE 1M" : "STALE 1M"} ${fmt(live.close)}${age !== null ? ` · ${Math.round(age)}s` : ""}`
        : "1M pending";
      badge.textContent = `${viewTf[symbol]} · ${liveText} · ${zonePayload ? "zones live" : "zones pending"}`;
    }
  }

  function renderAllStructureCharts(fit = false) {
    ["MES", "MNQ"].forEach(symbol => renderStructureChart(symbol, fit));
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
    if (rows.length > 240) rows.splice(0, rows.length - 240);
    renderStructureChart(symbol, false);
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
    if (rows.length > 45) rows.splice(0, rows.length - 45);
    renderStructureChart(symbol, false);
    return true;
  }

  function bindTimeframeButtons() {
    document.querySelectorAll("[data-structure-tf]").forEach(button => {
      button.addEventListener("click", () => {
        const symbol = button.dataset.symbol;
        const tf = button.dataset.structureTf;
        if (!["MES", "MNQ"].includes(symbol) || !["5m", "10m"].includes(tf)) return;
        viewTf[symbol] = tf;
        document.querySelectorAll(`[data-structure-tf][data-symbol="${symbol}"]`).forEach(x =>
          x.classList.toggle("active", x.dataset.structureTf === tf)
        );
        renderStructureChart(symbol, true);
      });
    });
  }

  async function initialize() {
    if (initialized) return;
    initialized = true;
    bindTimeframeButtons();
    renderSupplyDemandCards();
    await fetchChartBars();
  }

  window.addEventListener("fm-orderflow-state-updated", async () => {
    await initialize();
    renderSupplyDemandCards();
    renderAllStructureCharts(false);
  });

  window.addEventListener("fm-live-market-updated", event => {
    // The 1m event updates the visible price/candle immediately. The 5m event
    // later promotes the completed bar into confirmed chart history.
    if (upsertRealtime1m(event.detail)) return;
    if (upsertRealtime5m(event.detail)) return;
  });

  window.addEventListener("fm-active-trade-management", () => renderAllStructureCharts(false));
  window.addEventListener("fm-active-trade-live-price", () => renderAllStructureCharts(false));

  // Handles direct tab/page loads where the first state event has already fired.
  window.setTimeout(() => {
    initialize().catch(error => console.warn("Structure chart init:", error));
  }, 800);
})();
