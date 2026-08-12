(() => {
  "use strict";

  const HELP = {
    model_bias:
      "Directional lean from the production model. Bullish means the weighted inputs favor upside, bearish means they favor downside, and mixed means there is not enough alignment for a directional lean. This is context, not an entry signal.",
    tradeability:
      "Tradeability is the production model's 0–100 confluence score. Higher values mean GEX, options flow and technicals are more strongly aligned. It is not a calibrated win probability.",
    component:
      "This component is normalized to a directional value from -1 to +1. Positive supports bullish direction, negative supports bearish direction, and values near zero add little directional influence.",
    mtf_bias:
      "Technical bias for this timeframe using price relative to VWAP, EMA9 and EMA21, plus EMA alignment, direction and momentum. Higher timeframes provide structure; the 5-minute layer remains the execution-level technical input.",
    technical_score:
      "Technical score summarizes VWAP, EMA position/alignment, slope and timeframe momentum. Positive values are bullish, negative values bearish, and values near zero are mixed.",
    forming_bar:
      "The forming 5-minute candle is excluded from execution calculations. Higher-timeframe context may include its current forming bar by design.",
    vwap:
      "RTH VWAP is the volume-weighted average price from the 8:30 AM CT cash-session reset. Rising or falling describes its recent direction.",
    ema9:
      "EMA9 is the faster exponential moving average and reflects shorter-term trend and momentum.",
    ema21:
      "EMA21 is the slower trend filter. Its direction and relationship to EMA9 help show whether short-term movement is aligned with broader intraday structure.",
    price_change:
      "Net futures price change over the labeled lookback window using the saved technical data for this cycle.",
    spot:
      "Underlying spot price captured for this cycle. GEX distances and attraction targets are evaluated relative to this price.",
    net_attraction:
      "Compares upside and downside attraction. Bullish means upside attraction is materially stronger; bearish means downside is stronger; mixed means neither side has enough advantage.",
    attraction_target:
      "Primary level on this side of spot with the highest Attraction Engine score. It is an important destination or interaction candidate, not a guaranteed target.",
    attraction_score:
      "The 0–100 attraction/confluence score for this level. It measures model importance, not the true probability that price reaches the strike.",
    attraction_confidence:
      "Confidence is a bucket derived from the attraction score: Low, Moderate, High or Very High. It is not a calibrated probability.",
    reaction:
      "Expected interaction if price reaches the level. Negative GEX is treated as an acceleration zone if accepted through; positive GEX is treated as a potential braking, support or resistance area.",
    flowline:
      "Tradytics options-flow state over the rolling Flowline window. Calls and puts are classified by direction and combined into bullish, bearish, mixed, cooling or neutral flow.",
    calls_puts:
      "Calls and Puts show the recent direction of their Flowline series. Rising calls generally support bullish pressure; rising puts generally support bearish pressure, but the combined Flowline bias is the primary interpretation.",
    spot_state:
      "Plain-English description of where spot is located relative to the strongest nearby GEX structure.",
    gex_chart:
      "The horizontal histogram shows ranked GEX strikes. Green bars are positive GEX and red bars are negative GEX. Bar length represents absolute GEX magnitude.",
    flow_history:
      "Session history of captured Calls and Puts Flowline values. Use it to see whether options pressure is building, fading or changing direction through the day.",
    attraction_history:
      "Session history of the primary upside and downside attraction scores. It shows how the model's strongest target balance evolves through the session.",
    current_cycle:
      "The newest saved model cycle currently displayed on the Live page.",
    history:
      "Replay a saved cycle exactly as it was stored at that time. This helps avoid hindsight contamination when reviewing model decisions.",
    analytics:
      "Research section for the rolling outcome evaluator. It compares saved MES/MNQ model states with later directional accuracy, MFE, MAE and observed target behavior. It is intended for model calibration and gate validation—not as a live entry signal or a trade win-rate report.",
    explorer:
      "Inspect the complete saved GEX ladder and raw structured snapshot data instead of only the compact Live cards.",
    gex_table:
      "Opens the complete ranked GEX ladder for this symbol, including strike, GEX magnitude, relation to spot, distance, priority and temporal context.",
    target_details:
      "Opens the component breakdown behind the primary upside and downside Attraction Engine targets.",
    preference:
      "Preferred identifies which production instrument currently has the stronger Tradeability comparison. It does not mean that instrument is executable: target room, Market Condition, GEX, Cross-Market, 5-minute technicals, Order Flow and the manual 10-minute L/S trigger can still block or delay the trade.",

    final_decision:
      "This is the final automated execution state after the session gate, Setup Support, target room, GEX structural-change gate, Market Condition, Cross-Market confirmation, production-model alignment, 5-minute technical confirmation and Order Flow checks. Even MODEL READY still requires your matching manual 10-minute L/S signal, valid structure and acceptable R:R.",

    price_target_room:
      "Shows current SPX or QQQ spot, the primary GEX attraction target and the remaining underlying distance. The anti-chase rule uses this SPX/QQQ room—not MES/MNQ futures points. A target that is already passed or extremely close can block a fresh entry.",

    setup_support:
      "Setup Support is the display/research confluence score: 50% production directional model, 30% primary target attraction and 20% fresh Order Flow. A basic candidate currently requires the dominant side to reach 60+ and lead the opposite side by at least 10. It is not a win probability.",

    setup_spread:
      "Scenario spread is the difference between Bullish and Bearish Setup Support. A larger spread means one directional thesis is more clearly dominant. The current basic candidate rule requires a spread of at least 10.",

    market_condition_v2:
      "Market Condition V2 is an execution-safety gate, not a directional forecast. TRENDABLE = ALLOW. ORDERLY MIXED and VOLATILE TREND = CONDITIONAL and may continue through the rest of the model. CHOPPY and CHAOTIC VOLATILITY = BLOCK new entries.",

    market_condition_metrics_v2:
      "Market Condition V2 uses completed 5-minute bars: current and median range versus PRIOR 20-bar ATR, median wick share, directional efficiency, de-duplicated EMA9/EMA21/VWAP whipsaw events, EMA separation and extreme-bar cooldown. One older large candle no longer makes ordinary conditions chaotic by itself.",

    session_execution_gate:
      "Cash-session timing gate. The 8:30–8:59 AM CT opening window is observation-only, 9:00–9:14 is early-session model activity, and 9:15 onward uses normal-confidence execution rules.",

    gex_execution_gate:
      "Execution-level GEX structural-change gate. A sign flip, primary-target shift/loss or strengthening opposing acceleration can force a wait/reassessment. Target weakening is caution; stable or strengthening target structure is generally supportive. This does not change the production Attraction Engine itself.",

    cross_market_gate:
      "Compares MES and MNQ as an execution-safety layer. Same-direction credible setups confirm each other. Weak, blocked or choppy opposition does not automatically veto the cleaner instrument. If both have credible opposite setups, one is clearly dominant only when it leads by BOTH at least 15 Tradeability points and 5 Setup Support points. Strong opposite setups without clear dominance become STRONG DIVERGENCE and block a fresh entry. Thresholds are provisional.",

    orderflow_regime_trigger:
      "Order Flow shows a broader auction regime plus a shorter-horizon trigger. Regime alignment supports the thesis; an opposite trigger can mean WAIT PULLBACK; a non-aligned trigger means wait for timing confirmation. Order Flow is an execution/research layer and does not change production Tradeability.",

    execution_5m_tech:
      "The 5-minute technical confirmation uses price versus VWAP, EMA9 and EMA21 plus EMA alignment/slope and momentum. The current execution threshold is score >= +3 for LONG or <= -3 for SHORT. This is confirmation, not the final manual entry trigger.",

    execution_action:
      "The Action line is the condensed instruction produced by the automated gates. It tells you whether to stand aside, wait, avoid chasing or prepare for the manual 10-minute L/S trigger. It never replaces structural entry validation, stop placement or R:R assessment.",

    decision_diagnostics:
      "Expands the complete reasoning behind the compact decision card: session/GEX/Cross-Market/Market-Condition gates, production components, Bull/Bear scenario breakdown and exit/reassessment logic. Collapsing this section only changes the display; it does not change the model.",

    rolling_evaluator:
      "The rolling evaluator scores saved predictions at 15, 30, 45 and 60 minutes after the FINAL Attraction Engine result becomes available—not from the earlier GEX cycle-start time. Futures Return/MFE/MAE prefer ES/NQ 1-minute bars as MES/MNQ point-move proxies. SPX/QQQ target hits are observed from saved cycle spot snapshots, so a touch that reverses between snapshots can be missed.",

    analytics_research:
      "Analytics is the model-research layer. It compares every saved directional prediction—including blocked and NO CLEAR SETUP states—to later price behavior so we can test whether the gates actually filter weak conditions. These statistics are not the same as live trade win rate.",

    tradeability_history:
      "Shows how production Tradeability for MES and MNQ changed through the selected session. Tradeability measures production-model confluence; it is not calibrated probability and should be studied alongside Setup Support and the execution gates.",

    bias_distribution:
      "Counts saved production directional-bias states for the selected date. It shows how often the model leaned bullish, bearish or mixed; it does not measure whether those states were profitable.",

    directional_accuracy:
      "Directional accuracy asks whether the future closing price direction agreed with the saved dominant LONG/SHORT bias at the selected horizon. It includes predictions that were later blocked from trading, so it is a model-direction statistic—not trade win rate.",

    setup_calibration:
      "Buckets predictions by Setup Support and compares each bucket with observed directional accuracy. This tests whether higher Setup Support is actually associated with better directional forecasts. Sample size matters; the score is not assumed to equal probability.",

    research_horizon:
      "Selects the forward horizon used by the three research tables below. The same saved prediction can behave differently at 15, 30, 45 and 60 minutes, so conclusions should be horizon-specific.",

    accuracy_final_state:
      "Groups predictions by their FINAL execution state—for example MODEL READY, NO CLEAR SETUP, GEX CONFLICT or DO NOT CHASE—and measures later directional accuracy. The goal is to learn whether the execution states are separating higher-quality from lower-quality forecasts.",

    accuracy_market_condition:
      "Groups predictions by Market Condition V2 state and measures later directional accuracy. This helps test whether TRENDABLE, ORDERLY MIXED, VOLATILE TREND, CHOPPY and CHAOTIC classifications are appropriately restrictive.",

    accuracy_cross_market:
      "Groups predictions by MES/MNQ Cross-Market state and measures later directional accuracy. Use it to test whether confirmation, weak opposition, clear dominance and strong divergence are adding useful information.",

    sample_size:
      "N is the number of evaluated outcome rows in this category at the selected research horizon. Small samples can produce unstable percentages, so do not tune thresholds from a high or low accuracy number without enough observations.",

    average_setup:
      "Average Setup is the mean Setup Support of predictions in this category. It helps distinguish whether a category performed better because of the gate itself or simply because it contained stronger underlying setups.",

    instrument_accuracy:
      "Directional accuracy for this instrument within the selected category and research horizon. It is the percentage of saved LONG/SHORT predictions whose future closing-price direction agreed with the bias.",

    grouped_predictions:
      "One row represents one saved prediction. The 15m, 30m, 45m and 60m cells show the same prediction's forward outcome side-by-side instead of repeating four database rows. Click a prediction to expand Return, MFE, MAE and model context.",

    prediction_state:
      "The final V8 execution state that existed when the prediction was generated. Examples include NO CLEAR SETUP, DO NOT CHASE, GEX CONFLICT, CROSS-MARKET DIVERGENCE and MODEL READY. It records what the system would have told you at that time.",

    forward_horizon:
      "Forward evaluation window measured from the final Attraction Engine generation time. A 15m result therefore means price behavior during the first 15 minutes after the completed model recommendation—not 15 minutes after GEX collection began.",

    return_points:
      "Raw futures-family point change from the evaluation reference price to the horizon close. Positive means price finished higher and negative means lower, regardless of whether the saved model bias was LONG or SHORT.",

    mfe:
      "Maximum Favorable Excursion: the largest favorable move during the horizon relative to the saved LONG/SHORT bias. LONG favors higher prices; SHORT favors lower prices. Futures outcomes use ES/NQ 1-minute data when available.",

    mae:
      "Maximum Adverse Excursion: the largest move against the saved LONG/SHORT bias during the horizon. It is stored/displayed as a negative number. This is useful for studying stop risk and how much adverse movement preceded favorable movement.",

    bias_correct:
      "YES means the horizon closing-price direction agreed with the saved LONG/SHORT bias; NO means it did not. This does not mean an actual trade would have won or lost because entry timing, stops and the manual 10-minute trigger are not simulated here.",

    target_observation:
      "SPX/QQQ target status for this prediction. A saved future cycle at or through the target counts as an observed hit. Because underlying 1-minute SPX/QQQ bars are not currently archived, an intracycle touch that reverses before the next saved snapshot can be missed.",

    target_minutes:
      "Minutes from final model availability to the first SAVED cycle that observed SPX/QQQ at or through the target. This is snapshot-resolution timing, not exact tick-level time-to-target.",

    best_horizon:
      "The currently evaluated horizon with the highest directional accuracy for that instrument on the selected date. It is descriptive research, not a permanent recommendation; the best horizon can change as more sessions are collected.",

    fifteen_minute_accuracy:
      "Directional accuracy specifically at the standardized 15-minute horizon. We use 15m as the headline comparison because it is the shortest common research window and avoids mixing different forecast durations.",

    fifteen_minute_excursion:
      "Average 15-minute MFE and MAE for this instrument. Keeping the horizon fixed prevents longer 45m/60m windows from mechanically showing larger excursions simply because they have more time.",

    unique_target_hit_rate:
      "Observed target-hit rate counted once per unique prediction rather than once per 15/30/45/60 row. A hit at any mature horizon counts as a hit; otherwise the farthest mature observed horizon is used. Target observation still has snapshot-resolution limitations.",

    evaluated_predictions:
      "Number of unique saved model predictions with at least one evaluated horizon. The smaller horizon-row count underneath can be larger because one prediction can contribute 15m, 30m, 45m and 60m outcomes.",

    raw_evaluator:
      "Exact model_outcomes rows from Supabase. This is the audit/debug view: each prediction can appear once per evaluated horizon. The grouped Predictions table above is the easier research view of the same data.",

    dnc_shadow_research:
      "Research-only study of DO NOT CHASE cases. It does not alter live execution. The study separates close negative-GEX acceleration-if-accepted zones from close positive-GEX brake zones, then measures primary touch, sustained acceptance, next-target behavior and post-acceptance continuation.",

    dnc_primary_hit:
      "Percentage of DO NOT CHASE predictions where a later saved SPX/QQQ cycle reached or crossed the close primary GEX level within the selected horizon. A touch is not the same as acceptance.",

    dnc_acceptance:
      "Sustained acceptance is intentionally stricter than a touch: two consecutive saved SPX/QQQ cycles must remain beyond the primary level by at least 0.01% in the trade direction. This threshold is provisional and research-only.",

    dnc_alt_candidate:
      "Percentage where the nearest farther same-direction GEX target would still have produced hypothetical Setup Support >=60 and a Bull/Bear spread >=10 if only the target component were substituted. This does NOT make it a live target.",

    dnc_second_hit:
      "Observed hit rate of the nearest farther same-direction GEX target within the selected horizon. SPX/QQQ hits use saved cycle spots, so between-cycle touches can be missed.",

    dnc_continuation:
      "Average maximum SPX/QQQ continuation beyond the primary target after sustained acceptance is first observed. This measures whether acceptance through the close GEX level actually opened additional underlying room.",

    dnc_post_accept_mfe:
      "Average favorable ES/NQ futures excursion after the first observed sustained acceptance through the close SPX/QQQ primary level, measured through the selected horizon. MES uses ES 1m as its point-move proxy; MNQ uses NQ 1m.",

    active_trade_management:
      "Browser-local trade-management context for an already-open MES/MNQ position. This layer is intentionally separate from fresh-entry logic. It never places orders, does not know your exact broker fill/stop state, and does not replace the structural stop or manual execution plan.",

    active_trade_entry:
      "Your manually entered futures fill price. Open points and Open R are measured from this price. MES/MNQ management uses completed ES/NQ 1-minute price when available because the parent and micro contracts share the same quoted index-point scale.",

    active_trade_stop:
      "Your current structural stop. Initial risk is frozen from the stop supplied at activation. The website permits tightening the stop but intentionally refuses to widen it. Broker stop execution remains authoritative.",

    active_trade_open_r:
      "Open R = directional futures-point P/L divided by the INITIAL point risk between entry and the original structural stop. Tightening the stop later does not rewrite the denominator, so R remains comparable through the trade.",

    active_trade_open_pl:
      "Unrealized point and approximate dollar P/L from the latest completed futures price. MES is calculated at $5 per point per contract and MNQ at $2 per point per contract, before commissions/fees and without broker fill/slippage adjustments.",

    active_trade_target_context:
      "Entry Target is the primary SPX/QQQ GEX objective captured when trade management was activated. Current Target is the present same-direction primary target. Next GEX is the nearest farther same-direction structural candidate. These are underlying levels—not MES/MNQ R:R conversions.",

    active_trade_state:
      "Management state for the open position. HOLD means the thesis remains intact. HOLD · PROTECT means deterioration exists but the thesis is not fully invalidated. TAKE PROFIT / REDUCE means the original objective has been reached. EXIT / REASSESS requires materially stronger invalidation or a breached structural stop.",

    active_trade_invalidation:
      "EXIT / REASSESS requires at least two independent reversal categories among thesis/scenario, 5-minute structure, Order Flow auction, Cross-Market confirmation and GEX invalidation. One warning by itself normally produces HOLD · PROTECT rather than an automatic exit.",

    active_trade_continuation:
      "Research-only continuation context after a negative-GEX acceleration-if-accepted primary target is reached. During this week it is informational only: protect/reduce according to plan first, and do not let this shadow state force you to hold a runner.",

    active_trade_history:
      "Browser-local record of the management state once per new saved market snapshot while the trade is active. It is useful for later review but is not currently written to Supabase or Telegram.",
  };

  const TOOLTIP_ID = "dashboardTooltip";

  const q = (root, selector) => [...root.querySelectorAll(selector)];
  const clean = (value) => {
    // Read the VISIBLE DOM text instead of String(element), which returns
    // "[object HTML...Element]" and breaks label-based tooltip matching.
    if (value instanceof Element) {
      const clone =
        value.cloneNode(true);

      // Do not let an already-added info icon change the text we match on.
      clone
        .querySelectorAll(
          ".restored-info-icon"
        )
        .forEach(
          icon => icon.remove()
        );

      value =
        clone.textContent ||
        "";
    }
    else if (
      value instanceof Node
    ) {
      value =
        value.textContent ||
        "";
    }

    return String(
      value ||
      ""
    )
      .trim()
      .replace(
        /\s+/g,
        " "
      );
  };

  function infoIcon(key, label = "More information") {
    if (!HELP[key]) return null;
    const icon = document.createElement("span");
    icon.className = "info-icon restored-info-icon";
    icon.dataset.restoredInfoKey = key;
    icon.setAttribute("role", "button");
    icon.setAttribute("tabindex", "0");
    icon.setAttribute("aria-label", label);
    icon.setAttribute("aria-describedby", TOOLTIP_ID);
    icon.textContent = "i";
    return icon;
  }

  function addIcon(target, key, label) {
    if (!target || !HELP[key]) return;
    if (target.querySelector(":scope > .restored-info-icon")) return;
    const icon = infoIcon(key, label);
    if (icon) target.appendChild(icon);
  }

  function hydrate(root = document) {
    if (!(root instanceof Element) && root !== document) return;

    q(root, ".instrument-bias").forEach(el => addIcon(el, "model_bias", "Explain model bias"));
    q(root, ".tradeability-number").forEach(el => addIcon(el, "tradeability", "Explain tradeability"));
    q(root, ".component-pill").forEach(el => addIcon(el, "component", "Explain component score"));

    q(root, ".tf-label").forEach(el => addIcon(el, "mtf_bias", "Explain timeframe bias"));
    q(root, ".tf-detail-button .tiny.muted").forEach(el => {
      if (clean(el).toLowerCase().includes("score")) addIcon(el, "technical_score", "Explain technical score");
    });
    q(root, ".technical-card .badge").forEach(el => addIcon(el, "forming_bar", "Explain forming-bar handling"));

    q(root, ".meta-item .label").forEach(el => {
      const label = clean(el).toUpperCase();
      if (label === "VWAP") addIcon(el, "vwap", "Explain VWAP");
      else if (label === "EMA9") addIcon(el, "ema9", "Explain EMA9");
      else if (label === "EMA21") addIcon(el, "ema21", "Explain EMA21");
      else if (["15M", "30M", "45M"].includes(label)) addIcon(el, "price_change", "Explain price change");
    });

    q(root, ".market-card .spot").forEach(el => addIcon(el, "spot", "Explain spot price"));
    q(root, ".market-card .market-top .badge").forEach(el => addIcon(el, "net_attraction", "Explain net attraction bias"));
    q(root, ".target-side").forEach(el => addIcon(el, "attraction_target", "Explain attraction target"));
    q(root, ".target-score").forEach(el => addIcon(el, "attraction_score", "Explain attraction score"));
    q(root, ".reaction").forEach(el => addIcon(el, "reaction", "Explain reaction type"));

    q(root, ".flow-label").forEach(el => {
      const label = clean(el).toUpperCase();
      if (label.includes("FLOWLINE")) addIcon(el, "flowline", "Explain Flowline");
      else if (label.includes("SPOT STATE")) addIcon(el, "spot_state", "Explain spot state");
    });
    q(root, ".flow-row .tiny.muted").forEach(el => addIcon(el, "calls_puts", "Explain Calls and Puts direction"));

    q(root, ".market-chart-wrap").forEach(el => {
      if (el.dataset.tooltipHydrated === "1") return;
      el.dataset.tooltipHydrated = "1";
      const badge = document.createElement("div");
      badge.className = "chart-info-badge";
      const icon = infoIcon("gex_chart", "Explain GEX histogram");
      if (icon) badge.appendChild(icon);
      el.appendChild(badge);
    });

    q(root, ".market-actions button").forEach(button => {
      const t = clean(button).toLowerCase();
      if (t.includes("all gex levels")) addIcon(button, "gex_table", "Explain GEX table");
      else if (t.includes("target details")) addIcon(button, "target_details", "Explain target details");
    });

    q(root, ".panel-heading h3").forEach(el => {
      const title = clean(el).toLowerCase();
      if (title.includes("flowline history")) addIcon(el, "flow_history", "Explain Flowline history");
      else if (title.includes("attraction score history")) addIcon(el, "attraction_history", "Explain attraction history");
    });

    q(root, ".section-heading").forEach(section => {
      const eyebrow =
        clean(
          section.querySelector(
            ".eyebrow"
          )
        ).toUpperCase();

      const h2 =
        section.querySelector(
          "h2"
        );

      if (!h2) return;

      if (
        eyebrow.includes(
          "CURRENT CYCLE"
        )
      ) {
        addIcon(
          h2,
          "current_cycle",
          "Explain current cycle"
        );
      }

      // Intentionally no tooltip on SESSION RESEARCH / Model Performance.
      // Analytics help belongs on the actual measurements.
    });

    // ----------------------------------------------------------
    // FINAL EXECUTION MODEL V8
    // ----------------------------------------------------------

    q(root, ".preferred-badge").forEach(el =>
      addIcon(el, "preference", "Explain preferred instrument")
    );

    q(root, ".execution-eyebrow").forEach(el => {
      if (clean(el).toUpperCase() === "DECISION") {
        addIcon(el, "final_decision", "Explain final execution decision");
      }
    });

    q(root, ".decision-core-item > span").forEach(el => {
      const label = clean(el).toUpperCase();

      if (label.includes("CURRENT") && label.includes("TARGET")) {
        addIcon(el, "price_target_room", "Explain price, target and room");
      }
      else if (label === "SETUP") {
        addIcon(el, "setup_support", "Explain Setup Support");
      }
    });

    q(root, ".decision-core-item.setup-score small").forEach(el =>
      addIcon(el, "setup_spread", "Explain Bull/Bear scenario spread")
    );

    q(root, ".decision-condition > span").forEach(el => {
      const label = clean(el).toUpperCase();

      if (label === "MARKET") {
        addIcon(el, "market_condition_v2", "Explain Market Condition V2");
      }
      else if (label === "GEX") {
        addIcon(el, "gex_execution_gate", "Explain GEX execution gate");
      }
      else if (label === "CROSS-MKT") {
        addIcon(el, "cross_market_gate", "Explain Cross-Market gate");
      }
      else if (label === "ORDER FLOW") {
        addIcon(el, "orderflow_regime_trigger", "Explain Order Flow regime and trigger");
      }
      else if (label === "5M TECH") {
        addIcon(el, "execution_5m_tech", "Explain 5-minute technical confirmation");
      }
    });

    q(root, ".decision-action > span").forEach(el =>
      addIcon(el, "execution_action", "Explain final action")
    );

    q(root, ".decision-details > summary span").forEach(el =>
      addIcon(el, "decision_diagnostics", "Explain details and diagnostics")
    );

    q(root, ".session-gate-label").forEach(el =>
      addIcon(el, "session_execution_gate", "Explain session execution gate")
    );

    q(root, ".gex-execution-label").forEach(el => {
      const label = clean(el).toUpperCase();

      if (label.includes("CROSS-MARKET")) {
        addIcon(el, "cross_market_gate", "Explain Cross-Market gate");
      }
      else {
        addIcon(el, "gex_execution_gate", "Explain GEX structural-change gate");
      }
    });

    q(root, ".market-condition-label").forEach(el =>
      addIcon(el, "market_condition_v2", "Explain Market Condition V2")
    );

    q(root, ".market-condition-detail").forEach(el =>
      addIcon(el, "market_condition_metrics_v2", "Explain Market Condition metrics")
    );

    // ----------------------------------------------------------
    // ANALYTICS / ROLLING OUTCOME RESEARCH
    // ----------------------------------------------------------

    q(root, ".analytics-research-controls label > span").forEach(el => {
      if (clean(el).toLowerCase().includes("research horizon")) {
        addIcon(el, "research_horizon", "Explain research horizon");
      }
    });

    q(root, ".prediction-filter-bar label > span").forEach(el => {
      const label = clean(el).toLowerCase();

      if (label === "instrument") {
        addIcon(
          el,
          "grouped_predictions",
          "Filter grouped predictions by MES or MNQ"
        );
      }
      else if (label === "bias") {
        addIcon(
          el,
          "directional_accuracy",
          "Filter grouped predictions by LONG or SHORT bias"
        );
      }
      else if (label === "state") {
        addIcon(
          el,
          "prediction_state",
          "Filter grouped predictions by final execution state"
        );
      }
    });

    q(root, ".stat-card .stat-label").forEach(el => {
      const label = clean(el).toLowerCase();

      if (
        label.includes("mes 15m accuracy") ||
        label.includes("mnq 15m accuracy") ||
        label.includes("15m accuracy")
      ) {
        addIcon(el, "fifteen_minute_accuracy", "Explain 15-minute directional accuracy");
      }
      else if (
        label.includes("best mes horizon") ||
        label.includes("best mnq horizon") ||
        (label.includes("best") && label.includes("horizon"))
      ) {
        addIcon(el, "best_horizon", "Explain best evaluated horizon");
      }
      else if (
        label.includes("mes 15m mfe") ||
        label.includes("mnq 15m mfe") ||
        label.includes("15m mfe") ||
        label.includes("15m mae")
      ) {
        addIcon(el, "fifteen_minute_excursion", "Explain 15-minute MFE / MAE");
      }
      else if (label.includes("observed target hit")) {
        addIcon(el, "unique_target_hit_rate", "Explain observed target-hit rate");
      }
      else if (label.includes("evaluated predictions")) {
        addIcon(el, "evaluated_predictions", "Explain evaluated prediction count");
      }
    });

    q(root, ".panel-heading h3").forEach(el => {
      const title = clean(el).toLowerCase();

      if (title.includes("tradeability through the session")) {
        addIcon(el, "tradeability_history", "Explain Tradeability history");
      }
      else if (title.includes("bias distribution")) {
        addIcon(el, "bias_distribution", "Explain bias distribution");
      }
      else if (title.includes("directional accuracy by horizon")) {
        addIcon(el, "directional_accuracy", "Explain directional accuracy");
      }
      else if (title.includes("setup support vs directional accuracy")) {
        addIcon(el, "setup_calibration", "Explain Setup Support calibration");
      }
      else if (title.includes("accuracy by final state")) {
        addIcon(el, "accuracy_final_state", "Explain accuracy by final state");
      }
      else if (title.includes("accuracy by market condition")) {
        addIcon(el, "accuracy_market_condition", "Explain accuracy by Market Condition");
      }
      else if (title.includes("accuracy by cross-market state")) {
        addIcon(el, "accuracy_cross_market", "Explain accuracy by Cross-Market state");
      }
      else if (title.includes("one prediction") && title.includes("forward horizons")) {
        addIcon(el, "grouped_predictions", "Explain grouped predictions");
      }
    });

    q(root, "#outcomeNotice strong").forEach(el =>
      addIcon(el, "rolling_evaluator", "Explain rolling evaluator methodology")
    );

    q(root, ".research-table th").forEach(el => {
      const label = clean(el).toUpperCase();

      if (label === "N") {
        addIcon(el, "sample_size", "Explain sample size");
      }
      else if (label === "AVG SETUP") {
        addIcon(el, "average_setup", "Explain average Setup Support");
      }
      else if (label === "MES ACC" || label === "MNQ ACC") {
        addIcon(el, "instrument_accuracy", "Explain instrument directional accuracy");
      }
      else if (label === "STATE") {
        addIcon(el, "accuracy_final_state", "Explain execution-state grouping");
      }
      else if (label === "CONDITION") {
        addIcon(el, "accuracy_market_condition", "Explain Market Condition grouping");
      }
      else if (label === "CROSS-MARKET") {
        addIcon(el, "accuracy_cross_market", "Explain Cross-Market grouping");
      }
    });

    q(root, "#groupedPredictionsTable th").forEach(el => {
      const label = clean(el).toUpperCase();

      if (label === "SETUP") {
        addIcon(el, "setup_support", "Explain Setup Support");
      }
      else if (label === "STATE") {
        addIcon(el, "prediction_state", "Explain final prediction state");
      }
      else if (["15M", "30M", "45M", "60M"].includes(label)) {
        addIcon(el, "forward_horizon", "Explain forward outcome horizon");
      }
      else if (label === "TARGET") {
        addIcon(el, "target_observation", "Explain observed target result");
      }
      else if (label === "BIAS") {
        addIcon(el, "directional_accuracy", "Explain saved LONG/SHORT bias");
      }
    });

    q(root, ".prediction-detail-context > div > span").forEach(el => {
      const label = clean(el).toUpperCase();

      if (label === "MARKET") {
        addIcon(el, "market_condition_v2", "Explain Market Condition");
      }
      else if (label === "CROSS-MARKET") {
        addIcon(el, "cross_market_gate", "Explain Cross-Market state");
      }
      else if (label === "GEX") {
        addIcon(el, "gex_execution_gate", "Explain GEX execution state");
      }
      else if (label === "ORDER FLOW") {
        addIcon(el, "orderflow_regime_trigger", "Explain Order Flow state");
      }
      else if (label === "PREFERRED") {
        addIcon(el, "preference", "Explain preferred instrument");
      }
    });

    q(root, ".horizon-detail-metrics span").forEach(el => {
      const label = clean(el).toUpperCase();

      if (label === "RETURN") {
        addIcon(el, "return_points", "Explain forward return");
      }
      else if (label === "MFE") {
        addIcon(el, "mfe", "Explain maximum favorable excursion");
      }
      else if (label === "MAE") {
        addIcon(el, "mae", "Explain maximum adverse excursion");
      }
    });

    q(root, ".horizon-outcome").forEach(el => {
      addIcon(
        el,
        "forward_horizon",
        "Explain this forward-horizon result"
      );
    });

    q(root, ".prediction-target").forEach(el => {
      addIcon(
        el,
        "target_observation",
        "Explain target observation and hit timing"
      );
    });

    q(root, ".raw-outcomes-details > summary strong").forEach(el =>
      addIcon(el, "raw_evaluator", "Explain raw evaluator data")
    );

    q(root, "#outcomesTable th").forEach(el => {
      const label = clean(el).toUpperCase();

      if (label === "SETUP") {
        addIcon(el, "setup_support", "Explain Setup Support");
      }
      else if (label === "STATE") {
        addIcon(el, "prediction_state", "Explain final execution state");
      }
      else if (label === "HORIZON") {
        addIcon(el, "forward_horizon", "Explain evaluation horizon");
      }
      else if (label === "RETURN") {
        addIcon(el, "return_points", "Explain forward return");
      }
      else if (label === "MFE") {
        addIcon(el, "mfe", "Explain MFE");
      }
      else if (label === "MAE") {
        addIcon(el, "mae", "Explain MAE");
      }
      else if (label === "BIAS CORRECT") {
        addIcon(el, "bias_correct", "Explain bias correctness");
      }
      else if (label === "TARGET" || label === "HIT") {
        addIcon(el, "target_observation", "Explain target observation");
      }
      else if (label === "MINUTES") {
        addIcon(el, "target_minutes", "Explain time to observed target");
      }
    });

    q(root, ".dnc-shadow-panel .panel-heading h3").forEach(el =>
      addIcon(el, "dnc_shadow_research", "Explain DO NOT CHASE shadow research")
    );

    q(root, "#dncShadowTable th").forEach(el => {
      const label = clean(el).toUpperCase();

      if (label === "PRIMARY HIT") {
        addIcon(el, "dnc_primary_hit", "Explain primary GEX hit rate");
      }
      else if (label === "ACCEPTED") {
        addIcon(el, "dnc_acceptance", "Explain sustained GEX acceptance");
      }
      else if (label === "ALT 60/10") {
        addIcon(el, "dnc_alt_candidate", "Explain hypothetical second-target qualification");
      }
      else if (label === "2ND TARGET HIT") {
        addIcon(el, "dnc_second_hit", "Explain second-target hit rate");
      }
      else if (label === "AVG CONTINUE") {
        addIcon(el, "dnc_continuation", "Explain post-acceptance underlying continuation");
      }
      else if (label === "POST-ACCEPT MFE") {
        addIcon(el, "dnc_post_accept_mfe", "Explain post-acceptance futures MFE");
      }
      else if (label === "N") {
        addIcon(el, "sample_size", "Explain sample size");
      }
    });

    q(root, ".active-trade-heading h2").forEach(el =>
      addIcon(el, "active_trade_management", "Explain Active Trade Management")
    );

    q(root, ".active-trade-metric > span").forEach(el => {
      const label = clean(el).toUpperCase();

      if (label === "ENTRY") {
        addIcon(el, "active_trade_entry", "Explain trade entry");
      }
      else if (label === "STRUCTURAL STOP" || label === "INITIAL RISK") {
        addIcon(el, "active_trade_stop", "Explain structural stop and initial risk");
      }
      else if (label === "OPEN R") {
        addIcon(el, "active_trade_open_r", "Explain Open R");
      }
      else if (label === "OPEN P/L") {
        addIcon(el, "active_trade_open_pl", "Explain unrealized P/L");
      }
    });

    q(root, ".active-trade-target-strip span").forEach(el => {
      const label = clean(el).toUpperCase();
      if (["ENTRY TARGET", "CURRENT TARGET", "NEXT GEX", "UNDERLYING"].includes(label)) {
        addIcon(el, "active_trade_target_context", "Explain GEX target context");
      }
    });

    q(root, ".active-trade-management-state span").forEach(el =>
      addIcon(el, "active_trade_state", "Explain active-trade management state")
    );

    q(root, ".active-trade-action > span").forEach(el =>
      addIcon(el, "active_trade_invalidation", "Explain hold/protect/exit logic")
    );

    q(root, ".active-trade-continuation-watch strong").forEach(el =>
      addIcon(el, "active_trade_continuation", "Explain research-only continuation watch")
    );

    q(root, ".active-trade-history-details summary span").forEach(el =>
      addIcon(el, "active_trade_history", "Explain active-trade management history")
    );

    q(root, ".history-summary").forEach(el => addIcon(el, "history", "Explain historical snapshot"));
    q(root, ".raw-panel h3").forEach(el => addIcon(el, "explorer", "Explain raw snapshot data"));
  }

  function tooltip() {
    let tip = document.getElementById(TOOLTIP_ID);
    if (tip) return tip;
    tip = document.createElement("div");
    tip.id = TOOLTIP_ID;
    tip.className = "info-tooltip restored-tooltip hidden";
    tip.setAttribute("role", "tooltip");
    document.body.appendChild(tip);
    return tip;
  }

  function hideTooltip() {
    const tip = tooltip();
    tip.classList.add("hidden");
    tip.classList.remove("mobile-bottom-sheet");
    tip.textContent = "";
    document.querySelectorAll(".restored-info-icon.active")
      .forEach(icon => icon.classList.remove("active"));
  }

  function showTooltip(icon) {
    const key = icon?.dataset?.restoredInfoKey;
    const value = HELP[key];
    if (!value) return;

    const tip = tooltip();
    document.querySelectorAll(".restored-info-icon.active")
      .forEach(node => node.classList.remove("active"));
    icon.classList.add("active");

    tip.textContent = value;
    tip.classList.remove("hidden");

    if (window.matchMedia("(max-width: 700px)").matches) {
      tip.classList.add("mobile-bottom-sheet");
      tip.style.width = "auto";
      tip.style.left = "12px";
      tip.style.right = "12px";
      tip.style.top = "auto";
      tip.style.bottom = "18px";
      return;
    }

    tip.classList.remove("mobile-bottom-sheet");
    tip.style.right = "auto";
    tip.style.bottom = "auto";

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

  function boot() {
    hydrate(document);

    const observer =
      new MutationObserver(
        mutations => {
          for (
            const mutation
            of mutations
          ) {
            for (
              const node
              of mutation.addedNodes
            ) {
              if (
                node.nodeType !==
                Node.ELEMENT_NODE
              ) {
                continue;
              }

              // Tooltip icons are our own DOM writes. Never feed them back
              // through hydration.
              if (
                node.matches?.(
                  ".restored-info-icon, #dashboardTooltip"
                )
              ) {
                continue;
              }

              hydrate(node);
            }
          }
        }
      );
    observer.observe(document.body, { childList: true, subtree: true });

    document.addEventListener("click", event => {
      const icon = event.target.closest?.(".restored-info-icon");
      if (icon) {
        event.preventDefault();
        event.stopPropagation();
        const tip = tooltip();
        if (icon.classList.contains("active") && !tip.classList.contains("hidden")) hideTooltip();
        else showTooltip(icon);
        return;
      }
      if (!event.target.closest?.(`#${TOOLTIP_ID}`)) hideTooltip();
    });

    document.addEventListener("keydown", event => {
      if (event.key === "Escape") hideTooltip();
      if ((event.key === "Enter" || event.key === " ") && event.target.matches?.(".restored-info-icon")) {
        event.preventDefault();
        showTooltip(event.target);
      }
    });

    document.addEventListener("mouseover", event => {
      const icon = event.target.closest?.(".restored-info-icon");
      if (icon && !window.matchMedia("(max-width: 700px)").matches) showTooltip(icon);
    });

    document.addEventListener("mouseout", event => {
      const icon = event.target.closest?.(".restored-info-icon");
      if (icon && !window.matchMedia("(max-width: 700px)").matches) hideTooltip();
    });

    window.addEventListener("resize", hideTooltip);
    window.addEventListener("scroll", () => {
      if (!window.matchMedia("(max-width: 700px)").matches) hideTooltip();
    }, true);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
