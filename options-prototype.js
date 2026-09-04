(() => {
  "use strict";

  const state = {
    symbol: "SPY",
    dte: 1,
    paused: false,
    selected: { side: "CALL", strike: 767 },
    tick: 0,
    markets: {
      SPY: { spot: 770.18, base: 770.18, change: 0.42, vwap: 768.85, r1: 772.18, r2: 773.42, s2: 767.62, expiry: "Sep 09" },
      QQQ: { spot: 692.42, base: 692.42, change: 0.31, vwap: 690.94, r1: 694.15, r2: 696.08, s2: 689.72, expiry: "Sep 09" }
    }
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const fmt = (n, digits = 2) => Number(n).toFixed(digits);
  const whole = (n) => Math.round(n).toLocaleString("en-US");

  function normalCdf(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989423 * Math.exp(-x * x / 2);
    let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    if (x > 0) p = 1 - p;
    return p;
  }

  function generateChain() {
    const market = state.markets[state.symbol];
    const anchor = Math.floor(market.spot);
    const strikes = Array.from({ length: 10 }, (_, i) => anchor - 4 + i);
    const scale = state.symbol === "SPY" ? 4.25 : 4.9;
    const dteBoost = state.dte === 0 ? 1.18 : 1;
    return strikes.map((strike) => {
      const distance = market.spot - strike;
      const callDelta = Math.min(.94, Math.max(.06, normalCdf(distance / (2.7 * dteBoost))));
      const putDelta = callDelta - 1;
      const timeValue = Math.max(.2, scale * Math.exp(-Math.abs(distance) / (3.3 * dteBoost)));
      const callMid = Math.max(.08, Math.max(0, distance) + timeValue * .54);
      const putMid = Math.max(.08, Math.max(0, -distance) + timeValue * .54);
      const gamma = Math.max(.018, .068 * Math.exp(-Math.abs(distance) / 4.2) / dteBoost);
      const seed = (strike * 137 + (state.symbol === "SPY" ? 211 : 89) + state.dte * 53) % 9000;
      return {
        strike,
        call: { mid: callMid, delta: callDelta, gamma, volume: 1200 + seed * 3, oi: 600 + (seed * 7) % 9800 },
        put: { mid: putMid, delta: putDelta, gamma: gamma * 1.04, volume: 900 + seed * 2, oi: 420 + (seed * 5) % 7600 }
      };
    });
  }

  function currentContract() {
    const chain = generateChain();
    const row = chain.find((item) => item.strike === state.selected.strike) || chain[3];
    return { row, option: state.selected.side === "CALL" ? row.call : row.put };
  }

  function chooseBest() {
    const chain = generateChain();
    const call = chain.find((row) => row.call.delta >= .60 && row.call.delta <= .70);
    const put = [...chain].reverse().find((row) => Math.abs(row.put.delta) >= .60 && Math.abs(row.put.delta) <= .70);
    const bullish = state.markets[state.symbol].change >= 0;
    const best = bullish ? call : put;
    if (best) state.selected = { side: bullish ? "CALL" : "PUT", strike: best.strike };
  }

  function renderDecision() {
    const market = state.markets[state.symbol];
    const { option } = currentContract();
    const side = state.selected.side;
    const spreadPct = Math.max(1.2, 3.1 - option.mid * .28);
    const target = option.mid * 1.3;
    const directionalMove = Math.max(.42, (target - option.mid) / Math.max(.15, Math.abs(option.delta)));
    const targetSpot = market.spot + (side === "CALL" ? directionalMove : -directionalMove);
    const invalidation = side === "CALL" ? market.vwap : market.r1;

    $("#contractSymbol").textContent = state.symbol;
    $("#contractStrike").textContent = state.selected.strike;
    $("#contractSide").textContent = side;
    $("#contractExpiry").textContent = `${market.expiry.toUpperCase()} · ${state.dte}DTE`;
    $("#entryPrice").textContent = `$${fmt(option.mid)}`;
    $("#bidAsk").textContent = `${fmt(option.mid * (1 - spreadPct / 200))} × ${fmt(option.mid * (1 + spreadPct / 200))}`;
    $("#targetPrice").textContent = `$${fmt(target)}`;
    $("#targetMove").textContent = `${state.symbol} ≈ ${fmt(targetSpot)}`;
    $("#metricDelta").textContent = fmt(option.delta, 4);
    $("#metricGamma").textContent = fmt(option.gamma, 4);
    $("#metricSpread").textContent = `${fmt(spreadPct, 1)}%`;
    $("#metricLiquidity").textContent = option.volume > 4000 ? "A+" : "A";
    $("#metricOiVol").textContent = `OI ${whole(option.oi)} · Vol ${whole(option.volume)}`;
    $("#metricMove").textContent = `${side === "CALL" ? "+" : "−"}${fmt(directionalMove / market.spot * 100, 2)}%`;
    $("#invalidationPrice").textContent = `${state.symbol} ${side === "CALL" ? "<" : ">"} ${fmt(invalidation)}`;
    $("#signalConfidence").textContent = `${Math.round(72 + Math.abs(option.delta) * 9)}% CONVICTION`;
    $("#modelRead").innerHTML = side === "CALL"
      ? `<strong>Continuation favored above VWAP.</strong> Price is holding the value edge with futures flow aligned. The ${state.selected.strike} call offers the best balance of directional exposure, spread, and required underlying move.`
      : `<strong>Rejection favored below supply.</strong> Price is failing the upper value edge with selling pressure aligned. The ${state.selected.strike} put offers the cleanest liquid exposure inside the target delta band.`;
  }

  function renderMarket() {
    const market = state.markets[state.symbol];
    $("#spotPrice").textContent = fmt(market.spot);
    $("#spotChange").textContent = `${market.change >= 0 ? "+" : ""}${fmt(market.change)}%`;
    $("#spotChange").className = market.change >= 0 ? "positive" : "negative";
    $("#spyRibbonPrice").textContent = `$${fmt(state.markets.SPY.spot)}`;
    $("#mapSpot").textContent = fmt(market.spot);
    $("#r1Level").textContent = fmt(market.r1);
    $("#r2Level").textContent = fmt(market.r2);
    $("#s1Level").textContent = fmt(market.vwap);
    $("#s2Level").textContent = fmt(market.s2);
    $("#chainSymbol").textContent = state.symbol;
    $("#chainExpiry").textContent = market.expiry;
    $("#chartHeading").textContent = `${state.symbol} · 1 minute`;
    $("#regimeText").textContent = market.change >= 0 ? "TREND UP" : "TREND DOWN";
    $("#chartPriceLabel").textContent = fmt(market.spot);
  }

  function renderChain() {
    const rows = generateChain();
    const onlyEligible = $("#deltaFilter").checked;
    $("#chainBody").innerHTML = rows.map((row) => {
      const callEligible = row.call.delta >= .60 && row.call.delta <= .70;
      const putEligible = Math.abs(row.put.delta) >= .60 && Math.abs(row.put.delta) <= .70;
      const selected = row.strike === state.selected.strike;
      const dimmed = onlyEligible && !callEligible && !putEligible;
      return `<tr class="${selected ? "selected" : ""} ${dimmed ? "dimmed" : ""}">
        <td><button class="pick-button ${selected && state.selected.side === "CALL" ? "active" : ""}" data-pick="CALL:${row.strike}" type="button" aria-label="Select ${state.symbol} ${row.strike} call">C</button></td>
        <td class="${callEligible ? "eligible" : ""}">${fmt(row.call.mid)}</td>
        <td class="${callEligible ? "eligible" : ""}">${fmt(row.call.delta, 3)}</td>
        <td>${fmt(row.call.gamma, 4)}</td><td>${whole(row.call.volume)}</td><td>${whole(row.call.oi)}</td>
        <td class="strike">${fmt(row.strike)}</td>
        <td>${whole(row.put.oi)}</td><td>${whole(row.put.volume)}</td><td>${fmt(row.put.gamma, 4)}</td>
        <td class="${putEligible ? "eligible" : ""}">${fmt(row.put.delta, 3)}</td>
        <td class="${putEligible ? "eligible" : ""}">${fmt(row.put.mid)}</td>
        <td><button class="pick-button put ${selected && state.selected.side === "PUT" ? "active" : ""}" data-pick="PUT:${row.strike}" type="button" aria-label="Select ${state.symbol} ${row.strike} put">P</button></td>
      </tr>`;
    }).join("");
    $$('[data-pick]').forEach((button) => button.addEventListener("click", () => {
      const [side, strike] = button.dataset.pick.split(":");
      state.selected = { side, strike: Number(strike) };
      renderAll(false);
      toast(`${state.symbol} ${strike} ${side} selected for comparison`);
      document.querySelector("#decision").scrollIntoView({ behavior: "smooth", block: "start" });
    }));
  }

  function drawChart() {
    const canvas = $("#marketChart");
    const wrap = canvas.parentElement;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(300, wrap.clientWidth);
    const height = Math.max(160, wrap.clientHeight);
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    const ctx = canvas.getContext("2d");
    ctx.scale(ratio, ratio);
    ctx.clearRect(0, 0, width, height);

    const market = state.markets[state.symbol];
    const points = Array.from({ length: 46 }, (_, i) => {
      const trend = i * .045;
      const wave = Math.sin(i * .48) * .3 + Math.sin(i * .13) * .22;
      return market.base - 2.1 + trend + wave + (state.tick % 9) * .012;
    });
    points[points.length - 1] = market.spot;
    const high = Math.max(...points, market.r1) + .35;
    const low = Math.min(...points, market.vwap) - .35;
    const x = (i) => 10 + i * (width - 42) / (points.length - 1);
    const y = (v) => 8 + (high - v) / (high - low) * (height - 20);

    ctx.strokeStyle = "rgba(106,130,153,.12)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 5; i++) { ctx.beginPath(); ctx.moveTo(0, i * height / 5); ctx.lineTo(width, i * height / 5); ctx.stroke(); }

    const level = (price, color, dash) => {
      ctx.save(); ctx.strokeStyle = color; ctx.setLineDash(dash); ctx.beginPath(); ctx.moveTo(0, y(price)); ctx.lineTo(width, y(price)); ctx.stroke(); ctx.restore();
    };
    level(market.vwap, "rgba(169,150,255,.75)", [5, 5]);
    level(market.r1, "rgba(51,211,156,.5)", [3, 5]);

    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, "rgba(67,199,232,.22)");
    gradient.addColorStop(1, "rgba(67,199,232,0)");
    ctx.beginPath(); ctx.moveTo(x(0), height); points.forEach((point, i) => ctx.lineTo(x(i), y(point))); ctx.lineTo(x(points.length - 1), height); ctx.closePath(); ctx.fillStyle = gradient; ctx.fill();
    ctx.beginPath(); points.forEach((point, i) => i ? ctx.lineTo(x(i), y(point)) : ctx.moveTo(x(i), y(point))); ctx.strokeStyle = "#43c7e8"; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = "#43c7e8"; ctx.beginPath(); ctx.arc(x(points.length - 1), y(points.at(-1)), 3.5, 0, Math.PI * 2); ctx.fill();
    $("#chartPriceLabel").style.top = `${y(market.spot)}px`;
  }

  function renderAll(rechoose = false) {
    if (rechoose) chooseBest();
    renderMarket();
    renderDecision();
    renderChain();
    drawChart();
  }

  function toast(message) {
    const el = $("#toast");
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove("show"), 2400);
  }

  function recalculate() {
    const button = $("#refreshButton");
    button.classList.add("busy");
    $("#quoteAge").textContent = "calculating";
    setTimeout(() => {
      chooseBest(); renderAll(false);
      $("#modelLatency").textContent = `${142 + Math.round(Math.random() * 74)} ms`;
      $("#totalLatency").textContent = `${258 + Math.round(Math.random() * 82)} ms`;
      button.classList.remove("busy");
      $("#quoteAge").textContent = `${60 + Math.round(Math.random() * 55)} ms ago`;
      toast("Market state recalculated · candidate refreshed");
    }, 650);
  }

  function bind() {
    $$('[data-symbol]').forEach((button) => button.addEventListener("click", () => {
      state.symbol = button.dataset.symbol;
      $$('[data-symbol]').forEach((item) => item.classList.toggle("active", item === button));
      chooseBest(); renderAll(false); toast(`${state.symbol} workspace loaded`);
    }));
    $$('[data-dte]').forEach((button) => button.addEventListener("click", () => {
      state.dte = Number(button.dataset.dte);
      $$('[data-dte]').forEach((item) => item.classList.toggle("active", item === button));
      chooseBest(); renderAll(false); toast(`${state.dte}DTE contracts loaded`);
    }));
    $("#deltaFilter").addEventListener("change", renderChain);
    $("#refreshButton").addEventListener("click", recalculate);
    $("#chainRefresh").addEventListener("click", recalculate);
    $("#pauseButton").addEventListener("click", () => {
      state.paused = !state.paused;
      $("#pauseButton").classList.toggle("paused", state.paused);
      $("#pauseButton").setAttribute("aria-label", state.paused ? "Resume simulated feed" : "Pause simulated feed");
      toast(state.paused ? "Simulated feed paused" : "Simulated feed resumed");
    });
    window.addEventListener("resize", drawChart);
  }

  function clockTick() {
    $("#marketClock").textContent = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date()) + " CT";
    $("#cycleAge").textContent = `${(0.2 + Math.random() * .3).toFixed(1)}s`;
    if (state.paused) return;
    state.tick += 1;
    const market = state.markets[state.symbol];
    const impulse = Math.sin(state.tick * .7) * .015 + (Math.random() - .5) * .025;
    market.spot = Math.max(market.base - .45, Math.min(market.base + .55, market.spot + impulse));
    $("#quoteAge").textContent = `${45 + Math.round(Math.random() * 95)} ms ago`;
    renderMarket(); renderDecision(); drawChart();
  }

  bind();
  chooseBest();
  renderAll(false);
  clockTick();
  setInterval(clockTick, 1250);
})();
