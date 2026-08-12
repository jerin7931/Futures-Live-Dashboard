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
    if (v.includes("BULL")) return "positive";
    if (v.includes("BEAR")) return "negative";
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

      container.insertAdjacentHTML("beforeend", `
        <article class="instrument-card ${preferred === symbol ? "preferred" : ""}">
          <div class="instrument-top">
            <div>
              <div class="instrument-symbol">${symbol}</div>
              <div class="instrument-bias ${biasClass(row.bias)}">
                ${esc(String(row.bias || "N/A").replaceAll("_", " "))}
              </div>
            </div>
            <div>
              <div class="tradeability-number">${fmt(row.tradeability_score, 1)}</div>
              <div class="tradeability-label">
                TRADEABILITY · ${esc(String(row.tradeability_confidence || "N/A").replaceAll("_", " "))}
              </div>
            </div>
          </div>
          <div class="component-bar">${componentHtml}</div>
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

      container.insertAdjacentHTML("beforeend", `
        <article class="market-card ${state.marketFilter !== "all" && state.marketFilter !== symbol ? "hidden-filter" : ""}" data-symbol="${symbol}">
          <div class="market-top">
            <div>
              <div class="market-symbol">${symbol}</div>
              <div class="spot">Spot <strong>${fmt(gex.price, symbol === "SPX" ? 1 : 2)}</strong></div>
            </div>
            <span class="badge ${biasClass(netBias) === "positive" ? "good" : biasClass(netBias) === "negative" ? "bad" : "warn"}">
              ${esc(String(netBias).replaceAll("_", " "))}
            </span>
          </div>

          <div class="target-grid">
            ${targetBox("UP TARGET", up, "positive")}
            ${targetBox("DOWN TARGET", down, "negative")}
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

  function targetBox(label, row, className) {
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

  function renderLive() {
    if (!state.latest) {
      $("currentCycleBadge").textContent = "NO DATA";
      return;
    }

    $("currentCycleBadge").textContent = localDateTime(state.latest.captured_at);

    renderInstrumentCards(state.latest, "instrumentCards");
    renderTechnicalCards(state.latest, "technicalCards");
    renderMarketCards(state.latest, "marketCards");

    renderFlowHistory();
    renderAttractionHistory();

    updateExplorer();
  }

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
          ...chartOptions("Tradeability"),
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

  function renderOutcomeAnalytics() {
    const rows = state.outcomes;

    if (!rows.length) {
      $("outcomeNotice").classList.remove("hidden");
      $("outcomeNotice").innerHTML =
        `<strong>Outcome table is ready, but no evaluated outcomes exist for this date yet.</strong><br>` +
        `The live/history website is fully functional. Exact target-hit, MFE/MAE and calibration ` +
        `metrics will populate once the end-of-day evaluator writes rows to <code>model_outcomes</code>.`;

      $("outcomesTable").querySelector("tbody").innerHTML = "";
      renderEmptyOutcomeCharts();
      renderAnalyticsStats();
      return;
    }

    $("outcomeNotice").classList.add("hidden");

    const byHorizon = {};
    rows.forEach(r => {
      const h = String(r.horizon_minutes);
      byHorizon[h] ||= { total: 0, correct: 0 };
      byHorizon[h].total += 1;
      if (r.bias_correct === true) byHorizon[h].correct += 1;
    });

    destroyChart("accuracy");
    state.charts.accuracy = new Chart(
      $("accuracyChart").getContext("2d"),
      {
        type: "bar",
        data: {
          labels: Object.keys(byHorizon).sort((a,b) => Number(a)-Number(b)).map(h => `${h}m`),
          datasets: [{
            label: "Directional accuracy %",
            data: Object.keys(byHorizon)
              .sort((a,b) => Number(a)-Number(b))
              .map(h => percent(byHorizon[h].correct, byHorizon[h].total)),
            backgroundColor: "#37b95a",
          }],
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
        r.target_hit !== null
      );
      return {
        label: bucket.label,
        hitRate: percent(sample.filter(r => r.target_hit === true).length, sample.length),
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
            label: "Observed target hit rate %",
            data: calibration.map(x => x.hitRate),
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

    $("outcomesTable").querySelector("tbody").innerHTML = rows.map(r => `
      <tr>
        <td>${localTime(r.captured_at)}</td>
        <td>${esc(r.instrument)}</td>
        <td class="${biasClass(r.model_bias)}">${esc(String(r.model_bias || "").replaceAll("_", " "))}</td>
        <td>${fmt(r.model_score, 1)}</td>
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
    const snapshots = state.daySnapshots;
    const outcomes = state.outcomes;

    const mesScores = snapshots.map(x => Number(x.mes_tradeability)).filter(Number.isFinite);
    const mnqScores = snapshots.map(x => Number(x.mnq_tradeability)).filter(Number.isFinite);

    const targetRows = outcomes.filter(r => r.target_hit !== null);
    const hitRate = percent(targetRows.filter(r => r.target_hit === true).length, targetRows.length);

    const correctnessRows = outcomes.filter(r => r.bias_correct !== null);
    const accuracy = percent(correctnessRows.filter(r => r.bias_correct === true).length, correctnessRows.length);

    const avg = values => values.length
      ? values.reduce((a,b) => a+b, 0) / values.length
      : null;

    const mfe = avg(outcomes.map(r => Number(r.mfe_points)).filter(Number.isFinite));
    const mae = avg(outcomes.map(r => Number(r.mae_points)).filter(Number.isFinite));

    const cards = [
      ["Avg MES tradeability", fmt(avg(mesScores), 1), `${mesScores.length} snapshots`],
      ["Avg MNQ tradeability", fmt(avg(mnqScores), 1), `${mnqScores.length} snapshots`],
      ["Directional accuracy", accuracy === null ? "—" : `${fmt(accuracy, 1)}%`, `${correctnessRows.length} outcomes`],
      ["Target hit rate", hitRate === null ? "—" : `${fmt(hitRate, 1)}%`, `${targetRows.length} evaluated targets`],
      ["Average MFE", fmtSigned(mfe), "points"],
      ["Average MAE", fmtSigned(mae), "points"],
      ["Snapshots", snapshots.length, "selected trading date"],
      ["Evaluated rows", outcomes.length, "model_outcomes"],
    ];

    $("analyticsStatCards").innerHTML = cards.map(([label, value, sub]) => `
      <article class="stat-card">
        <div class="stat-label">${esc(label)}</div>
        <div class="stat-value">${esc(value)}</div>
        <div class="stat-sub">${esc(sub)}</div>
      </article>
    `).join("");
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
    const isFresh = ageMin <= 25;

    $("connectionStatus").textContent = isFresh ? "Live data" : "Snapshot stale";
    $("liveDot").className = `status-dot ${isFresh ? "online" : "stale"}`;
    $("lastUpdateText").textContent = localDateTime(state.latest.captured_at);

    const next = new Date(new Date(state.latest.captured_at).getTime() + 15 * 60000);
    $("nextUpdateText").textContent = localTime(next);
  }

  async function refreshAll({ preserveHistory = false } = {}) {
    try {
      await fetchLatest();

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
    await refreshAll();
    subscribeRealtime();

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

  $("flowSymbolSelect").addEventListener("change", renderFlowHistory);
  $("attractionSymbolSelect").addEventListener("change", renderAttractionHistory);

  $("historyDate").addEventListener("change", loadHistoryDate);
  $("historyTimeSelect").addEventListener("change", renderHistorySelected);
  $("loadHistoryButton").addEventListener("click", loadHistoryDate);

  $("analyticsDate").addEventListener("change", renderAnalytics);

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
