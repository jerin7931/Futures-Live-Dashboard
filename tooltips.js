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
      "Research section for model performance, tradeability history and future evaluated outcomes such as directional accuracy, MFE, MAE and target hits.",
    explorer:
      "Inspect the complete saved GEX ladder and raw structured snapshot data instead of only the compact Live cards.",
    gex_table:
      "Opens the complete ranked GEX ladder for this symbol, including strike, GEX magnitude, relation to spot, distance, priority and temporal context.",
    target_details:
      "Opens the component breakdown behind the primary upside and downside Attraction Engine targets.",
    preference:
      "Preferred instrument compares MES and MNQ tradeability. No clear preference means both scores are weak; Similar means their scores are close enough that neither has a meaningful advantage.",
  };

  const TOOLTIP_ID = "dashboardTooltip";

  const q = (root, selector) => [...root.querySelectorAll(selector)];
  const clean = (value) => String(value || "").trim().replace(/\s+/g, " ");

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
      const eyebrow = clean(section.querySelector(".eyebrow")).toUpperCase();
      const h2 = section.querySelector("h2");
      if (!h2) return;
      if (eyebrow.includes("CURRENT CYCLE")) addIcon(h2, "current_cycle", "Explain current cycle");
      if (eyebrow.includes("SESSION RESEARCH")) addIcon(h2, "analytics", "Explain analytics");
    });

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

    const observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) hydrate(node);
        }
      }
    });
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
