(() => {
  "use strict";

  // ==========================================================
  // TRADE JOURNAL + SUPABASE WRITES V1
  // ==========================================================
  // Loaded BEFORE app.js so we can:
  // - inject the Trades tab before app registers tab listeners
  // - intercept the legacy local-only trade form in capture phase
  //
  // Browser never receives the service-role key. Writes use authenticated
  // RPCs protected by auth.uid() ownership checks in Postgres.
  // ==========================================================

  const CACHE_KEY = "fm_active_trade_v1";
  const JOURNAL_VERSION = "TRADE_JOURNAL_SUPABASE_V1";

  const $ = id => document.getElementById(id);

  let journalAvailable = true;
  let selectedTradeId = null;
  let trades = [];
  let events = [];
  let evaluations = [];
  let latestManagement = null;
  let booted = false;

  function client() {
    return window.FM_ORDERFLOW_CLIENT || null;
  }

  function appState() {
    return window.FM_ORDERFLOW_STATE || null;
  }

  function helpers() {
    return window.FM_ACTIVE_TRADE_HELPERS || null;
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
    const n = Number(value);
    return Number.isFinite(n)
      ? n.toFixed(digits)
      : "—";
  }

  function fmtSigned(value, digits = 2) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    return `${n > 0 ? "+" : ""}${n.toFixed(digits)}`;
  }

  function money(value, digits = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    const sign = n > 0 ? "+" : n < 0 ? "-" : "";
    return `${sign}$${Math.abs(n).toFixed(digits)}`;
  }

  function localDateTime(value) {
    if (!value) return "—";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Chicago",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(value));
    }
    catch (_error) {
      return String(value);
    }
  }

  function normalizeObject(value) {
    if (!value) return {};
    if (typeof value === "object") return value;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object"
        ? parsed
        : {};
    }
    catch (_error) {
      return {};
    }
  }

  function toast(message) {
    const node = $("toast");
    if (!node) return;
    node.textContent = message;
    node.classList.remove("hidden");
    clearTimeout(node._tradeJournalTimer);
    node._tradeJournalTimer = setTimeout(
      () => node.classList.add("hidden"),
      2600
    );
  }

  function injectStaticUi() {
    const nav = document.querySelector(".tabs");
    const analyticsButton = nav?.querySelector('[data-tab="analytics"]');

    if (
      nav &&
      analyticsButton &&
      !nav.querySelector('[data-tab="trades"]')
    ) {
      const button = document.createElement("button");
      button.className = "tab";
      button.dataset.tab = "trades";
      button.innerHTML = '<span class="nav-icon">▤</span><span>Journal</span>';
      nav.insertBefore(button, analyticsButton);
    }

    const analyticsPanel = $("tab-analytics");

    if (
      analyticsPanel &&
      !$("tab-trades")
    ) {
      const panel = document.createElement("section");
      panel.id = "tab-trades";
      panel.className = "tab-panel";
      panel.innerHTML = `
        <div class="section-heading">
          <div>
            <p class="eyebrow">ACTUAL EXECUTIONS · SUPABASE JOURNAL</p>
            <h2>Trades · Entries · Scales · Trims · Exits</h2>
          </div>

          <div class="trade-journal-controls">
            <select id="tradesStatusFilter" class="compact-select">
              <option value="ALL">All trades</option>
              <option value="OPEN">Open</option>
              <option value="CLOSED">Closed</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
            <button id="tradesRefreshButton" class="ghost-button" type="button">Refresh trades</button>
          </div>
        </div>

        <div id="tradeJournalStatCards" class="stat-grid"></div>

        <article class="panel trade-journal-panel">
          <div class="panel-heading">
            <div>
              <p class="eyebrow">TRADE LEDGER</p>
              <h3>Actual Trades</h3>
            </div>
          </div>

          <div class="table-scroll trade-journal-scroll">
            <table id="tradeJournalTable" class="trade-journal-table">
              <thead>
                <tr>
                  <th>Opened</th>
                  <th>Instrument</th>
                  <th>Side</th>
                  <th>Status</th>
                  <th>Initial</th>
                  <th>Avg Entry</th>
                  <th>Avg Exit</th>
                  <th>Max Qty</th>
                  <th>Scales</th>
                  <th>Trims</th>
                  <th>Net P/L</th>
                  <th>R vs Initial</th>
                </tr>
              </thead>
              <tbody></tbody>
            </table>
          </div>
        </article>

        <div id="tradeJournalDetail" class="trade-journal-detail"></div>
      `;

      analyticsPanel.parentNode.insertBefore(
        panel,
        analyticsPanel
      );
    }

    const stats = $("analyticsStatCards");

    if (
      stats &&
      !$("actualTradeStatCards")
    ) {
      const wrapper = document.createElement("div");
      wrapper.className = "actual-trade-analytics-wrap";
      wrapper.innerHTML = `
        <div class="section-heading actual-trade-analytics-heading">
          <div>
            <p class="eyebrow">ACTUAL TRADE PERFORMANCE</p>
            <h2>Executed Trade Results</h2>
          </div>
        </div>

        <div id="actualTradeStatCards" class="stat-grid"></div>

        <article class="panel actual-trade-research-panel">
          <div class="panel-heading">
            <div>
              <p class="eyebrow">ACTUAL EXECUTION RESEARCH</p>
              <h3>MES vs MNQ · Realized Performance</h3>
            </div>
          </div>

          <div class="table-scroll research-table-scroll">
            <table id="actualTradeResearchTable" class="research-table">
              <thead>
                <tr>
                  <th>Instrument</th>
                  <th>N</th>
                  <th>Win Rate</th>
                  <th>Net P/L</th>
                  <th>Avg R</th>
                  <th>Profit Factor</th>
                  <th>Avg MFE</th>
                  <th>Avg MAE</th>
                </tr>
              </thead>
              <tbody></tbody>
            </table>
          </div>

          <div id="actualTradeAnalyticsNote" class="analytics-note"></div>
        </article>
      `;

      stats.insertAdjacentElement("afterend", wrapper);
    }
  }

  injectStaticUi();

  function dbTradeToLocal(row, history = []) {
    if (!row) return null;

    return {
      version: "ACTIVE_TRADE_MANAGEMENT_V2_SUPABASE",
      id: row.id,
      active: row.status === "OPEN",
      status: row.status,
      instrument: row.instrument,
      direction: row.direction,
      entry: Number(row.initial_entry_price),
      avgEntry: Number(row.avg_entry_price),
      initialStop: Number(row.initial_stop_price),
      currentStop: Number(row.current_stop_price),
      initialContracts: Number(row.initial_contracts),
      openContracts: Number(row.open_contracts),
      contracts: Number(row.open_contracts),
      maxContracts: Number(row.max_contracts),
      scaleInCount: Number(row.scale_in_count || 0),
      trimCount: Number(row.trim_count || 0),
      avgExitPrice:
        row.avg_exit_price === null
          ? null
          : Number(row.avg_exit_price),
      initialRiskPoints: Number(row.initial_risk_points),
      initialRiskDollars: Number(row.initial_risk_dollars),
      pointValue: Number(row.point_value),
      realizedPnlDollars: Number(row.realized_pnl_dollars || 0),
      activatedAt: row.opened_at,
      closedAt: row.closed_at,
      entryContext: normalizeObject(row.entry_context),
      notes: row.notes || "",
      history,
    };
  }

  function managementRowsToHistory(rows) {
    return (rows || []).map(row => ({
      snapshotId: row.market_snapshot_id,
      capturedAt: row.captured_at,
      state: row.management_state,
      currentPrice:
        row.current_price === null
          ? null
          : Number(row.current_price),
      openR:
        row.open_r_initial === null
          ? null
          : Number(row.open_r_initial),
      totalR:
        row.total_r_initial === null
          ? null
          : Number(row.total_r_initial),
      openDollars:
        row.unrealized_pnl_dollars === null
          ? null
          : Number(row.unrealized_pnl_dollars),
      totalDollars:
        row.total_pnl_dollars === null
          ? null
          : Number(row.total_pnl_dollars),
      underlyingSymbol: row.underlying_symbol,
      underlyingSpot:
        row.underlying_spot === null
          ? null
          : Number(row.underlying_spot),
      targetStrike:
        row.current_target === null
          ? null
          : Number(row.current_target),
      marketCondition: row.market_condition,
      gexState: row.gex_state,
      crossMarket: row.cross_market,
      techScore:
        row.tech_score === null
          ? null
          : Number(row.tech_score),
      orderFlowRegime: row.orderflow_regime,
      orderFlowTrigger: row.orderflow_trigger,
      invalidationCategories:
        Array.isArray(row.invalidation_categories)
          ? row.invalidation_categories
          : [],
      warnings:
        Array.isArray(row.warnings)
          ? row.warnings
          : [],
    }));
  }

  function setAppActiveTrade(trade) {
    const state = appState();

    if (state) {
      state.activeTrade = trade;
      state.activeTradeLoaded = true;
    }

    try {
      if (trade) {
        localStorage.setItem(
          CACHE_KEY,
          JSON.stringify(trade)
        );
      }
      else {
        localStorage.removeItem(CACHE_KEY);
      }
    }
    catch (_error) {
      // DB remains authoritative.
    }

    window.dispatchEvent(
      new Event("fm-orderflow-recovered")
    );
  }

  async function rpc(name, payload) {
    const c = client();
    if (!c) throw new Error("Supabase client is not ready.");

    const { data, error } = await c.rpc(name, payload);
    if (error) throw error;
    return data;
  }

  async function syncActiveTrade() {
    const c = client();
    if (!c) return null;

    try {
      const { data, error } = await c
        .from("trades")
        .select("*")
        .eq("status", "OPEN")
        .order("opened_at", { ascending: false })
        .limit(1);

      if (error) throw error;

      const row = data?.[0] || null;

      if (!row) {
        setAppActiveTrade(null);
        journalAvailable = true;
        return null;
      }

      const historyResponse = await c
        .from("trade_management_snapshots")
        .select("*")
        .eq("trade_id", row.id)
        .order("captured_at", { ascending: true })
        .limit(250);

      if (historyResponse.error) {
        throw historyResponse.error;
      }

      const trade = dbTradeToLocal(
        row,
        managementRowsToHistory(historyResponse.data)
      );

      setAppActiveTrade(trade);
      journalAvailable = true;
      return trade;

    } catch (error) {
      console.warn("Trade Journal active query:", error);
      journalAvailable = false;
      showJournalSetupError();
      return null;
    }
  }

  function showJournalSetupError() {
    const node = $("activeTradeFormError");
    if (!node) return;

    node.textContent =
      "Trade Journal unavailable. Run supabase/trade_journal_v1.sql before recording trades.";
  }

  async function fetchJournalData() {
    const c = client();
    if (!c) return;

    try {
      const [tradeRows, eventRows, evalRows] = await Promise.all([
        c
          .from("trades")
          .select("*")
          .order("opened_at", { ascending: false })
          .limit(100),
        c
          .from("trade_events")
          .select("*")
          .order("event_time", { ascending: false })
          .limit(1000),
        c
          .from("trade_evaluations")
          .select("*")
          .order("trading_date", { ascending: false })
          .limit(500),
      ]);

      if (tradeRows.error) throw tradeRows.error;
      if (eventRows.error) throw eventRows.error;
      if (evalRows.error) throw evalRows.error;

      trades = tradeRows.data || [];
      events = eventRows.data || [];
      evaluations = evalRows.data || [];
      journalAvailable = true;

      if (!selectedTradeId && trades.length) {
        selectedTradeId = trades[0].id;
      }

    } catch (error) {
      console.warn("Trade Journal query:", error);
      journalAvailable = false;
      trades = [];
      events = [];
      evaluations = [];
    }
  }

  function tradeNetR(row) {
    const pnl = Number(row?.realized_pnl_dollars);
    const risk = Number(row?.initial_risk_dollars);

    return (
      Number.isFinite(pnl) &&
      Number.isFinite(risk) &&
      risk > 0
    )
      ? pnl / risk
      : null;
  }

  function profitFactor(rows) {
    const wins = rows
      .map(row => Number(row.realized_pnl_dollars))
      .filter(value => Number.isFinite(value) && value > 0)
      .reduce((a, b) => a + b, 0);

    const losses = Math.abs(
      rows
        .map(row => Number(row.realized_pnl_dollars))
        .filter(value => Number.isFinite(value) && value < 0)
        .reduce((a, b) => a + b, 0)
    );

    if (losses === 0) {
      return wins > 0
        ? Infinity
        : null;
    }

    return wins / losses;
  }

  function renderTradeStats(rows) {
    const host = $("tradeJournalStatCards");
    if (!host) return;

    const closed = rows.filter(row => row.status === "CLOSED");
    const wins = closed.filter(
      row => Number(row.realized_pnl_dollars) > 0
    );

    const net = closed.reduce(
      (sum, row) =>
        sum + (Number(row.realized_pnl_dollars) || 0),
      0
    );

    const rValues = closed
      .map(tradeNetR)
      .filter(Number.isFinite);

    const avgR = rValues.length
      ? rValues.reduce((a, b) => a + b, 0) / rValues.length
      : null;

    const scales = rows.reduce(
      (sum, row) => sum + Number(row.scale_in_count || 0),
      0
    );

    const trims = rows.reduce(
      (sum, row) => sum + Number(row.trim_count || 0),
      0
    );

    const pf = profitFactor(closed);

    const cards = [
      [
        "Closed trades",
        closed.length,
        `${rows.filter(row => row.status === "OPEN").length} open`,
      ],
      [
        "Actual win rate",
        closed.length
          ? `${fmt(100 * wins.length / closed.length, 1)}%`
          : "—",
        `${wins.length} wins / ${closed.length - wins.length} non-wins`,
      ],
      ["Net realized P/L", money(net), "saved fills"],
      [
        "Avg R vs initial risk",
        avgR === null ? "—" : `${fmtSigned(avgR, 2)}R`,
        "original planned risk denominator",
      ],
      [
        "Profit factor",
        pf === null ? "—" : pf === Infinity ? "∞" : fmt(pf, 2),
        "gross wins ÷ gross losses",
      ],
      ["Position events", `${scales} / ${trims}`, "scales / trims"],
    ];

    host.innerHTML = cards
      .map(([label, value, sub]) => `
        <article class="stat-card">
          <div class="stat-label">${esc(label)}</div>
          <div class="stat-value">${esc(value)}</div>
          <div class="stat-sub">${esc(sub)}</div>
        </article>
      `)
      .join("");
  }

  function evaluationForTrade(tradeId) {
    return evaluations.find(
      row => row.trade_id === tradeId
    ) || null;
  }

  function eventsForTrade(tradeId) {
    return events
      .filter(row => row.trade_id === tradeId)
      .sort((a, b) =>
        new Date(a.event_time) - new Date(b.event_time)
      );
  }

  function renderTradeDetail() {
    const host = $("tradeJournalDetail");
    if (!host) return;

    const trade = trades.find(
      row => row.id === selectedTradeId
    );

    if (!trade) {
      host.innerHTML = "";
      return;
    }

    const ledger = eventsForTrade(trade.id);
    const evaluation = evaluationForTrade(trade.id);
    const evalJson = normalizeObject(evaluation?.evaluation_json);
    const research = evalJson.management_research || {};

    const ledgerRows = ledger.length
      ? ledger.map(row => `
          <tr>
            <td>${localDateTime(row.event_time)}</td>
            <td><strong>${esc(String(row.event_type || "").replaceAll("_", " "))}</strong></td>
            <td>${row.quantity ?? "—"}</td>
            <td>${row.price === null ? "—" : fmt(row.price, 2)}</td>
            <td>${row.stop_price === null ? "—" : fmt(row.stop_price, 2)}</td>
            <td>${esc(row.reason || "—")}</td>
            <td>${row.position_qty_after}</td>
            <td>${row.avg_entry_after === null ? "—" : fmt(row.avg_entry_after, 2)}</td>
            <td>${money(row.realized_pnl_after)}</td>
          </tr>
        `).join("")
      : `<tr><td colspan="9" class="empty-table-cell">No trade events.</td></tr>`;

    const researchRows = Object.entries(research)
      .map(([stateName, row]) => `
        <tr>
          <td>${esc(stateName.replaceAll("_", " "))}</td>
          <td>${row.n ?? 0}</td>
          <td>${row.avg_next_15m_mfe_points == null ? "—" : fmtSigned(row.avg_next_15m_mfe_points, 2)}</td>
          <td>${row.avg_next_15m_mae_points == null ? "—" : fmtSigned(row.avg_next_15m_mae_points, 2)}</td>
          <td>${row.avg_next_15m_close_return_points == null ? "—" : fmtSigned(row.avg_next_15m_close_return_points, 2)}</td>
        </tr>
      `)
      .join("");

    const r = tradeNetR(trade);

    host.innerHTML = `
      <article class="panel trade-detail-panel">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">SELECTED TRADE</p>
            <h3>${esc(trade.instrument)} ${esc(trade.direction)} · ${esc(trade.status)}</h3>
          </div>
          <div class="trade-detail-pnl">
            <strong>${money(trade.realized_pnl_dollars)}</strong>
            <span>${Number.isFinite(r) ? `${fmtSigned(r, 2)}R` : "—"}</span>
          </div>
        </div>

        <div class="trade-detail-summary">
          <div><span>Initial</span><strong>${fmt(trade.initial_entry_price, 2)}</strong></div>
          <div><span>Avg Entry</span><strong>${fmt(trade.avg_entry_price, 2)}</strong></div>
          <div><span>Avg Exit</span><strong>${trade.avg_exit_price === null ? "—" : fmt(trade.avg_exit_price, 2)}</strong></div>
          <div><span>Initial Stop</span><strong>${fmt(trade.initial_stop_price, 2)}</strong></div>
          <div><span>Max Qty</span><strong>${trade.max_contracts}</strong></div>
          <div><span>Duration</span><strong>${evaluation?.duration_minutes == null ? "—" : `${fmt(evaluation.duration_minutes, 0)}m`}</strong></div>
          <div><span>Price MFE</span><strong>${evaluation?.price_mfe_points == null ? "—" : fmtSigned(evaluation.price_mfe_points, 2)}</strong></div>
          <div><span>Price MAE</span><strong>${evaluation?.price_mae_points == null ? "—" : fmtSigned(evaluation.price_mae_points, 2)}</strong></div>
        </div>

        <div class="section-heading compact-heading">
          <div>
            <p class="eyebrow">APPEND-ONLY AUDIT TRAIL</p>
            <h3>Trade Events</h3>
          </div>
        </div>

        <div class="table-scroll">
          <table class="trade-event-ledger">
            <thead>
              <tr>
                <th>Time</th>
                <th>Event</th>
                <th>Qty</th>
                <th>Price</th>
                <th>Stop</th>
                <th>Reason</th>
                <th>Qty After</th>
                <th>Avg Entry After</th>
                <th>Realized After</th>
              </tr>
            </thead>
            <tbody>${ledgerRows}</tbody>
          </table>
        </div>

        <div class="section-heading compact-heading">
          <div>
            <p class="eyebrow">MANAGEMENT RESEARCH</p>
            <h3>What Happened After Each Management State?</h3>
          </div>
        </div>

        <div class="table-scroll">
          <table class="research-table trade-management-research-table">
            <thead>
              <tr>
                <th>State</th>
                <th>N</th>
                <th>Next 15m MFE</th>
                <th>Next 15m MAE</th>
                <th>Next 15m Close</th>
              </tr>
            </thead>
            <tbody>
              ${
                researchRows ||
                `<tr><td colspan="5" class="empty-table-cell">Backend evaluation will populate after this trade closes.</td></tr>`
              }
            </tbody>
          </table>
        </div>
      </article>
    `;
  }

  function renderTradeJournal() {
    const body = $("tradeJournalTable")?.querySelector("tbody");
    if (!body) return;

    const filter = $("tradesStatusFilter")?.value || "ALL";
    const rows = trades.filter(
      row => filter === "ALL" || row.status === filter
    );

    renderTradeStats(rows);

    body.innerHTML = rows.length
      ? rows.map(row => {
          const r = tradeNetR(row);
          return `
            <tr class="trade-journal-row${row.id === selectedTradeId ? " selected" : ""}" data-trade-id="${esc(row.id)}">
              <td>${localDateTime(row.opened_at)}</td>
              <td><strong>${esc(row.instrument)}</strong></td>
              <td class="${row.direction === "LONG" ? "positive" : "negative"}">${esc(row.direction)}</td>
              <td>${esc(row.status)}</td>
              <td>${fmt(row.initial_entry_price, 2)}</td>
              <td>${fmt(row.avg_entry_price, 2)}</td>
              <td>${row.avg_exit_price === null ? "—" : fmt(row.avg_exit_price, 2)}</td>
              <td>${row.max_contracts}</td>
              <td>${row.scale_in_count}</td>
              <td>${row.trim_count}</td>
              <td class="${Number(row.realized_pnl_dollars) > 0 ? "positive" : Number(row.realized_pnl_dollars) < 0 ? "negative" : ""}">${money(row.realized_pnl_dollars)}</td>
              <td>${Number.isFinite(r) ? `${fmtSigned(r, 2)}R` : "—"}</td>
            </tr>
          `;
        }).join("")
      : `
          <tr>
            <td colspan="12" class="empty-table-cell">
              ${
                journalAvailable
                  ? "No trades match this filter."
                  : "Trade Journal unavailable. Run the supplied Supabase migration first."
              }
            </td>
          </tr>
        `;

    renderTradeDetail();
  }

  async function refreshTradeJournal() {
    await fetchJournalData();
    renderTradeJournal();
  }

  function renderActualAnalytics(rows) {
    const statHost = $("actualTradeStatCards");
    const tableBody = $("actualTradeResearchTable")?.querySelector("tbody");

    if (!statHost || !tableBody) return;

    const net = rows.reduce(
      (sum, row) => sum + (Number(row.realized_pnl_dollars) || 0),
      0
    );

    const wins = rows.filter(row => row.win === true);

    const rValues = rows
      .map(row => Number(row.net_r_initial))
      .filter(Number.isFinite);

    const avgR = rValues.length
      ? rValues.reduce((a, b) => a + b, 0) / rValues.length
      : null;

    const pf = profitFactor(rows);

    const avg = values =>
      values.length
        ? values.reduce((a, b) => a + b, 0) / values.length
        : null;

    const mfe = avg(
      rows
        .map(row => Number(row.price_mfe_points))
        .filter(Number.isFinite)
    );

    const mae = avg(
      rows
        .map(row => Number(row.price_mae_points))
        .filter(Number.isFinite)
    );

    const cards = [
      ["Actual closed trades", rows.length, "executed trades only"],
      [
        "Actual win rate",
        rows.length ? `${fmt(100 * wins.length / rows.length, 1)}%` : "—",
        "realized P/L > 0",
      ],
      ["Actual net P/L", money(net), "saved fills"],
      [
        "Actual avg R",
        avgR === null ? "—" : `${fmtSigned(avgR, 2)}R`,
        "vs original planned risk",
      ],
      [
        "Actual profit factor",
        pf === null ? "—" : pf === Infinity ? "∞" : fmt(pf, 2),
        "gross wins ÷ gross losses",
      ],
      [
        "Actual MFE / MAE",
        `${mfe === null ? "—" : fmtSigned(mfe, 2)} / ${mae === null ? "—" : fmtSigned(mae, 2)}`,
        "initial-entry price excursion",
      ],
    ];

    statHost.innerHTML = cards
      .map(([label, value, sub]) => `
        <article class="stat-card">
          <div class="stat-label">${esc(label)}</div>
          <div class="stat-value">${esc(value)}</div>
          <div class="stat-sub">${esc(sub)}</div>
        </article>
      `)
      .join("");

    const grouped = ["MES", "MNQ"].map(instrument => {
      const sample = rows.filter(row => row.instrument === instrument);
      const sampleWins = sample.filter(row => row.win === true);
      const sampleNet = sample.reduce(
        (sum, row) => sum + (Number(row.realized_pnl_dollars) || 0),
        0
      );

      const sampleR = sample
        .map(row => Number(row.net_r_initial))
        .filter(Number.isFinite);

      const sampleMfe = sample
        .map(row => Number(row.price_mfe_points))
        .filter(Number.isFinite);

      const sampleMae = sample
        .map(row => Number(row.price_mae_points))
        .filter(Number.isFinite);

      return {
        instrument,
        n: sample.length,
        winRate:
          sample.length
            ? 100 * sampleWins.length / sample.length
            : null,
        net: sampleNet,
        avgR:
          sampleR.length
            ? sampleR.reduce((a, b) => a + b, 0) / sampleR.length
            : null,
        pf: profitFactor(sample),
        mfe:
          sampleMfe.length
            ? sampleMfe.reduce((a, b) => a + b, 0) / sampleMfe.length
            : null,
        mae:
          sampleMae.length
            ? sampleMae.reduce((a, b) => a + b, 0) / sampleMae.length
            : null,
      };
    });

    tableBody.innerHTML = grouped
      .map(row => `
        <tr>
          <td><strong>${row.instrument}</strong></td>
          <td>${row.n}</td>
          <td>${row.winRate === null ? "—" : `${fmt(row.winRate, 1)}%`}</td>
          <td>${money(row.net)}</td>
          <td>${row.avgR === null ? "—" : `${fmtSigned(row.avgR, 2)}R`}</td>
          <td>${row.pf === null ? "—" : row.pf === Infinity ? "∞" : fmt(row.pf, 2)}</td>
          <td>${row.mfe === null ? "—" : fmtSigned(row.mfe, 2)}</td>
          <td>${row.mae === null ? "—" : fmtSigned(row.mae, 2)}</td>
        </tr>
      `)
      .join("");

    const note = $("actualTradeAnalyticsNote");
    if (note) {
      note.textContent = rows.length
        ? "Actual-trade metrics come from saved Supabase fills. MFE/MAE and management-state follow-through are added by the local backend evaluator after a trade closes."
        : "No evaluated closed trades for this date yet. Trade events still appear immediately in the Trades tab.";
    }
  }

  async function refreshActualAnalytics() {
    const date = $("analyticsDate")?.value;
    const c = client();

    if (!date || !c) {
      renderActualAnalytics([]);
      return;
    }

    try {
      const { data, error } = await c
        .from("trade_evaluations")
        .select("*")
        .eq("trading_date", date)
        .order("opened_at", { ascending: true })
        .limit(200);

      if (error) throw error;

      renderActualAnalytics(data || []);
    }
    catch (error) {
      console.warn("Actual trade analytics:", error);
      renderActualAnalytics([]);
    }
  }

  function currentTrade() {
    const state = appState();
    return state?.activeTrade || null;
  }

  function managementContextForAction() {
    const detail = latestManagement;
    const state = appState();

    return {
      journal_version: JOURNAL_VERSION,
      market_snapshot_id: state?.latest?.id ?? null,
      captured_at: state?.latest?.captured_at ?? null,
      management_state: detail?.management?.managementState ?? null,
      current_price: detail?.management?.currentPrice ?? null,
      total_r_initial: detail?.management?.totalR ?? null,
      underlying_symbol: detail?.management?.underlying?.symbol ?? null,
      underlying_spot: detail?.management?.underlying?.price ?? null,
      current_target: detail?.management?.currentTarget?.strike ?? null,
      next_gex: detail?.management?.nextTarget?.strike ?? null,
      gex_state: detail?.management?.activeGexGate?.label ?? null,
      cross_market: detail?.management?.crossMarket?.label ?? null,
      tech_score: detail?.management?.techScore ?? null,
      orderflow_regime: detail?.management?.of?.shadow?.regime_bias ?? null,
      orderflow_trigger: detail?.management?.of?.shadow?.trigger_bias ?? null,
    };
  }

  function injectActiveTradeComposer() {
    const trade = currentTrade();
    const host = $("activeTradeManagement");

    if (!trade || !host || $("tradeJournalEventComposer")) {
      return;
    }

    const controls = host.querySelector(".active-trade-controls");
    if (!controls) return;

    const current = Number(
      latestManagement?.management?.currentPrice
    );

    const composer = document.createElement("div");
    composer.id = "tradeJournalEventComposer";
    composer.className = "trade-journal-event-composer";
    composer.innerHTML = `
      <div class="trade-journal-position-strip">
        <div>
          <span>OPEN QTY</span>
          <strong>${trade.openContracts}</strong>
        </div>
        <div>
          <span>AVG ENTRY</span>
          <strong>${fmt(trade.avgEntry, 2)}</strong>
        </div>
        <div>
          <span>REALIZED</span>
          <strong>${money(trade.realizedPnlDollars)}</strong>
        </div>
        <div>
          <span>SCALE / TRIM</span>
          <strong>${trade.scaleInCount} / ${trade.trimCount}</strong>
        </div>
      </div>

      <form id="tradeJournalActionForm" class="trade-journal-action-form">
        <label>
          <span>Trade Action</span>
          <select id="tradeJournalActionType" class="compact-select">
            <option value="SCALE_IN">Scale In</option>
            <option value="TRIM">Trim</option>
            <option value="EXIT">Exit Remaining</option>
            <option value="NOTE">Note Only</option>
          </select>
        </label>

        <label>
          <span>Qty</span>
          <input id="tradeJournalActionQty" type="number" min="1" step="1" value="1" />
        </label>

        <label>
          <span>Fill Price</span>
          <input id="tradeJournalActionPrice" type="number" step="0.25" value="${Number.isFinite(current) ? current.toFixed(2) : ""}" />
        </label>

        <label>
          <span>Reason</span>
          <select id="tradeJournalActionReason" class="compact-select">
            <option value="MANUAL">Manual</option>
            <option value="PULLBACK_RETEST">Pullback / Retest</option>
            <option value="GEX_ACCEPTANCE">GEX Acceptance</option>
            <option value="MODEL_STRENGTHENING">Model Strengthening</option>
            <option value="PRIMARY_TARGET">Primary Target</option>
            <option value="GEX_BRAKE">GEX Brake</option>
            <option value="PROTECT_PROFIT">Protect Profit</option>
            <option value="MODEL_DETERIORATION">Model Deterioration</option>
            <option value="STRUCTURAL_STOP">Structural Stop</option>
            <option value="END_SESSION">End of Session</option>
          </select>
        </label>

        <label class="trade-journal-notes-label">
          <span>Notes</span>
          <input id="tradeJournalActionNotes" type="text" maxlength="500" placeholder="Optional" />
        </label>

        <div class="trade-journal-action-buttons">
          <button id="tradeJournalUseCurrent" type="button" class="ghost-button">Use current</button>
          <button id="tradeJournalActionSubmit" type="submit" class="primary-button">Save scale</button>
        </div>
      </form>

      <div class="trade-journal-action-meta">
        <span>Saved to Supabase event ledger.</span>
        <button id="tradeJournalCancelActivation" type="button" class="text-button danger-text">Cancel mistaken activation</button>
      </div>
    `;

    controls.parentNode.insertBefore(
      composer,
      controls
    );

    const legacy = $("activeTradeEndLegacy");
    if (legacy) legacy.classList.add("hidden");

    updateActionFormMode();
  }

  function updateActionFormMode() {
    const trade = currentTrade();
    const type = $("tradeJournalActionType")?.value || "SCALE_IN";
    const qty = $("tradeJournalActionQty");
    const price = $("tradeJournalActionPrice");
    const submit = $("tradeJournalActionSubmit");

    if (qty) {
      qty.disabled = type === "EXIT" || type === "NOTE";
      if (type === "EXIT" && trade) {
        qty.value = String(trade.openContracts);
      }
    }

    if (price) {
      price.disabled = type === "NOTE";
    }

    if (submit) {
      submit.textContent =
        type === "SCALE_IN"
          ? "Save scale"
          : type === "TRIM"
            ? "Save trim"
            : type === "EXIT"
              ? "Save exit"
              : "Save note";
    }
  }

  async function startTradeFromForm(form) {
    const state = appState();
    const h = helpers();
    const errorNode = $("activeTradeFormError");

    if (errorNode) errorNode.textContent = "";

    if (!state?.latest || !h) {
      if (errorNode) {
        errorNode.textContent = "Current model data is not ready.";
      }
      return;
    }

    const instrument = $("activeTradeInstrument")?.value;
    const direction = $("activeTradeDirection")?.value;
    const entry = Number($("activeTradeEntry")?.value);
    const stop = Number($("activeTradeStop")?.value);
    const contracts = Number($("activeTradeContracts")?.value);

    if (
      !["MES", "MNQ"].includes(instrument) ||
      !["LONG", "SHORT"].includes(direction) ||
      !Number.isFinite(entry) ||
      !Number.isFinite(stop) ||
      !Number.isInteger(contracts) ||
      contracts <= 0
    ) {
      if (errorNode) {
        errorNode.textContent = "Enter valid trade details.";
      }
      return;
    }

    const validStop =
      direction === "LONG"
        ? stop < entry
        : stop > entry;

    if (!validStop) {
      if (errorNode) {
        errorNode.textContent =
          direction === "LONG"
            ? "LONG structural stop must be below entry."
            : "SHORT structural stop must be above entry.";
      }
      return;
    }

    const button = form.querySelector('button[type="submit"]');
    if (button) {
      button.disabled = true;
      button.textContent = "Saving…";
    }

    try {
      const entryContext = h.captureEntryContext(
        state.latest,
        instrument,
        direction
      );

      await rpc(
        "start_trade",
        {
          p_instrument: instrument,
          p_direction: direction,
          p_entry_price: entry,
          p_stop_price: stop,
          p_contracts: contracts,
          p_market_snapshot_id: state.latest.id ?? null,
          p_entry_context: entryContext,
          p_notes: null,
        }
      );

      await syncActiveTrade();
      await fetchJournalData();

      toast(`${instrument} ${direction} saved to Supabase`);

    } catch (error) {
      console.error(error);

      if (errorNode) {
        errorNode.textContent = error.message || "Trade could not be saved.";
      }
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = "Activate trade";
      }
    }
  }

  async function saveAction(form) {
    const trade = currentTrade();
    const state = appState();
    const type = $("tradeJournalActionType")?.value || "";
    const qty = Number($("tradeJournalActionQty")?.value);
    const price = Number($("tradeJournalActionPrice")?.value);
    const reason = $("tradeJournalActionReason")?.value || "MANUAL";
    const notes = $("tradeJournalActionNotes")?.value?.trim() || null;

    if (!trade?.id || !state?.latest) return;

    const effectiveQty =
      type === "EXIT" || type === "NOTE"
        ? null
        : qty;

    const effectivePrice =
      type === "NOTE"
        ? null
        : price;

    if (
      ["SCALE_IN", "TRIM"].includes(type) &&
      (!Number.isInteger(effectiveQty) || effectiveQty <= 0)
    ) {
      toast("Scale/trim quantity must be a positive whole number");
      return;
    }

    if (
      type === "TRIM" &&
      effectiveQty >= trade.openContracts
    ) {
      toast("Trim must leave at least one contract; use Exit Remaining to close");
      return;
    }

    if (
      ["SCALE_IN", "TRIM", "EXIT"].includes(type) &&
      (!Number.isFinite(effectivePrice) || effectivePrice <= 0)
    ) {
      toast("Enter the actual futures fill price");
      return;
    }

    const submit = $("tradeJournalActionSubmit");
    if (submit) {
      submit.disabled = true;
      submit.textContent = "Saving…";
    }

    try {
      await rpc(
        "add_trade_event",
        {
          p_trade_id: trade.id,
          p_event_type: type,
          p_quantity: effectiveQty,
          p_price: effectivePrice,
          p_stop_price: null,
          p_reason: reason,
          p_notes: notes,
          p_market_snapshot_id: state.latest.id ?? null,
          p_context: managementContextForAction(),
        }
      );

      await syncActiveTrade();
      await fetchJournalData();
      renderTradeJournal();

      toast(
        type === "EXIT"
          ? "Final exit saved to Supabase"
          : `${type.replaceAll("_", " ")} saved to Supabase`
      );

    } catch (error) {
      console.error(error);
      toast(error.message || "Trade action could not be saved");
    } finally {
      if (submit && document.body.contains(submit)) {
        submit.disabled = false;
      }
    }
  }

  async function saveStopUpdate(form) {
    const trade = currentTrade();
    const state = appState();
    const h = helpers();

    if (!trade?.id || !state?.latest || !h) return;

    const newStop = Number($("activeTradeNewStop")?.value);
    const current = Number(
      h.futuresPrice(
        state.latest,
        trade.instrument
      )?.price
    );

    if (!Number.isFinite(newStop) || !Number.isFinite(current)) {
      toast("Valid stop and current futures price are required");
      return;
    }

    const oldStop = Number(trade.currentStop);

    const tightens =
      trade.direction === "LONG"
        ? newStop >= oldStop && newStop < current
        : newStop <= oldStop && newStop > current;

    if (!tightens) {
      toast(
        trade.direction === "LONG"
          ? "LONG stop may tighten upward only and must stay below current price"
          : "SHORT stop may tighten downward only and must stay above current price"
      );
      return;
    }

    const button = form.querySelector('button[type="submit"]');
    if (button) button.disabled = true;

    try {
      await rpc(
        "add_trade_event",
        {
          p_trade_id: trade.id,
          p_event_type: "STOP_UPDATE",
          p_quantity: null,
          p_price: null,
          p_stop_price: newStop,
          p_reason: "STRUCTURE_UPDATE",
          p_notes: null,
          p_market_snapshot_id: state.latest.id ?? null,
          p_context: managementContextForAction(),
        }
      );

      await syncActiveTrade();
      await fetchJournalData();
      toast(`Structural stop saved at ${fmt(newStop, 2)}`);

    } catch (error) {
      console.error(error);
      toast(error.message || "Stop update could not be saved");
    } finally {
      if (button && document.body.contains(button)) {
        button.disabled = false;
      }
    }
  }

  async function cancelMistakenActivation() {
    const trade = currentTrade();
    const state = appState();

    if (!trade?.id) return;

    const okay = window.confirm(
      "Cancel only if this trade was activated by mistake. Trades with scale/trim activity cannot be cancelled."
    );

    if (!okay) return;

    try {
      await rpc(
        "add_trade_event",
        {
          p_trade_id: trade.id,
          p_event_type: "CANCEL",
          p_quantity: null,
          p_price: null,
          p_stop_price: null,
          p_reason: "MISTAKEN_ACTIVATION",
          p_notes: null,
          p_market_snapshot_id: state?.latest?.id ?? null,
          p_context: managementContextForAction(),
        }
      );

      await syncActiveTrade();
      await fetchJournalData();
      renderTradeJournal();
      toast("Mistaken activation cancelled");

    } catch (error) {
      console.error(error);
      toast(error.message || "Trade could not be cancelled");
    }
  }

  async function recordManagement(detail) {
    const trade = detail?.trade;
    const management = detail?.management;

    if (
      !trade?.id ||
      !management ||
      management.snapshotId === null ||
      !journalAvailable
    ) {
      return;
    }

    latestManagement = detail;

    const payload = {
      management_state: management.managementState,
      current_price: management.currentPrice,
      open_qty: trade.openContracts ?? trade.contracts,
      avg_entry_price: trade.avgEntry ?? trade.entry,
      unrealized_pnl_dollars: management.openDollars,
      realized_pnl_dollars: trade.realizedPnlDollars || 0,
      total_pnl_dollars: management.totalPnlDollars,
      open_r_initial: management.openR,
      total_r_initial: management.totalR,
      underlying_symbol: management.underlying?.symbol ?? null,
      underlying_spot: management.underlying?.price ?? null,
      entry_target: trade.entryContext?.target?.strike ?? null,
      current_target: management.currentTarget?.strike ?? null,
      next_gex: management.nextTarget?.strike ?? null,
      market_condition: management.marketCondition?.condition ?? null,
      gex_state: management.activeGexGate?.label ?? null,
      cross_market: management.crossMarket?.label ?? null,
      tech_score: management.techScore ?? null,
      orderflow_regime: management.of?.shadow?.regime_bias ?? null,
      orderflow_trigger: management.of?.shadow?.trigger_bias ?? null,
      invalidation_categories: management.invalidationCategories.map(row => row.key),
      warnings: management.warnings,
      action: management.action,
      continuation_watch: management.continuationWatch,
    };

    try {
      await rpc(
        "record_trade_management_snapshot",
        {
          p_trade_id: trade.id,
          p_market_snapshot_id: management.snapshotId,
          p_captured_at: management.capturedAt,
          p_payload: payload,
        }
      );
    }
    catch (error) {
      console.warn("Trade management snapshot write:", error);
    }

    setTimeout(injectActiveTradeComposer, 0);
  }

  // Capture phase intentionally supersedes the legacy browser-local write path.
  document.addEventListener(
    "submit",
    event => {
      const form = event.target;

      if (form?.id === "activeTradeForm") {
        event.preventDefault();
        event.stopImmediatePropagation();
        void startTradeFromForm(form);
        return;
      }

      if (form?.id === "activeTradeStopUpdateForm") {
        event.preventDefault();
        event.stopImmediatePropagation();
        void saveStopUpdate(form);
        return;
      }

      if (form?.id === "tradeJournalActionForm") {
        event.preventDefault();
        void saveAction(form);
      }
    },
    true
  );

  document.addEventListener(
    "change",
    event => {
      if (event.target?.id === "tradeJournalActionType") {
        updateActionFormMode();
      }

      if (event.target?.id === "tradesStatusFilter") {
        renderTradeJournal();
      }

      if (event.target?.id === "analyticsDate") {
        void refreshActualAnalytics();
      }
    }
  );

  document.addEventListener(
    "click",
    event => {
      const tradesButton = event.target.closest?.('[data-tab="trades"]');
      if (tradesButton) {
        void refreshTradeJournal();
      }

      const analyticsButton = event.target.closest?.('[data-tab="analytics"]');
      if (analyticsButton) {
        setTimeout(() => void refreshActualAnalytics(), 0);
      }

      if (event.target.closest?.("#tradesRefreshButton")) {
        void refreshTradeJournal().then(() => toast("Trade Journal refreshed"));
      }

      const tradeRow = event.target.closest?.(".trade-journal-row");
      if (tradeRow?.dataset.tradeId) {
        selectedTradeId = tradeRow.dataset.tradeId;
        renderTradeJournal();
      }

      if (event.target.closest?.("#tradeJournalUseCurrent")) {
        const current = Number(
          latestManagement?.management?.currentPrice
        );
        const input = $("tradeJournalActionPrice");
        if (input && Number.isFinite(current)) {
          input.value = current.toFixed(2);
        }
      }

      if (event.target.closest?.("#tradeJournalCancelActivation")) {
        void cancelMistakenActivation();
      }
    }
  );

  window.addEventListener(
    "fm-active-trade-management",
    event => {
      latestManagement = event.detail || null;
      void recordManagement(event.detail);
      setTimeout(injectActiveTradeComposer, 0);
    }
  );

  window.addEventListener(
    "fm-active-trade-live-price",
    event => {
      latestManagement = event.detail || null;
      setTimeout(injectActiveTradeComposer, 0);
    }
  );

  window.addEventListener(
    "fm-orderflow-state-updated",
    () => {
      if ($("tab-trades")?.classList.contains("active")) {
        setTimeout(() => void refreshTradeJournal(), 0);
      }
    }
  );

  async function waitForAuthenticatedClient() {
    if (booted) return;

    const c = client();
    const h = helpers();

    if (!c || !h) {
      setTimeout(waitForAuthenticatedClient, 200);
      return;
    }

    try {
      const { data } = await c.auth.getSession();

      if (!data?.session) {
        setTimeout(waitForAuthenticatedClient, 400);
        return;
      }

      booted = true;

      await syncActiveTrade();
      await fetchJournalData();

      if ($("tab-trades")?.classList.contains("active")) {
        renderTradeJournal();
      }

      setTimeout(() => void refreshActualAnalytics(), 0);

    } catch (_error) {
      setTimeout(waitForAuthenticatedClient, 500);
    }
  }

  waitForAuthenticatedClient();
})();
