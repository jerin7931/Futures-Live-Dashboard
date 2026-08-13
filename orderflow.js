(() => {
  "use strict";

  const VERSION = "ORDERFLOW_WEB_V2_PRODUCTION";

  const HELP = {
    section: "ES order flow is paired with MES and NQ order flow is paired with MNQ. This is now a production execution input capped at 10% of directional confluence while calibration is still provisional.",
    combined: "Production order-flow direction uses 20% auction regime + 80% short-horizon trigger. The effective direction is then reduced when evidence quality is weak or divergence/absorption conflicts with the signal.",
    regime: "The V2 regime emphasizes accepted value: price location versus the 10-minute value area/POC, value migration, 30-minute Delta, and 10-minute imbalance structure.",
    trigger: "The short-horizon trigger emphasizes 5-minute Delta, then 15-minute Delta, 15-minute imbalance structure, and qualifying stacked imbalances.",
    delta: "Footprint Delta = estimated buy volume minus estimated sell volume. Positive favors buying pressure; negative favors selling pressure.",
    cvd: "RTH Session CVD accumulates footprint Delta. Recent CVD direction is shown for context; raw CVD change is not double-counted as a separate production vote.",
    poc: "Footprint POC is the highest-volume price row of the completed 10-minute footprint. Migration helps identify where accepted auction activity is shifting.",
    va: "Value Area migration tracks the midpoint of VAH and VAL. Rising accepted value supports upside acceptance; falling value supports downside acceptance.",
    imbalance: "Imbalance ratio compares buy versus sell imbalances. V2 prefers imbalance volume when available and falls back to imbalance counts for legacy rows.",
    stacks: "A stacked imbalance contributes only when at least three consecutive qualifying footprint rows occur. Conflicting buy and sell stacks cancel.",
    divergence: "Meaningful disagreement between price and Delta does not become another directional vote; it haircuts a conflicting production signal.",
    absorption: "Strong aggressive Delta with no corresponding price progress is treated as possible absorption and haircuts the direction being absorbed.",
    agreement: "Compares the production MES/MNQ directional bias with fresh ES/NQ order flow. Order flow itself is already included in the model at a capped 10% weight, so this label is descriptive rather than a second vote.",
    freshness: "Production guard: the analyzer targets <=3 minutes for the latest 1-minute footprint and <=12 minutes for the 10-minute footprint. A stale source contributes zero model weight."
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
    return Number.isFinite(n) ? `${signed(n, 2)}%` : "—";
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

  function orderflowRow(snapshot, executionSymbol) {
    const futuresSymbol = executionSymbol === "MES" ? "ES" : "NQ";
    return { futuresSymbol, row: snapshot?.orderflow?.instruments?.[futuresSymbol] || null };
  }

  function baseBias(snapshot, executionSymbol) {
    return snapshot?.attraction?.instruments?.[executionSymbol]?.bias ||
      snapshot?.[executionSymbol.toLowerCase() + "_bias"] || null;
  }

  function productionModel(row) {
    return row?.production_model || row?.shadow_model || null;
  }

  function agreement(snapshot, executionSymbol, row) {
    const model = productionModel(row);
    if (!row || row.data_status !== "FRESH" || model?.signal_status !== "FRESH") {
      return { label: "NOT EVALUATED", cls: "stale" };
    }
    const modelSign = biasSign(baseBias(snapshot, executionSymbol));
    const flowSign = biasSign(model.bias);
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
      return `<article class="of-card"><div class="of-top"><div><div class="of-symbol">${futuresSymbol} ORDER FLOW</div><div class="of-map">${futuresSymbol} → ${executionSymbol}</div></div><span class="of-status missing">NO DATA</span></div><div class="of-empty">No saved order-flow snapshot exists for this cycle.</div></article>`;
    }

    const model = productionModel(row) || {};
    const usingProduction = Boolean(row.production_model);
    const fresh = row.data_status === "FRESH" && model.signal_status === "FRESH";
    const w5 = row.windows?.["5m"] || {};
    const w15 = row.windows?.["15m"] || {};
    const cvd = row.cvd || {};
    const ten = row.ten_minute || {};
    const f1 = row.freshness?.["1m"] || {};
    const f10 = row.freshness?.["10m"] || {};
    const agree = agreement(snapshot, executionSymbol, row);

    const effectiveDirection = model.effective_direction ?? model.combined_direction;
    const combinedBias = fresh ? enumText(model.bias) : "STALE NO SIGNAL";
    const combinedDir = fresh ? signed(effectiveDirection, 3) : "";
    const combinedQuality = fresh ? num(model.combined_quality, 1) : "—";
    const regimeBias = fresh ? enumText(model.regime_bias) : "STALE";
    const triggerBias = fresh ? enumText(model.trigger_bias) : "STALE";
    const regimeDetail = fresh ? `${signed(model.regime_direction, 3)} · Q ${num(model.regime_quality, 1)}` : "No current signal";
    const triggerDetail = fresh ? `${signed(model.trigger_direction, 3)} · Q ${num(model.trigger_quality, 1)}` : "No current signal";
    const cvd15 = cvd.direction_15m && cvd.direction_15m !== "INSUFFICIENT_DATA" ? `${enumText(cvd.direction_15m)} ${signed(cvd.change_15m, 0)}` : "—";
    const poc = Number.isFinite(Number(ten.poc_price)) ? `${num(ten.poc_price, 2)} · ${enumText(ten.poc_migration?.state)}` : "—";
    const imbalanceValue = w15.imbalance_volume_ratio ?? w15.imbalance_ratio;
    const imbalance = Number.isFinite(Number(imbalanceValue)) ? signed(imbalanceValue, 3) : "—";
    const stacks = `${num(w5.max_buy_stack, 0)}B / ${num(w5.max_sell_stack, 0)}S`;

    const sourceLabel = usingProduction ? "PRODUCTION V2 · 10% MAX" : "LEGACY ROW · COMPATIBILITY";
    const staleWarning = fresh ? "" : `<div class="of-stale-warning"><strong>STALE — zero production weight.</strong><br>The freshness guard invalidated the current order-flow contribution. Stored metrics below are audit values only.</div>`;
    const modifier = fresh && Number.isFinite(Number(model.conflict_modifier)) && Number(model.conflict_modifier) < 0.999
      ? `<div class="of-stale-warning"><strong>CONFLICT HAIRCUT ${num(Number(model.conflict_modifier) * 100, 0)}%</strong><br>${esc((model.conflict_reasons || []).join(" · "))}</div>`
      : "";

    return `<article class="of-card ${fresh ? "fresh" : "stale"}">
      <div class="of-top"><div><div class="of-symbol">${futuresSymbol} ORDER FLOW</div><div class="of-map">${futuresSymbol} futures auction → ${executionSymbol} execution context</div></div><span class="of-status ${fresh ? "fresh" : "stale"}">${fresh ? "FRESH" : "STALE"} ${helpIcon("freshness")}</span></div>
      <div class="of-primary"><div><div class="of-label">${sourceLabel} ${helpIcon("combined")}</div><div class="of-primary-value ${fresh ? biasClass(model.bias) : "muted"}">${esc(combinedBias)} ${esc(combinedDir)}</div></div><div class="of-quality">QUALITY<br><strong>${esc(combinedQuality)}</strong></div></div>
      <div class="of-signal-grid"><div class="of-signal"><div class="of-label">AUCTION REGIME ${helpIcon("regime")}</div><div class="of-signal-value ${fresh ? biasClass(model.regime_bias) : "muted"}">${esc(regimeBias)}</div><div class="of-detail">${esc(regimeDetail)}</div></div><div class="of-signal"><div class="of-label">SHORT-HORIZON TRIGGER ${helpIcon("trigger")}</div><div class="of-signal-value ${fresh ? biasClass(model.trigger_bias) : "muted"}">${esc(triggerBias)}</div><div class="of-detail">${esc(triggerDetail)}</div></div></div>
      <div class="of-agreement-row"><div class="of-label">MODEL AGREEMENT ${helpIcon("agreement")}</div><div class="of-agreement ${agree.cls}">${esc(agree.label)}</div></div>
      ${staleWarning}${modifier}
      <div class="of-metrics">
        ${metric("5m Delta", signedPct(w5.delta_pct), "delta", biasClass(Number(w5.delta_pct) > 0 ? "BULLISH" : Number(w5.delta_pct) < 0 ? "BEARISH" : ""))}
        ${metric("15m Delta", signedPct(w15.delta_pct), "delta", biasClass(Number(w15.delta_pct) > 0 ? "BULLISH" : Number(w15.delta_pct) < 0 ? "BEARISH" : ""))}
        ${metric("Session CVD", signed(cvd.session_cvd, 0), "cvd", biasClass(Number(cvd.session_cvd) > 0 ? "BULLISH" : Number(cvd.session_cvd) < 0 ? "BEARISH" : ""))}
        ${metric("15m CVD", cvd15, "cvd", biasClass(cvd.direction_15m))}
        ${metric("10m POC", poc, "poc")}
        ${metric("Value Area", enumText(ten.value_area_migration?.state), "va", biasClass(ten.value_area_migration?.state))}
        ${metric("15m Imbalance", imbalance, "imbalance", biasClass(Number(imbalanceValue) > 0 ? "BULLISH" : Number(imbalanceValue) < 0 ? "BEARISH" : ""))}
        ${metric("5m Stacks", stacks, "stacks")}
      </div>
      <div class="of-state-grid"><div class="of-state"><div class="of-label">DIVERGENCE ${helpIcon("divergence")}</div><div class="of-state-value">${esc(enumText(row.divergence, "NONE"))}</div></div><div class="of-state"><div class="of-label">ABSORPTION ${helpIcon("absorption")}</div><div class="of-state-value">${esc(enumText(row.absorption, "NONE"))}</div></div></div>
      <div class="of-freshness"><span>1m age ${esc(ageText(f1.age_minutes))} / max ${esc(ageText(f1.max_age_minutes))}</span><span>10m age ${esc(ageText(f10.age_minutes))} / max ${esc(ageText(f10.max_age_minutes))}</span></div>
      <div class="of-footnote">Production execution input — capped at 10% of directional confluence while Thu/Fri calibration is pending.</div>
    </article>`;
  }

  function renderInto(snapshot, containerId) {
    const el = $(containerId);
    if (!el) return;
    el.innerHTML = renderCard(snapshot, "MES") + renderCard(snapshot, "MNQ");
  }

  function renderAll() {
    const state = window.FM_ORDERFLOW_STATE;
    if (!state) return;
    renderInto(state.latest, "orderFlowCards");
    renderInto(state.selected || state.latest, "historyOrderFlowCards");
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
