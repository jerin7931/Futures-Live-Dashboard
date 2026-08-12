(() => {
  "use strict";

  const VERSION = "PHASE4D_ORDERFLOW_WEB_V2";

  const HELP = {
    section: "ES order flow is paired with MES and NQ order flow is paired with MNQ. This is a shadow research layer. It does not change the Attraction Engine, Tradeability score, target ranking, or preferred instrument.",
    combined: "Combined shadow order-flow direction = 60% 10-minute regime + 40% short-horizon trigger. Direction runs from -1 bearish to +1 bullish. Quality measures directional evidence; it is not a win probability.",
    regime: "The broader order-flow regime uses 30-minute Delta direction, latest completed 10-minute Delta, POC migration, and 10-minute imbalance structure.",
    trigger: "The short-horizon trigger uses 5-minute Delta, 15-minute Delta, 15-minute imbalance structure, and qualifying stacked imbalances.",
    delta: "Footprint Delta = estimated buy volume minus estimated sell volume. Delta % is volume-weighted for the selected window. Positive favors buying pressure; negative favors selling pressure.",
    cvd: "RTH Session CVD accumulates footprint Delta from the 8:30 AM CT cash-session reset. Recent CVD direction shows whether pressure is improving or deteriorating.",
    poc: "Footprint POC is the highest-volume price row of the completed 10-minute footprint. UP, DOWN, or STABLE describes migration across recent completed 10-minute bars.",
    va: "Value Area migration tracks the midpoint of VAH and VAL across recent completed 10-minute footprints. Rising accepted value supports upside acceptance; falling value supports downside acceptance.",
    imbalance: "Imbalance ratio = (buy imbalance count - sell imbalance count) / total imbalance count. +1 means all buy imbalances, -1 means all sell imbalances, and 0 is balanced.",
    stacks: "A stacked imbalance is counted only when at least three consecutive qualifying footprint rows occur. Sub-threshold stacks do not contribute to the shadow model.",
    divergence: "Research flag for meaningful disagreement between price and footprint Delta. V1 requires at least 5% absolute 15-minute Delta before labeling divergence.",
    absorption: "Research candidate only. V1 flags possible absorption when 5-minute Delta is at least 20% in one direction but price fails to progress in that same direction.",
    agreement: "Compares the production MES/MNQ model bias with the fresh ES/NQ shadow order-flow bias. CONFIRMING means the same direction, DISAGREEING means opposite directions, and NEUTRAL means at least one side is mixed. This does not change Tradeability.",
    freshness: "Freshness guard: latest completed 1-minute footprint must be no more than 5 minutes old and latest completed 10-minute footprint no more than 20 minutes old. Otherwise the signal is STALE NO SIGNAL."
  };

  const $ = id => document.getElementById(id);

  function esc(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function num(value, digits = 1) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toFixed(digits) : "—";
  }

  function signed(value, digits = 1) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}`;
  }

  function signedPct(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    return `${signed(n, 2)}%`;
  }

  function enumText(value, fallback = "—") {
    if (value === null || value === undefined || value === "") return fallback;
    return String(value).replaceAll("_", " ");
  }

  function biasClass(value) {
    const text = String(value || "").toUpperCase();
    if (text.includes("BULLISH") || text === "RISING" || text === "UP") return "positive";
    if (text.includes("BEARISH") || text === "FALLING" || text === "DOWN") return "negative";
    return "neutral";
  }

  function biasSign(value) {
    const text = String(value || "").toUpperCase();
    if (text.includes("BULLISH")) return 1;
    if (text.includes("BEARISH")) return -1;
    return 0;
  }

  function helpIcon(key) {
    return `<button type="button" class="of-help" data-of-help="${esc(key)}" aria-label="Help" title="${esc(HELP[key] || "")}">i</button>`;
  }

  function parseObject(value) {
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

  function orderflowPayload(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return null;

    const candidates = [
      snapshot.orderflow,
      snapshot.order_flow,
      snapshot.orderFlow,
    ];

    for (const candidate of candidates) {
      let payload = parseObject(candidate);

      if (!payload) continue;

      // Tolerate an accidental one-level wrapper.
      if (!payload.instruments && payload.orderflow) {
        payload = parseObject(payload.orderflow) || payload;
      }

      if (payload?.instruments) return payload;
    }

    return null;
  }

  function orderflowRow(snapshot, executionSymbol) {
    const futuresSymbol = executionSymbol === "MES" ? "ES" : "NQ";
    const payload = orderflowPayload(snapshot);

    return {
      futuresSymbol,
      row: payload?.instruments?.[futuresSymbol] || null,
      payload,
    };
  }

  function missingReason(snapshot, futuresSymbol) {
    if (!snapshot) {
      return "The dashboard has not loaded a market snapshot yet.";
    }

    const source = snapshot.source_status || {};
    const raw =
      snapshot.orderflow ??
      snapshot.order_flow ??
      snapshot.orderFlow ??
      null;

    if (source.orderflow === true && !raw) {
      return (
        "Upload metadata says Order Flow exists for this cycle, but the browser row " +
        "does not currently contain the orderflow JSON field. The renderer will " +
        "re-fetch this exact Supabase row automatically."
      );
    }

    if (raw && !orderflowPayload(snapshot)) {
      return (
        "An orderflow field exists, but its JSON shape could not be decoded into " +
        "instruments.ES / instruments.NQ."
      );
    }

    if (orderflowPayload(snapshot) && !orderflowPayload(snapshot)?.instruments?.[futuresSymbol]) {
      return (
        `The saved Order Flow payload exists, but ${futuresSymbol} is missing from instruments.`
      );
    }

    if (source.orderflow === false) {
      return (
        "This cycle was uploaded without a completed OrderFlow_snapshot.json. " +
        "The production model can still run because Order Flow is shadow-only."
      );
    }

    return (
      "No saved order-flow snapshot is attached to this database row. " +
      "Older rows created before Order Flow web storage normally show this state."
    );
  }

  function baseBias(snapshot, executionSymbol) {
    return snapshot?.attraction?.instruments?.[executionSymbol]?.bias ||
      snapshot?.[executionSymbol.toLowerCase() + "_bias"] || null;
  }

  function agreement(snapshot, executionSymbol, row) {
    const shadow = row?.shadow_model;
    if (!row || row.data_status !== "FRESH" || shadow?.signal_status !== "FRESH") {
      return { label: "NOT EVALUATED", cls: "stale" };
    }
    const modelSign = biasSign(baseBias(snapshot, executionSymbol));
    const flowSign = biasSign(shadow.bias);
    if (!modelSign || !flowSign) return { label: "NEUTRAL / UNRESOLVED", cls: "neutral" };
    if (modelSign === flowSign) {
      return { label: modelSign > 0 ? "CONFIRMING ↑" : "CONFIRMING ↓", cls: "confirming" };
    }
    return { label: "DISAGREEING", cls: "disagreeing" };
  }

  function metric(label, value, helpKey, cls = "") {
    return `<div class="of-metric"><div class="of-metric-label">${esc(label)} ${helpIcon(helpKey)}</div><div class="of-metric-value ${cls}">${esc(value)}</div></div>`;
  }

  function ageText(value) {
    const n = Number(value);
    return Number.isFinite(n) ? `${n.toFixed(1)}m` : "—";
  }

  function renderCard(snapshot, executionSymbol) {
    const { futuresSymbol, row } = orderflowRow(snapshot, executionSymbol);

    if (!row) {
      const reason = missingReason(snapshot, futuresSymbol);
      return `<article class="of-card"><div class="of-top"><div><div class="of-symbol">${futuresSymbol} ORDER FLOW</div><div class="of-map">${futuresSymbol} → ${executionSymbol}</div></div><span class="of-status missing">NO DATA</span></div><div class="of-empty">${esc(reason)}</div></article>`;
    }

    const shadow = row.shadow_model || {};
    const fresh = row.data_status === "FRESH" && shadow.signal_status === "FRESH";
    const w5 = row.windows?.["5m"] || {};
    const w15 = row.windows?.["15m"] || {};
    const w30 = row.windows?.["30m"] || {};
    const cvd = row.cvd || {};
    const ten = row.ten_minute || {};
    const f1 = row.freshness?.["1m"] || {};
    const f10 = row.freshness?.["10m"] || {};
    const agree = agreement(snapshot, executionSymbol, row);

    const combinedBias = fresh ? enumText(shadow.bias) : "STALE NO SIGNAL";
    const combinedDir = fresh ? signed(shadow.combined_direction, 3) : "";
    const combinedQuality = fresh ? num(shadow.combined_quality, 1) : "—";
    const regimeBias = fresh ? enumText(shadow.regime_bias) : "STALE";
    const triggerBias = fresh ? enumText(shadow.trigger_bias) : "STALE";
    const regimeDetail = fresh ? `${signed(shadow.regime_direction, 3)} · Q ${num(shadow.regime_quality, 1)}` : "No current signal";
    const triggerDetail = fresh ? `${signed(shadow.trigger_direction, 3)} · Q ${num(shadow.trigger_quality, 1)}` : "No current signal";
    const cvd15 = cvd.direction_15m && cvd.direction_15m !== "INSUFFICIENT_DATA" ? `${enumText(cvd.direction_15m)} ${signed(cvd.change_15m, 0)}` : "—";
    const poc = Number.isFinite(Number(ten.poc_price)) ? `${num(ten.poc_price, 2)} · ${enumText(ten.poc_migration?.state)}` : "—";
    const imbalance = Number.isFinite(Number(w15.imbalance_ratio)) ? signed(w15.imbalance_ratio, 3) : "—";
    const stacks = `${num(w5.max_buy_stack, 0)}B / ${num(w5.max_sell_stack, 0)}S`;

    const staleWarning = fresh ? "" : `<div class="of-stale-warning"><strong>STALE — no current order-flow signal.</strong><br>The freshness guard invalidated regime, trigger, combined bias, and model agreement. Stored footprint metrics below are historical/audit values only.</div>`;

    return `<article class="of-card ${fresh ? "fresh" : "stale"}">
      <div class="of-top"><div><div class="of-symbol">${futuresSymbol} ORDER FLOW</div><div class="of-map">${futuresSymbol} futures auction → ${executionSymbol} execution context</div></div><span class="of-status ${fresh ? "fresh" : "stale"}">${fresh ? "FRESH" : "STALE"} ${helpIcon("freshness")}</span></div>
      <div class="of-primary"><div><div class="of-label">SHADOW ORDER-FLOW BIAS ${helpIcon("combined")}</div><div class="of-primary-value ${fresh ? biasClass(shadow.bias) : "muted"}">${esc(combinedBias)} ${esc(combinedDir)}</div></div><div class="of-quality">QUALITY<br><strong>${esc(combinedQuality)}</strong></div></div>
      <div class="of-signal-grid"><div class="of-signal"><div class="of-label">10m REGIME ${helpIcon("regime")}</div><div class="of-signal-value ${fresh ? biasClass(shadow.regime_bias) : "muted"}">${esc(regimeBias)}</div><div class="of-detail">${esc(regimeDetail)}</div></div><div class="of-signal"><div class="of-label">SHORT-HORIZON TRIGGER ${helpIcon("trigger")}</div><div class="of-signal-value ${fresh ? biasClass(shadow.trigger_bias) : "muted"}">${esc(triggerBias)}</div><div class="of-detail">${esc(triggerDetail)}</div></div></div>
      <div class="of-agreement-row"><div class="of-label">MODEL AGREEMENT ${helpIcon("agreement")}</div><div class="of-agreement ${agree.cls}">${esc(agree.label)}</div></div>
      ${staleWarning}
      <div class="of-metrics">
        ${metric("5m Delta", signedPct(w5.delta_pct), "delta", biasClass(Number(w5.delta_pct) > 0 ? "BULLISH" : Number(w5.delta_pct) < 0 ? "BEARISH" : ""))}
        ${metric("15m Delta", signedPct(w15.delta_pct), "delta", biasClass(Number(w15.delta_pct) > 0 ? "BULLISH" : Number(w15.delta_pct) < 0 ? "BEARISH" : ""))}
        ${metric("30m Delta", signedPct(w30.delta_pct), "delta", biasClass(Number(w30.delta_pct) > 0 ? "BULLISH" : Number(w30.delta_pct) < 0 ? "BEARISH" : ""))}
        ${metric("Session CVD", signed(cvd.session_cvd, 0), "cvd", biasClass(Number(cvd.session_cvd) > 0 ? "BULLISH" : Number(cvd.session_cvd) < 0 ? "BEARISH" : ""))}
        ${metric("15m CVD", cvd15, "cvd", biasClass(cvd.direction_15m))}
        ${metric("10m POC", poc, "poc")}
        ${metric("Value Area", enumText(ten.value_area_migration?.state), "va", biasClass(ten.value_area_migration?.state))}
        ${metric("15m Imbalance", imbalance, "imbalance", biasClass(Number(w15.imbalance_ratio) > 0 ? "BULLISH" : Number(w15.imbalance_ratio) < 0 ? "BEARISH" : ""))}
        ${metric("5m Stacks", stacks, "stacks")}
      </div>
      <div class="of-state-grid"><div class="of-state"><div class="of-label">DIVERGENCE ${helpIcon("divergence")}</div><div class="of-state-value">${esc(enumText(row.divergence, "NONE"))}</div></div><div class="of-state"><div class="of-label">ABSORPTION ${helpIcon("absorption")}</div><div class="of-state-value">${esc(enumText(row.absorption, "NONE"))}</div></div></div>
      <div class="of-freshness"><span>1m age ${esc(ageText(f1.age_minutes))} / max ${esc(ageText(f1.max_age_minutes))}</span><span>10m age ${esc(ageText(f10.age_minutes))} / max ${esc(ageText(f10.max_age_minutes))}</span></div>
      <div class="of-footnote">Shadow research layer only — production Tradeability remains unchanged.</div>
    </article>`;
  }

  function renderInto(snapshot, containerId) {
    const el = $(containerId);
    if (!el) return;
    el.innerHTML = renderCard(snapshot, "MES") + renderCard(snapshot, "MNQ");
  }

  let recoveryInFlight = false;
  let lastRecoveryId = null;
  let lastRecoveryAt = 0;

  async function recoverLatestOrderflowIfNeeded() {
    const state = window.FM_ORDERFLOW_STATE;
    const client = window.FM_ORDERFLOW_CLIENT;
    const snapshot = state?.latest;

    if (!state || !client || !snapshot?.id) return;
    if (orderflowPayload(snapshot)) return;

    // Only attempt database recovery when uploader metadata says the
    // order-flow file existed. This prevents mixing an older signal into
    // a legitimately missing current cycle.
    if (snapshot?.source_status?.orderflow !== true) return;

    const now = Date.now();

    if (
      recoveryInFlight ||
      (lastRecoveryId === snapshot.id && now - lastRecoveryAt < 5000)
    ) {
      return;
    }

    recoveryInFlight = true;
    lastRecoveryId = snapshot.id;
    lastRecoveryAt = now;

    try {
      const { data, error } = await client
        .from("market_snapshots")
        .select("id,captured_at,orderflow,source_status")
        .eq("id", snapshot.id)
        .maybeSingle();

      if (error) {
        console.warn(`${VERSION}: exact-row orderflow recovery failed`, error);
        return;
      }

      const recovered = orderflowPayload(data);

      if (recovered) {
        snapshot.orderflow = recovered;

        if (state.selected?.id === snapshot.id) {
          state.selected.orderflow = recovered;
        }

        console.log(
          `${VERSION}: recovered orderflow for market_snapshots id=${snapshot.id}`
        );

        renderAll();
      } else {
        console.warn(
          `${VERSION}: row ${snapshot.id} still has no decodable orderflow payload`,
          data
        );
      }
    } catch (error) {
      console.warn(`${VERSION}: recovery exception`, error);
    } finally {
      recoveryInFlight = false;
    }
  }

  function renderAll() {
    const state = window.FM_ORDERFLOW_STATE;
    if (!state) return;

    renderInto(state.latest, "orderFlowCards");
    renderInto(state.selected || state.latest, "historyOrderFlowCards");

    void recoverLatestOrderflowIfNeeded();
  }

  function initTooltip() {
    if ($("ofTooltip")) return;
    const tip = document.createElement("div");
    tip.id = "ofTooltip";
    tip.className = "of-tooltip hidden";
    document.body.appendChild(tip);

    const hide = () => { tip.classList.add("hidden"); tip.textContent = ""; };
    const show = button => {
      const text = HELP[button?.dataset?.ofHelp];
      if (!text) return;
      tip.textContent = text;
      tip.classList.remove("hidden");
      const rect = button.getBoundingClientRect();
      const pad = 10;
      tip.style.width = `${Math.min(360, window.innerWidth - pad * 2)}px`;
      const tr = tip.getBoundingClientRect();
      let left = rect.left + rect.width / 2 - tr.width / 2;
      left = Math.max(pad, Math.min(left, window.innerWidth - tr.width - pad));
      let top = rect.top - tr.height - 10;
      if (top < pad) top = rect.bottom + 10;
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
    };

    document.addEventListener("mouseover", e => { const b = e.target.closest?.(".of-help"); if (b) show(b); });
    document.addEventListener("mouseout", e => { if (e.target.closest?.(".of-help")) hide(); });
    document.addEventListener("click", e => {
      const b = e.target.closest?.(".of-help");
      if (b) { e.preventDefault(); e.stopPropagation(); show(b); }
      else if (!e.target.closest?.("#ofTooltip")) hide();
    });
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
  }

  function initObservers() {
    const targets = [$("instrumentCards"), $("historyInstrumentCards"), $("historySummary"), $("currentCycleBadge")].filter(Boolean);
    const observer = new MutationObserver(() => {
      clearTimeout(window.__ofRenderTimer);
      window.__ofRenderTimer = setTimeout(renderAll, 30);
    });
    targets.forEach(t => observer.observe(t, { childList: true, subtree: true, characterData: true }));
    document.addEventListener("change", e => {
      if (e.target?.id === "historyTimeSelect" || e.target?.id === "historyDate") setTimeout(renderAll, 100);
    });
    document.addEventListener("click", e => {
      if (e.target?.dataset?.tab === "history" || e.target?.id === "loadHistoryButton" || e.target?.id === "refreshButton") setTimeout(renderAll, 150);
    });
    window.addEventListener("fm-orderflow-state-updated", () => {
      setTimeout(renderAll, 0);
    });

    setInterval(renderAll, 2000);
  }

  function boot() {
    initTooltip();
    initObservers();
    renderAll();
    console.log(`${VERSION}: loaded`);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => setTimeout(boot, 50));
  else setTimeout(boot, 50);
})();
