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

  // ==========================================================
  // DISPLAY-ONLY TRADE SCENARIO RECOMMENDATIONS
  // ==========================================================
  //
  // This does NOT change the backend Attraction Engine, Tradeability,
  // preferred instrument, or saved model output.
  //
  // Scenario-support score:
  //   50% production directional model
  //   30% primary underlying target attraction
  //   20% fresh ES/NQ Order Flow overlay
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
    const shadow = row?.shadow_model || {};

    const fresh = Boolean(
      row &&
      row.data_status === "FRESH" &&
      shadow.signal_status === "FRESH"
    );

    return {
      futuresSymbol,
      row,
      shadow,
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
      ? clampNumber(of.shadow?.combined_direction, -1, 1)
      : 0;

    const orderflowQuality = of.fresh
      ? clampNumber(Number(of.shadow?.combined_quality) / 100, 0, 1)
      : 0;

    // Low-quality Order Flow stays close to neutral rather than dominating.
    const orderflowSupport = clampNumber(
      50 + sideSign * 50 * orderflowDirection * orderflowQuality,
      0,
      100
    );

    const score = clampNumber(
      modelSupport * 0.50 +
      targetSupport * 0.30 +
      orderflowSupport * 0.20,
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
      ? of.shadow?.bias || "MIXED"
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
        ? Number(of.shadow?.combined_quality)
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
        `Crosses ${crosses}`
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
          of.shadow?.regime_direction
        )
      : 0;

    const triggerSign = of.fresh
      ? signWithDeadZone(
          of.shadow?.trigger_direction
        )
      : 0;

    const combinedSign = of.fresh
      ? signWithDeadZone(
          of.shadow?.combined_direction
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
            of.shadow?.regime_bias ||
            "MIXED"
          ).replaceAll("_", " ")
        : "STALE";

    const triggerText =
      of.fresh
        ? String(
            of.shadow?.trigger_bias ||
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
      marketCondition.execution_permission === "CAUTION"
    ) {
      const condition =
        String(
          marketCondition.condition ||
          ""
        ).toUpperCase();

      state =
        condition === "VOLATILE_TREND"
          ? "VOLATILE TREND · CAUTION"
          : "WAIT CLEANER STRUCTURE";

      stateClass =
        "waiting";

      action =
        condition === "VOLATILE_TREND"
          ? "Do not chase or mechanically widen the stop. Wait for a clean pullback/retest and a matching 10m L/S signal; keep the same dollar risk."
          : "Wait for cleaner directional efficiency and less EMA/VWAP whipsaw before using the 10m L/S trigger.";

      blocker =
        marketCondition.detail ||
        marketConditionMetricText(
          marketCondition
        );
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
        `10m regime ${regimeText}; combined ${String(of.shadow?.bias || "MIXED").replaceAll("_", " ")}.`;
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
      if (gexGate.caution) {
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
            ? "Environment is TRENDABLE and the model is aligned. Take only a matching 10m L signal, then use a structural stop and confirm sufficient R:R to the SPX/QQQ target."
            : "Environment is TRENDABLE and the model is aligned. Take only a matching 10m S signal, then use a structural stop and confirm sufficient R:R to the SPX/QQQ target.";

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
      sessionGate,
      gexGate,
      marketCondition,
    };
  }

  function renderExecutionState(execution) {
    const sideClass =
      execution.bias === "LONG"
        ? "bullish"
        : execution.bias === "SHORT"
          ? "bearish"
          : "neutral";

    return `
      <div class="execution-state ${sideClass}">
        <div class="execution-state-top">
          <div>
            <div class="execution-eyebrow">CONCISE EXECUTION STATE</div>
            <div class="execution-bias ${execution.biasClass}">
              ${esc(execution.bias)}
            </div>
          </div>

          <div class="execution-state-badge ${execution.stateClass}">
            ${esc(execution.state)}
          </div>
        </div>

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

        <div class="execution-action">
          <span>ACTION</span>
          <strong>${esc(execution.action)}</strong>
        </div>

        <div class="execution-blocker">
          <span>WHY / BLOCKER</span>
          <div>${esc(execution.blocker)}</div>
        </div>

        <div class="execution-exit">
          <span>IF ENTERED · EXIT PLAN</span>
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
                PRODUCTION TRADEABILITY ·
                ${esc(String(row.tradeability_confidence || "N/A").replaceAll("_", " "))}
              </div>
            </div>
          </div>

          <div class="component-bar">${componentHtml}</div>

          ${renderExecutionState(execution)}

          <div class="trade-reco-header">
            <div>
              <div class="trade-reco-title">TRADE SCENARIOS</div>
              <div class="trade-reco-caption">
                50% production model · 30% target attraction · 20% fresh Order Flow
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

  // Refresh scenario cards if Order Flow is recovered after initial page load.
  window.addEventListener("fm-orderflow-recovered", () => {
    if (state.latest) {
      renderInstrumentCards(
        state.latest,
        "instrumentCards"
      );
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
