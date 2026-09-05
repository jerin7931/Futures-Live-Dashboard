(() => {
  "use strict";
  const config = window.OPTIONS_COMMAND_CONFIG || {};
  const db = window.supabase?.createClient?.(config.supabaseUrl, config.supabasePublishableKey);
  const $ = (selector) => document.querySelector(selector);
  const all = (selector) => [...document.querySelectorAll(selector)];
  let channel;
  let signals = new Map();
  const num = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const money = (value) => value == null ? "—" : `$${num(value).toFixed(2)}`;
  const pct = (value, digits = 1) => value == null ? "—" : `${(num(value) * 100).toFixed(digits)}%`;
  const sec = (value) => value == null ? "—" : `${num(value).toFixed(1)}s`;
  const text = (selector, value) => { const node = $(selector); if (node) node.textContent = value ?? "—"; };

  function zoneLabel(zone) {
    if (!zone) return "—";
    return `${num(zone.lower_bound).toFixed(2)}–${num(zone.upper_bound).toFixed(2)} · ${Math.round(num(zone.zone_strength) * 100)}%`;
  }

  function paintPrimary(signal) {
    text("#primaryState", signal.display_state);
    text("#primaryType", String(signal.setup_type || "—").replaceAll("_", " "));
    text("#qualityValue", `${Math.round(num(signal.setup_quality))} / 100`);
    text("#dominantReason", String(signal.primary_reason || "—").replaceAll("_", " "));
    text("#stateAge", sec(signal.state_age_seconds));
    text("#flowPersistence", pct(signal.flow_persistence));
    text("#directionCore", num(signal.directional_core).toFixed(3));
    text("#pathClearance", `${Math.round(num(signal.path_clearance) * 100)} / 100`);
    text("#actualTte", `${num(signal.actual_tte_minutes).toFixed(0)} min`);
    const heading = $("#primaryState");
    heading.className = signal.direction === "CALL" ? "tone-call" : signal.direction === "PUT" ? "tone-put" : "tone-warn";

    const option = signal.option;
    text("#contractName", option ? `${option.symbol} · ${option.strike} ${option.type}` : "NO EXECUTABLE QUOTE");
    text("#contractExpiry", option ? `${option.expiration} · entry basis is current Webull ask` : `${signal.webull_status || "UNAVAILABLE"} · Webull OPRA snapshot required`);
    text("#contractDelta", option ? num(option.delta).toFixed(4) : "—");
    text("#contractBid", option ? money(option.bid) : "—");
    text("#contractAsk", option ? money(option.ask) : "—");
    text("#contractSpread", option ? `${money(option.spread)} · ${pct(option.relative_spread)}` : "—");
    text("#quoteAge", option ? sec(option.quote_age) : "—");
    text("#optionTarget", option ? money(option.target_option_price) : "—");

    const neutral = (signal.required_move_scenarios?.rows || []).filter((row) => row.iv_shock === 0 && [0, 5, 15, 30].includes(row.elapsed_minutes));
    const wrap = $("#scenarioRows"); wrap.replaceChildren();
    if (!neutral.length) wrap.innerHTML = "<p>No valid candidate scenario.</p>";
    neutral.forEach((row) => {
      const div = document.createElement("div");
      const when = document.createElement("span"); when.textContent = row.elapsed_minutes ? `+${row.elapsed_minutes}m` : "NOW";
      const priceNode = document.createElement("b"); priceNode.textContent = row.required_underlying_price == null ? "NO ROOT" : money(row.required_underlying_price);
      const move = document.createElement("b"); move.textContent = row.required_move_pct == null ? "—" : pct(row.required_move_pct, 2);
      div.append(when, priceNode, move); wrap.append(div);
    });
    const stress = (signal.required_move_scenarios?.rows || []).find((row) => row.elapsed_minutes === 15 && row.iv_shock === -.25);
    text("#stressScenario", stress?.required_move_pct == null ? "NO ROOT / unavailable" : `${money(stress.required_underlying_price)} · ${pct(stress.required_move_pct, 2)}`);

    text("#nextObstacle", zoneLabel(signal.next_obstacle_zone));
    text("#supportBehind", zoneLabel(signal.support_zone));
    text("#spotPrice", money(signal.cash_price));
    const confirmations = [
      ["ES / FUTURES", signal.futures_flow_evidence], ["SPY CASH", signal.cash_evidence],
      ["STRUCTURE", signal.structure_evidence], ["QUANT OPTIONS FLOW", signal.reason_codes?.includes("OPTIONS_FLOW_CONFLICT") ? -1 : 0],
      ["OPTION QUOTE", signal.option ? 1 : -1], ["TARGET PATH", num(signal.path_clearance) >= .35 ? 1 : -1]
    ];
    const c = $("#confirmations"); c.replaceChildren();
    confirmations.forEach(([label, value]) => { const row = document.createElement("div"); const name = document.createElement("span"); name.textContent = label;
      const status = document.createElement("b"); status.textContent = value > .15 ? "CONFIRMS" : value < -.15 ? "CONFLICTS" : "NEUTRAL"; status.className = value < -.15 ? "bad" : value > .15 ? "good" : ""; row.append(name, status); c.append(row); });
    fillList("#kills", signal.what_kills_it || []); fillList("#readyRequirements", signal.what_would_make_ready || []);
    const health = signal.data_health || {};
    const items = [["ES/NQ age", health.futures_age, "s"], ["Cash age", health.cash_age, "s"], ["Cash L2 age", health.cash_l2_age, "s"],
      ["OPRA quote age", health.option_quote_age, "s"], ["Quant flow age", health.quantdata_option_flow_age, "s"], ["Quant GEX age", health.quantdata_gex_age, "s"],
      ["Quant skew age", health.quantdata_skew_age, "s"], ["Quant OI age", health.quantdata_oi_age, "s"], ["Greeks age", health.greeks_age, "s"], ["Clock skew", health.clock_skew_seconds, "s"],
      ["Rollover", health.rollover_status, ""], ["Webull", signal.webull_status, ""], ["Quant Data", signal.quantdata_status, ""]];
    const grid = $("#healthGrid"); grid.replaceChildren(); items.forEach(([label, value, unit]) => { const div = document.createElement("div"); const a = document.createElement("span"); a.textContent = label;
      const b = document.createElement("b"); b.textContent = typeof value === "number" ? `${value.toFixed(2)}${unit}` : value ?? "—"; div.append(a, b); grid.append(div); });
    text("#diagnostics", JSON.stringify({reason_codes: signal.reason_codes, arming: signal.arming, contract_switch_state: signal.contract_switch_state, shadow_metrics: signal.shadow_metrics, latency: signal.latency, timestamp_lineage: signal.timestamp_lineage}, null, 2));
    const status = health.status || "DEGRADED"; text("#healthLabel", `DATA ${status}`); text("#healthDetail", `${signal.webull_status} Webull · ${signal.quantdata_status} Quant`);
    $("#healthDot").style.background = status === "OK" ? "var(--green)" : status === "BLOCKED" ? "var(--red)" : "var(--amber)";
  }

  function fillList(selector, values) { const ul = $(selector); ul.replaceChildren(); (values.length ? values : ["—"]).forEach((value) => { const li = document.createElement("li"); li.textContent = value; ul.append(li); }); }

  function paint() {
    const primary = signals.get("SPY_1DTE");
    if (primary) paintPrimary(primary.payload || primary);
    all(".mini").forEach((card) => { const row = signals.get(card.dataset.key); if (!row) return; const signal = row.payload || row;
      card.querySelector("h2").textContent = signal.display_state; card.querySelector("p").textContent = `${String(signal.setup_type).replaceAll("_", " ")} · quality ${Math.round(num(signal.setup_quality))}/100`;
      card.querySelector("small").textContent = String(signal.primary_reason).replaceAll("_", " "); });
  }

  async function fetchState() {
    const { data, error } = await db.from("options_signal_v2_live").select("*");
    if (error) throw error;
    signals = new Map((data || []).map((row) => [row.market_key, row])); paint();
  }

  async function connect(session) {
    const { data, error } = await db.from("dashboard_readers").select("user_id").eq("user_id", session.user.id).maybeSingle();
    if (error || !data) throw error || new Error("This account is not authorized.");
    document.documentElement.classList.add("unlocked"); text("#authButton", "Sign out");
    await fetchState();
    channel = db.channel("tradytics-v2-shadow").on("postgres_changes", {event:"*",schema:"public",table:"options_signal_v2_live"}, fetchState).subscribe();
  }

  $("#loginForm").addEventListener("submit", async (event) => { event.preventDefault(); text("#loginError", ""); try {
    const {data,error} = await db.auth.signInWithPassword({email:$("#email").value,password:$("#password").value}); if(error) throw error; await connect(data.session);
  } catch(error) { text("#loginError", error.message || "Sign-in failed"); }});
  $("#authButton").addEventListener("click", async () => { if(document.documentElement.classList.contains("unlocked")){ if(channel) await db.removeChannel(channel); await db.auth.signOut(); location.reload(); }});
  $("#refreshButton").addEventListener("click", () => fetchState().catch((error) => text("#diagnostics", error.message)));
  setInterval(() => text("#clock", new Intl.DateTimeFormat("en-US",{timeZone:"America/Chicago",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).format(new Date())+" CT"),1000);
  if(!db){text("#loginError","Supabase client unavailable");return;}
  db.auth.getSession().then(({data}) => data.session && connect(data.session).catch(async(error)=>{await db.auth.signOut();text("#loginError",error.message);}));
})();
