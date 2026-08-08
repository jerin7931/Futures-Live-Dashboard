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


  // ==========================================================
  // INFO / HELP SYSTEM
  // ==========================================================
  const INFO_TEXT = {
    instrument_selection:
      "Compares MES and MNQ using the Attraction Engine's weighted directional inputs. Tradeability measures how strongly those inputs align. It is a confluence/confidence score, not a probability of winning.",
    model_bias:
      "Directional lean from the model. STRONG BULLISH/BULLISH means the weighted inputs lean upward; BEARISH/STRONG BEARISH means they lean downward; MIXED means the inputs are not aligned enough for a directional call. It is context, not an entry signal.",
    tradeability:
      "Tradeability is a 0–100 confluence score. Higher means GEX, options flow and technicals are more strongly aligned. LOW = 0–39, MODERATE = 40–59, HIGH = 60–74, VERY HIGH = 75–100. It is not a calibrated win probability.",
    directional_value:
      "Normalized directional input on a -1 to +1 scale. +1 is maximum bullish support, -1 is maximum bearish support, and 0 is neutral/no directional contribution. The number displayed on the MES/MNQ card is this source direction value before its model weight is applied.",
    weighted_contribution:
      "The source direction value multiplied by its assigned model weight. Weighted contributions are added to produce the instrument's final directional value.",
    spx_gex_score:
      "Normalized SPX GEX directional score used in the MES model. Positive favors upside structure; negative favors downside structure; near zero means relatively balanced GEX. This is NOT raw GEX dollars. MES model weight: 35%.",
    spy_gex_score:
      "Normalized SPY GEX directional score used as secondary MES confirmation. Positive favors upside; negative favors downside; near zero means little directional influence. This is NOT raw GEX. MES model weight: 7.5%.",
    qqq_gex_score:
      "Normalized QQQ GEX directional score used in the MNQ model. Positive favors upside structure; negative favors downside structure; near zero means relatively balanced GEX. This is NOT raw GEX. MNQ model weight: 40%.",
    spx_flow_score:
      "Normalized SPX Flowline direction used by MES. It summarizes call/put flow on a -1 to +1 scale: +1 strongest bullish, -1 strongest bearish, 0 neutral/stale/insufficient. MES model weight: 25%.",
    spy_flow_score:
      "Normalized SPY Flowline direction used only as secondary MES confirmation. It should add or subtract modest confluence rather than override strong SPX + MES agreement. MES model weight: 7.5%.",
    qqq_flow_score:
      "Normalized QQQ Flowline direction used by MNQ. +1 is strongest bullish flow, -1 strongest bearish flow, and 0 neutral/stale/insufficient. MNQ model weight: 30%.",
    mes_tech_score:
      "Normalized MES technical direction used in the MES model. It comes primarily from the 5-minute technical score and is clipped to a -1 to +1 range. MES model weight: 25%.",
    mnq_tech_score:
      "Normalized MNQ technical direction used in the MNQ model. It comes primarily from the 5-minute technical score and is clipped to a -1 to +1 range. MNQ model weight: 30%.",
    preferred:
      "Preferred means this instrument has the stronger tradeability score and satisfies the model preference rules. If both scores are below 40, there is NO CLEAR PREFERENCE. Scores within 7.5 points are considered SIMILAR.",
    mtf_section:
      "Technical context across 5m, 15m, 30m, 1H, 2H and 4H. Each timeframe evaluates price vs VWAP/EMA9/EMA21, EMA alignment, recent slope and momentum to produce a bias and technical score.",
    timeframe_bias:
      "Overall technical direction for this timeframe. STRONG BULLISH/BULLISH means technical scoring inputs favor upside; BEARISH/STRONG BEARISH favor downside; MIXED means the score is too balanced for a directional classification.",
    technical_score:
      "Technical score from VWAP, EMA position/alignment, EMA/VWAP direction and timeframe momentum. Positive is bullish, negative is bearish. +7 or higher = STRONG BULLISH; +3 to +6 = BULLISH; -3 to -6 = BEARISH; -7 or lower = STRONG BEARISH.",
    vwap:
      "RTH VWAP is the volume-weighted average price calculated from the 8:30 AM CT cash-session reset. RISING/FALLING describes its recent slope. Price above/below VWAP is also part of the technical score.",
    ema9:
      "EMA9 is the faster exponential moving average. RISING suggests short-term trend/momentum is lifting; FALLING suggests it is weakening; FLAT means the recent slope is very small.",
    ema21:
      "EMA21 is the slower trend filter. Its direction and relationship to EMA9 help show whether the short-term move is aligned with the broader intraday trend.",
    price_change_15m:
      "Net price change from the latest completed 5-minute close versus the close 15 minutes earlier. Positive = price rose; negative = price fell.",
    price_change_30m:
      "Net price change from the latest completed 5-minute close versus the close 30 minutes earlier.",
    price_change_45m:
      "Net price change from the latest completed 5-minute close versus the close 45 minutes earlier.",
    forming_bar:
      "Execution-level calculations exclude a currently forming 5-minute candle. Higher-timeframe bias may use the currently forming higher-timeframe bar so the dashboard reflects current structure without contaminating the base 5-minute execution data.",
    options_positioning:
      "SPX, SPY and QQQ options-positioning map. SPX is the primary GEX/Flowline source for MES; SPY is secondary confirmation. QQQ is the primary GEX/Flowline source for MNQ.",
    spot:
      "Underlying spot price captured from Tradytics for this cycle. GEX levels, distances and attraction targets are evaluated relative to this price.",
    net_attraction_bias:
      "Compares the strongest upside and downside attraction scores. Upside minus downside of +15 or more = BULLISH; -15 or less = BEARISH; between those thresholds = MIXED/NEUTRAL.",
    attraction_target:
      "Primary level on this side of spot with the highest Attraction Engine score. It is an important interaction/destination candidate, not a guaranteed target.",
    attraction_score:
      "0–100 model-implied attraction/confluence score for reaching or interacting with this level. V1 combines GEX structure 40%, GEX change 15%, Flowline 20%, technicals 20% and path quality 5%. It is not a calibrated probability.",
    attraction_confidence:
      "Label for the attraction score: LOW 0–39, MODERATE 40–59, HIGH 60–74, VERY HIGH 75–100.",
    reaction:
      "Expected behavior if price reaches the level. Negative GEX is treated as an acceleration zone IF price is accepted through it. Positive GEX is treated as a braking/support-resistance area. Negative GEX is not automatically a magnet.",
    flowline:
      "Tradytics options-flow state. The model tracks Calls and Puts over a rolling 15-minute window, estimates their direction/slope and classifies the combination as bullish, bearish, mixed, cooling or neutral.",
    calls_direction:
      "Direction of Calls flow over the rolling 15-minute window. RISING = call flow increasing; FALLING = decreasing; FLAT = little meaningful change.",
    puts_direction:
      "Direction of Puts flow over the rolling 15-minute window. RISING = put flow increasing; FALLING = decreasing; FLAT = little meaningful change. Interpretation depends on Calls at the same time.",
    flow_bias:
      "Combined Calls/Puts classification. Calls rising + Puts falling = STRONG BULLISH; Calls falling + Puts rising = STRONG BEARISH. Stale flow is neutralized rather than treated as live.",
    spot_state:
      "Plain-English description of where spot sits relative to important GEX. Examples: near negative-GEX acceleration, active negative-GEX instability, near positive-GEX brake, or between major GEX levels.",
    gex_chart:
      "Horizontal bars show ranked GEX levels around spot. Red = negative GEX; green = positive GEX. Bar length represents absolute GEX magnitude. This is a structure/context map, not a direct trade signal.",
    raw_gex:
      "Actual GEX magnitude from Tradytics, displayed in millions or billions. Positive/negative signs are preserved. This differs from the normalized -1 to +1 GEX directional score on the MES/MNQ cards.",
    gex_strike:
      "Underlying option strike associated with this GEX level.",
    relation:
      "Whether the GEX strike is ABOVE_PRICE, BELOW_PRICE or AT_PRICE relative to the captured spot price.",
    distance:
      "Absolute point distance between spot and this GEX strike. Smaller distance means the level is closer to current price.",
    priority:
      "Importance ranking from the GEX Context Engine. It combines proximity, GEX magnitude, temporal change and dominant-level status. VERY HIGH/HIGH levels deserve more attention than MODERATE/LOW levels.",
    gex_context:
      "Model interpretation of the GEX level. Negative GEX above/below spot is an upside/downside acceleration zone if accepted; positive GEX is a potential brake/support/resistance area.",
    temporal_change:
      "How the strike changed versus the previous GEX snapshot: strengthening, weakening, sign flip, new level, disappeared level or unchanged. Materiality thresholds differ by SPX, SPY and QQQ.",
    flow_history:
      "Session history of Calls and Puts Flowline values captured every 15 minutes. It helps distinguish persistent flow strengthening/weakening from a one-snapshot reading.",
    attraction_history:
      "Session history of primary upside and downside attraction scores. Rising score means that side's selected target is gaining model confluence; falling score means attraction is weakening.",
    tradeability_history:
      "MES and MNQ tradeability scores through the session, showing when model confluence strengthened, weakened or diverged between instruments.",
    bias_distribution:
      "How many saved MES/MNQ snapshots were classified as strong bullish, bullish, mixed, bearish or strong bearish during the selected session.",
    model_performance:
      "Research view for evaluating whether model scores and directional calls were useful. Live model scores remain confidence/confluence measures until enough outcomes exist to calibrate them.",
    directional_accuracy:
      "Percentage of evaluated predictions whose model direction matched subsequent price movement for each horizon, such as 15, 30, 45 or 60 minutes. Requires model_outcomes data.",
    calibration:
      "Compares model-score buckets with observed target-hit rates. Over enough observations this can tell us whether a score such as 75 corresponds to a repeatable empirical hit rate.",
    outcomes:
      "Post-session evaluation containing returns, maximum favorable/adverse excursion and target-hit behavior for saved predictions. It remains empty until the EOD evaluator populates model_outcomes.",
    outcome_instrument:
      "Execution instrument being evaluated: MES or MNQ.",
    model_score:
      "Tradeability/confidence score that existed at prediction time. It is not automatically a win probability.",
    horizon:
      "How many minutes after the saved prediction the outcome measurement covers, such as 15m, 30m, 45m or 60m.",
    return_points:
      "Instrument price change from prediction time to the end of the selected evaluation horizon, measured in points.",
    mfe:
      "Maximum Favorable Excursion: the largest favorable move in points after the prediction during the evaluation window.",
    mae:
      "Maximum Adverse Excursion: the largest move against the prediction during the evaluation window.",
    bias_correct:
      "Whether subsequent price movement agreed with the model's recorded directional bias for the evaluation horizon.",
    target:
      "The SPX/SPY/QQQ attraction target associated with the evaluated prediction.",
    target_hit:
      "Whether price actually touched the evaluated attraction target during the specified outcome window.",
    target_hit_minutes:
      "Elapsed minutes from the prediction snapshot until the target was first touched.",
    gex_ladder:
      "Full ranked GEX ladder for the selected symbol and snapshot. Sort it to inspect strike, |GEX|, priority or distance rather than only the compact levels on the Live card.",
    raw_json:
      "Exact structured snapshot stored in Supabase. Useful for debugging, model research and exporting the state without relying on the visual dashboard.",
    live_status:
      "LIVE means the newest database snapshot is recent enough for the dashboard freshness rule. STALE means the latest uploaded snapshot is older than the expected live window.",
    next_expected:
      "Expected next database update based on the 15-minute collection cadence. It is an expected time, not a guarantee that the next capture will succeed.",
    history:
      "Replay a saved 15-minute snapshot exactly as it was stored. This prevents hindsight contamination when reviewing what the model knew at a specific time.",
    preferred_instrument:
      "The model's preferred instrument after comparing MES and MNQ tradeability. NO CLEAR PREFERENCE means both scores are below 40; SIMILAR means their scores are within 7.5 points."
  };

  function infoIcon(key, label = "More information") {
    if (!INFO_TEXT[key]) return "";

    /*
      IMPORTANT:
      Use a non-button element for the small info icon.

      Some dashboard components (especially each multi-timeframe cell)
      are already clickable <button> elements. Putting an <button>
      info icon inside another <button> creates invalid nested-button
      HTML. Browsers then repair the DOM automatically, which was
      stretching the 5m/15m/30m/1H/2H/4H cells vertically.

      A span still supports our delegated hover/tap tooltip behavior
      without changing the surrounding card layout.
    */
    return `
      <span
        class="info-icon"
        data-info-key="${key}"
        aria-label="${label}"
        aria-describedby="infoTooltip">i</span>
    `;
  }

  function hydrateStaticInfoIcons(root = document) {
    root.querySelectorAll(".static-info[data-info-key]").forEach(node => {
      const key = node.dataset.infoKey;
      node.outerHTML = infoIcon(key);
    });
  }

  function hideInfoTooltip() {
    const tip = $("infoTooltip");
    if (!tip) return;
    tip.classList.add("hidden");
    tip.textContent = "";
    document.querySelectorAll(".info-icon.active")
      .forEach(x => x.classList.remove("active"));
  }

  function showInfoTooltip(icon) {
    const key = icon?.dataset?.infoKey;
    const textValue = INFO_TEXT[key];
    const tip = $("infoTooltip");
    if (!textValue || !tip) return;

    document.querySelectorAll(".info-icon.active")
      .forEach(x => x.classList.remove("active"));
    icon.classList.add("active");

    tip.textContent = textValue;
    tip.classList.remove("hidden");

    const rect = icon.getBoundingClientRect();
    const pad = 10;
    const width = Math.min(360, window.innerWidth - 2 * pad);
    tip.style.width = `${width}px`;

    const tipRect = tip.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - tipRect.width / 2;
    left = Math.max(pad, Math.min(left, window.innerWidth - tipRect.width - pad));

    let top = rect.top - tipRect.height - 10;
    if (top < pad) top = rect.bottom + 10;

    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  function initInfoSystem() {
    hydrateStaticInfoIcons();

    document.addEventListener("mouseover", event => {
      const icon = event.target.closest(".info-icon");
      if (icon) showInfoTooltip(icon);
    });

    document.addEventListener("focusin", event => {
      const icon = event.target.closest?.(".info-icon");
      if (icon) showInfoTooltip(icon);
    });

    document.addEventListener("mouseout", event => {
      const icon = event.target.closest(".info-icon");
      if (icon && !icon.matches(":focus")) hideInfoTooltip();
    });

    document.addEventListener("focusout", event => {
      const icon = event.target.closest?.(".info-icon");
      if (icon) hideInfoTooltip();
    });

    document.addEventListener("click", event => {
      const icon = event.target.closest(".info-icon");

      if (icon) {
        event.preventDefault();
        event.stopPropagation();

        if (
          icon.classList.contains("active") &&
          !$("infoTooltip").classList.contains("hidden")
        ) {
          hideInfoTooltip();
        } else {
          showInfoTooltip(icon);
        }
        return;
      }

      if (!event.target.closest("#infoTooltip")) hideInfoTooltip();
    });

    window.addEventListener("resize", hideInfoTooltip);
    window.addEventListener("scroll", hideInfoTooltip, true);
  }

  function componentInfoKey(componentName) {
    const key = String(componentName || "").toUpperCase();
    const map = {
      SPX_GEX: "spx_gex_score",
      SPY_GEX: "spy_gex_score",
      QQQ_GEX: "qqq_gex_score",
      SPX_FLOW: "spx_flow_score",
      SPY_FLOW: "spy_flow_score",
      QQQ_FLOW: "qqq_flow_score",
      MES_TECH: "mes_tech_score",
      MNQ_TECH: "mnq_tech_score",
    };
    return map[key] || "directional_value";
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

    state.latest = data?.[0] || null;
    state.selected = state.latest;
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

    state.daySnapshots = data || [];
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
            ${esc(key.replaceAll("_", " "))}
            ${infoIcon(componentInfoKey(key), `What does ${key.replaceAll("_", " ")} mean?`)}:
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
                ${infoIcon("model_bias", "What does model bias mean?")}
              </div>
            </div>
            <div>
              <div class="tradeability-number">${fmt(row.tradeability_score, 1)} ${infoIcon("tradeability", "What does tradeability mean?")}</div>
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
              <div class="tf-label">${tf.toUpperCase()} ${infoIcon("timeframe_bias", `What does ${tf.toUpperCase()} bias mean?`)}</div>
              <div class="tf-bias ${biasClass(bias)}">${esc(shortBias(bias))}</div>
              <div class="tiny muted">score ${tfRow?.technical_score ?? "—"} ${infoIcon("technical_score", "What does the technical score mean?")}</div>
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
              ${row.incomplete_last_bar_dropped ? "FORMING 5m DROPPED" : "COMPLETED 5m"} ${infoIcon("forming_bar", "How are forming candles handled?")}
            </span>
          </div>

          <div class="mtf-grid">${tfHtml}</div>

          <div class="tech-meta">
            ${metaItem("VWAP", row.vwap_direction, "vwap")}
            ${metaItem("EMA9", row.ema9_direction, "ema9")}
            ${metaItem("EMA21", row.ema21_direction, "ema21")}
            ${metaItem("15m", fmtSigned(row.price_change_15m), "price_change_15m")}
            ${metaItem("30m", fmtSigned(row.price_change_30m), "price_change_30m")}
            ${metaItem("45m", fmtSigned(row.price_change_45m), "price_change_45m")}
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

  function metaItem(label, value, infoKey = null) {
    const klass =
      String(value || "").includes("RISING") ? "positive" :
      String(value || "").includes("FALLING") ? "negative" :
      typeof value === "string" && value.startsWith("+") ? "positive" :
      typeof value === "string" && value.startsWith("-") ? "negative" : "";

    return `
      <div class="meta-item">
        <div class="label">
          ${esc(label)}
          ${infoKey ? infoIcon(infoKey, `What does ${label} mean?`) : ""}
        </div>
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
              <div class="spot">Spot ${infoIcon("spot", "What does spot mean?")} <strong>${fmt(gex.price, symbol === "SPX" ? 1 : 2)}</strong></div>
            </div>
            <span class="badge ${biasClass(netBias) === "positive" ? "good" : biasClass(netBias) === "negative" ? "bad" : "warn"}">
              ${esc(String(netBias).replaceAll("_", " "))}
              ${infoIcon("net_attraction_bias", "What does net attraction bias mean?")}
            </span>
          </div>

          <div class="target-grid">
            ${targetBox("UP TARGET", up, "positive")}
            ${targetBox("DOWN TARGET", down, "negative")}
          </div>

          <div class="flow-row">
            <div>
              <div class="flow-label">FLOWLINE ${infoIcon("flowline", "What is Flowline?")}</div>
              <div class="flow-value ${flowStale ? "muted" : biasClass(flowBias)}">
                ${esc(String(flowBias).replaceAll("_", " "))}
                ${infoIcon("flow_bias", "How is Flowline bias classified?")}
              </div>
            </div>
            <div class="tiny muted">
              Calls ${esc(flow?.calls?.direction || "—")} ${infoIcon("calls_direction", "What does Calls direction mean?")} ·
              Puts ${esc(flow?.puts?.direction || "—")} ${infoIcon("puts_direction", "What does Puts direction mean?")}
            </div>
          </div>

          <div class="model-row">
            <div class="flow-label">SPOT STATE ${infoIcon("spot_state", "What does spot state mean?")}</div>
            <div class="flow-value">${esc(String(attraction?.spot_state || "N/A").replaceAll("_", " "))}</div>
          </div>

          <div class="tiny muted chart-help-label">
            GEX STRUCTURE ${infoIcon("gex_chart", "How do I read this GEX chart?")}
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
          <div class="target-side">${label} ${infoIcon("attraction_target", "What does this target mean?")}</div>
          <div class="target-strike">N/A</div>
        </div>
      `;
    }

    return `
      <div class="target-box">
        <div class="target-side">${label} ${infoIcon("attraction_target", "What does this target mean?")}</div>
        <div class="target-strike ${className}">${esc(row.strike)}</div>
        <div class="target-score">
          ${fmt(row.attraction_score, 0)}
          ${infoIcon("attraction_score", "What does the attraction score mean?")}
          ·
          ${esc(String(row.attraction_confidence || "").replaceAll("_", " "))}
          ${infoIcon("attraction_confidence", "What does this confidence label mean?")}
        </div>
        <div class="reaction">
          ${esc(reactionShort(row.reaction))}
          ${infoIcon("reaction", "What does this reaction label mean?")}
        </div>
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
              <th>Strike ${infoIcon("gex_strike")}</th>
              <th>GEX ${infoIcon("raw_gex")}</th>
              <th>Relation ${infoIcon("relation")}</th>
              <th>Distance ${infoIcon("distance")}</th>
              <th>Priority ${infoIcon("priority")}</th>
              <th>Context ${infoIcon("gex_context")}</th>
              <th>Temporal ${infoIcon("temporal_change")}</th>
              <th>Score ${infoIcon("priority")}</th>
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
            ${esc(key.replaceAll("_", " "))}
            ${infoIcon(
              key === "gex_structure" ? "priority" :
              key === "gex_change" ? "temporal_change" :
              key === "flowline" ? "flowline" :
              key === "technicals" ? "mtf_section" :
              "attraction_score"
            )}:
            <strong>${fmt(value, 1)}</strong>
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

    state.selected = row || null;

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
      ["Avg MES tradeability", fmt(avg(mesScores), 1), `${mesScores.length} snapshots`, "tradeability"],
      ["Avg MNQ tradeability", fmt(avg(mnqScores), 1), `${mnqScores.length} snapshots`, "tradeability"],
      ["Directional accuracy", accuracy === null ? "—" : `${fmt(accuracy, 1)}%`, `${correctnessRows.length} outcomes`, "directional_accuracy"],
      ["Target hit rate", hitRate === null ? "—" : `${fmt(hitRate, 1)}%`, `${targetRows.length} evaluated targets`, "target_hit"],
      ["Average MFE", fmtSigned(mfe), "points", "mfe"],
      ["Average MAE", fmtSigned(mae), "points", "mae"],
      ["Snapshots", snapshots.length, "selected trading date", "history"],
      ["Evaluated rows", outcomes.length, "model_outcomes", "outcomes"],
    ];

    $("analyticsStatCards").innerHTML = cards.map(([label, value, sub, infoKey]) => `
      <article class="stat-card">
        <div class="stat-label">${esc(label)} ${infoIcon(infoKey)}</div>
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

    $("connectionStatus").innerHTML = `${isFresh ? "Live data" : "Snapshot stale"} ${infoIcon("live_status")}`;
    $("liveDot").className = `status-dot ${isFresh ? "online" : "stale"}`;
    $("lastUpdateText").textContent = localDateTime(state.latest.captured_at);

    const next = new Date(new Date(state.latest.captured_at).getTime() + 15 * 60000);
    $("nextUpdateText").innerHTML = `${localTime(next)} ${infoIcon("next_expected")}`;
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

  initInfoSystem();
  initAuth();
})();
