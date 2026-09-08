(() => {
  "use strict";
  const cfg = window.PREDICTIVE_LIVE_CONFIG || {};
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const modelOrder = ["SPY_OPTIONS_ONLY", "SPY_OPTIONS_PLUS_ES", "QQQ_OPTIONS_ONLY", "QQQ_OPTIONS_PLUS_NQ"];
  const providerHealthIds = ["QUANT_DATA","QUANT_CONTEXT","WEBULL","NINJATRADER_ES","NINJATRADER_NQ","V2_STRUCTURE_SPY","V2_STRUCTURE_QQQ","SUPABASE","MODEL_ARTIFACTS"];
  const modelNames = {
    SPY_OPTIONS_ONLY: ["SPY", "OPTIONS ONLY"], SPY_OPTIONS_PLUS_ES: ["SPY", "OPTIONS + ES"],
    QQQ_OPTIONS_ONLY: ["QQQ", "OPTIONS ONLY"], QQQ_OPTIONS_PLUS_NQ: ["QQQ", "OPTIONS + NQ"]
  };
  const state = {models: {}, contexts: {}, gex: {}, ladder: new Map(), health: {}, cards: new Map(), channel: null,
    symbol: "SPY", side: "ALL", scope: "FULL_CHAIN", demo: new URLSearchParams(location.search).get(cfg.demoQueryParameter || "demo") === "1"};
  let client = null;

  const safeNumber = value => Number.isFinite(Number(value)) ? Number(value) : null;
  const percent = value => value == null ? "—" : `${(100 * Number(value)).toFixed(1)}%`;
  const fixed = (value, digits = 2) => safeNumber(value) == null ? "—" : safeNumber(value).toFixed(digits);
  const integer = value => safeNumber(value) == null ? "—" : Math.round(safeNumber(value)).toLocaleString();
  const age = ms => ms == null ? "—" : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
  const currentAge = (stamp, fallback) => { const parsed=Date.parse(stamp||""); return Number.isFinite(parsed)?Math.max(0,Date.now()-parsed):fallback; };
  const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[ch]));

  function demoData() {
    const now = new Date().toISOString();
    const ladder = {"0.05":.82,"0.1":.66,"0.15":.53,"0.2":.44,"0.25":.36,"0.3":.30};
    modelOrder.forEach((id, index) => state.models[id] = {
      model_id:id, model_version:["90251f3f273e","3c500abb76a5","2b38c06036a4","96b1c47e3e88"][index],
      symbol:modelNames[id][0], state:index === 2 ? "WARNING" : "LIVE", guidance_state:"LIVE",
      thesis_state:index === 2 ? "WARNING" : "LIVE", setup_episode_id:`demo-${index+1}`, direction:index < 2 ? "CALL" : "PUT",
      grade:index === 1 ? "A" : index === 3 ? "B" : "C", probability:[.128,.284,.112,.181][index],
      selected_contract_probability_at_selection:[.128,.284,.112,.181][index], selected_contract_event_time:now,
      latest_same_side_probability:[.128,.284,.112,.181][index], latest_same_side_event_time:now,
      latest_same_side_age_ms:780+index*90, latest_same_side_fresh:true,
      latest_opposite_side_probability:[.16,.16,.13,.13][index], latest_opposite_side_event_time:now,
      latest_opposite_side_age_ms:920+index*90, latest_opposite_side_fresh:true,
      aim_for_percent:[12,16,10,14][index], target_premium:[2.41,2.50,1.73,1.82][index], ladder,
      candidate_contract:index < 2 ? "SPY260908C00650000" : "QQQ260908P00582000", expiration:"2026-09-08",
      strike:index < 2 ? 650 : 582, delta:index < 2 ? .65 : -.64, bid:index < 2 ? 2.11 : 1.51, ask:index < 2 ? 2.14 : 1.54,
      relative_spread:index < 2 ? .014 : .019, model_event_time:now, model_age_ms:780 + index*90,
      latest_quote_time:now, quote_age_ms:180 + index*45, invalid_if:index < 2 ? "Invalid if SPY accepts below 647.80 support" : "Invalid if QQQ accepts above 585.40 resistance",
      mapping_effective_n:850 + index*74, score_band:index === 1 ? ">=25%" : "10% to <15%"
    });
    for (const symbol of ["SPY","QQQ"]) {
      state.contexts[symbol] = {symbol, gamma_regime:symbol === "SPY" ? "POSITIVE GAMMA" : "MIXED / NEAR NEUTRAL",
        market_condition:symbol === "SPY" ? "BULLISH" : "TRANSITION / MIXED", gamma_balance:symbol === "SPY" ? .31 : -.04,
        reasons:symbol === "SPY" ? ["positive call-side flow","above accepted VWAP","support holding"] : ["mixed option flow","near VWAP","volatility firming"], session:{state:"OPEN",calendar_version:"NYSE_RTH_RULES_2025_2030_V1"}, as_of:now};
      const spot = symbol === "SPY" ? 649.6 : 583.1, rows = [];
      for (let i=-6;i<=6;i++) rows.push({strike:Math.round(spot/2)*2+i*2,value:(Math.sin(i*.8)+(i<0?-.35:.25))*1e9});
      state.gex[`${symbol}:CURRENT:FULL_CHAIN`] = {symbol,surface_kind:"CURRENT",scope:"FULL_CHAIN",spot,as_of:now,points:rows};
      state.gex[`${symbol}:INTRADAY_DELTA:FULL_CHAIN`] = {symbol,surface_kind:"INTRADAY_DELTA",scope:"FULL_CHAIN",spot,as_of:now,points:rows.map((row,i)=>({...row,value:row.value*(.2+(.05*i))}))};
    }
    [646,648,650,652,654,580,582,584,586].forEach((strike,index) => {
      const symbol = strike > 600 ? "SPY" : "QQQ", side = index % 2 ? "PUT" : "CALL", delta = side === "CALL" ? .61 + (index%4)*.025 : -.62-(index%3)*.02;
      const key=`${symbol}260908${side[0]}${String(strike*1000).padStart(8,"0")}`;
      state.ladder.set(key,{contract_key:key,symbol,expiration:"2026-09-08",strike,contract_type:side,dte:1,actual_tte_minutes:730,
        bid:1.45+index*.11,ask:1.48+index*.11,bid_size:12+index,ask_size:10+index,last:1.46+index*.11,volume:1800+index*240,open_interest:5300+index*310,
        delta,gamma:.018-index*.0004,theta:-.21,vega:.12,iv:.24+index*.007,vanna:.008,charm:-.004,gex:(index-4)*8.2e7,
        flow_context:index%3===0?"BUYING":"MIXED",quote_age_ms:150+index*31,greek_age_ms:2400+index*110,eligible:Math.abs(delta)>=.60&&Math.abs(delta)<=.70,
        selected:index===2||index===6,model_probability:index===2?.284:index===6?.181:.07+index*.012,grade:index===2?"A":index===6?"B":null,aim_for_percent:index===2?16:index===6?14:null});
    });
    providerHealthIds.forEach((provider,i)=>state.health[provider]={provider,status:"LIVE",age_ms:i*70+40,as_of:now,last_real_provider_event_time:now});
  }

  function initCards() {
    const grid = $("#modelGrid"), template = $("#modelCardTemplate");
    modelOrder.forEach(id => {const card=template.content.firstElementChild.cloneNode(true); card.dataset.modelId=id; $(".model-kicker",card).textContent=modelNames[id][0]; $("h3",card).textContent=modelNames[id][1]; grid.append(card); state.cards.set(id,card);});
    $$(".details-button").forEach(button => button.addEventListener("click",()=>{const details=$(".details",button.closest(".model-card"));details.hidden=!details.hidden;button.textContent=details.hidden?"Details":"Hide";}));
  }

  function renderModel(id) {
    const started=performance.now(), row=state.models[id], card=state.cards.get(id); if(!card)return;
    const status=(row?.state||"BLOCKED").toLowerCase(); card.className=`model-card state-${status}`;
    $(".state-chip",card).textContent=row?.state||"BLOCKED"; $(".direction",card).textContent=row?.direction||"NO SETUP";
    $(".grade",card).textContent=row?.grade?`GRADE ${row.grade}`:"—"; $(".grade",card).hidden=!row?.grade;
    $(".score",card).textContent=percent(row?.probability); $(".aim",card).textContent=row?.aim_for_percent==null?"—":`+${row.aim_for_percent}%`;
    $(".mfe10",card).textContent=percent(row?.ladder?.["0.1"]); $(".mfe20",card).textContent=percent(row?.ladder?.["0.2"]); $(".mfe30",card).textContent=percent(row?.ladder?.["0.3"]);
    $(".contract",card).textContent=row?.candidate_contract?`${row.symbol} ${row.strike} ${row.direction} · 1DTE`:"No eligible contract";
    $(".contract-meta",card).textContent=row?.delta==null?"Waiting for eligible Quant event":`Δ ${Number(row.delta).toFixed(2)} · ${row.expiration||"—"}`;
    $(".quote",card).textContent=row?.bid==null?"Bid — / Ask —":`Bid ${Number(row.bid).toFixed(2)} / Ask ${Number(row.ask).toFixed(2)}`;
    $(".invalid-if",card).textContent=row?.invalidation_reason||row?.invalid_if||"Guidance unavailable while blocked";
    const modelAge=currentAge(row?.model_event_time,row?.model_age_ms),quoteAge=currentAge(row?.latest_quote_time,row?.quote_age_ms);
    $(".model-age",card).textContent=`Model ${age(modelAge)}`; $(".quote-age",card).textContent=`Quote ${age(quoteAge)}`;
    card.classList.toggle("runtime-stale",row?.guidance_state==="STALE"||modelAge>(cfg.stalenessMs?.quantOptionEvent||90000)||quoteAge>(cfg.stalenessMs?.webullQuote||5000));
    const sameAge=currentAge(row?.latest_same_side_event_time,row?.latest_same_side_age_ms),oppositeAge=currentAge(row?.latest_opposite_side_event_time,row?.latest_opposite_side_age_ms);
    $(".details",card).innerHTML=`Guidance <b>${esc(row?.guidance_state||"BLOCKED")}</b> · Thesis <b>${esc(row?.thesis_state||"HOLD")}</b> · Episode <b>${esc(row?.setup_episode_id||"—")}</b><br>Selected at <b>${percent(row?.selected_contract_probability_at_selection)}</b> · Latest ${esc(row?.direction||"same-side")} evidence <b>${percent(row?.latest_same_side_probability)}</b> (${age(sameAge)}) · Opposite <b>${percent(row?.latest_opposite_side_probability)}</b> (${age(oppositeAge)})<br>Version <b>${esc(row?.model_version||"—")}</b> · Mapping band <b>${esc(row?.score_band||"—")}</b> · Effective historical n <b>${Math.round(row?.mapping_effective_n||0)}</b><br>Historical proxy probabilities are not continuous executable-NBBO probabilities.`;
    card.dataset.renderMs=(performance.now()-started).toFixed(3);
  }

  function renderContexts() {
    const grid=$("#contextGrid"); grid.replaceChildren(); ["SPY","QQQ"].forEach(symbol=>{const row=state.contexts[symbol]||{};const article=document.createElement("article");article.className="context-card";
      article.innerHTML=`<strong class="context-symbol">${symbol}</strong><div class="context-cell"><span>GAMMA REGIME</span><strong>${esc(row.gamma_regime||"UNAVAILABLE")}</strong><div class="reasons"><span class="reason">balance ${safeNumber(row.gamma_balance)?.toFixed(2)??"—"}</span><span class="reason">${state.scope.replaceAll("_"," ").toLowerCase()}</span></div></div><div class="context-cell"><span>MARKET CONDITION</span><strong>${esc(row.market_condition||"UNAVAILABLE")}</strong><div class="reasons">${(row.reasons||["waiting for causal context"]).slice(0,4).map(reason=>`<span class="reason">${esc(reason)}</span>`).join("")}</div></div>`;grid.append(article);});
  }

  function chartCard(symbol,kind) {const key=`${symbol}:${kind}:${state.scope}`,row=state.gex[key]||{},points=row.points||[];const card=document.createElement("article");card.className="gex-card";
    const title=kind==="CURRENT"?"CURRENT GEX":"INTRADAY ΔGEX", w=640,h=180,pad=28,max=Math.max(...points.map(p=>Math.abs(Number(p.value))),1),barW=Math.max(5,(w-2*pad)/Math.max(points.length,1)-4),zero=h/2;
    const bars=points.map((p,i)=>{const x=pad+i*((w-2*pad)/points.length),height=Math.abs(Number(p.value))/max*(h*.36),y=Number(p.value)>=0?zero-height:zero;return `<rect class="gex-bar ${Number(p.value)>=0?"positive":"negative"}" x="${x}" y="${y}" width="${barW}" height="${height}"><title>${p.strike}: ${Number(p.value).toExponential(2)}</title></rect><text class="gex-axis" x="${x}" y="${h-6}">${i%2===0?p.strike:""}</text>`}).join("");
    const spotIndex=points.length?points.findIndex(p=>Number(p.strike)>=Number(row.spot)):0,spotX=pad+Math.max(0,spotIndex)*((w-2*pad)/Math.max(points.length,1));
    card.innerHTML=`<div class="gex-title"><strong>${symbol} ${title}</strong><span>${esc(row.scope||state.scope)} · ${row.as_of?new Date(row.as_of).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}):"—"}</span></div><svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${symbol} ${title} by strike"><line class="gex-zero" x1="${pad}" y1="${zero}" x2="${w-pad}" y2="${zero}"/>${bars}${points.length?`<line class="gex-spot" x1="${spotX}" y1="8" x2="${spotX}" y2="${h-18}"/>`:""}</svg>`;return card;}
  function renderGex(){const grid=$("#gexGrid");grid.replaceChildren(chartCard("SPY","CURRENT"),chartCard("SPY","INTRADAY_DELTA"),chartCard("QQQ","CURRENT"),chartCard("QQQ","INTRADAY_DELTA"));}

  function renderLadder() {const body=$("#optionTable tbody"),rows=[...state.ladder.values()].filter(row=>row.active!==false&&row.symbol===state.symbol&&(state.side==="ALL"||row.contract_type===state.side)).sort((a,b)=>a.strike-b.strike||String(a.contract_type).localeCompare(String(b.contract_type)));
    const existing=new Map($$("tr",body).map(row=>[row.dataset.key,row])); for(const row of rows){let tr=existing.get(row.contract_key);if(!tr){tr=document.createElement("tr");tr.dataset.key=row.contract_key;body.append(tr);}const bid=safeNumber(row.bid),ask=safeNumber(row.ask),spread=bid!=null&&ask!=null&&ask+bid>0?100*(ask-bid)/((ask+bid)/2):null,qAge=currentAge(row.quote_time,row.quote_age_ms),gAge=currentAge(row.greek_context_time,row.greek_age_ms);tr.className=`${row.eligible?"eligible":""} ${row.selected?"selected":""}`;tr.innerHTML=`<td><strong>${fixed(row.strike,0)}</strong><br><span class="badge">${row.selected?"SELECTED":row.eligible?"ELIGIBLE":"CONTEXT"}</span></td><td>${esc(row.contract_type||"—")}</td><td>${fixed(bid)} / ${fixed(ask)}<br><small>${integer(row.bid_size)} × ${integer(row.ask_size)}</small></td><td>${spread==null?"—":fixed(spread,1)+"%"}</td><td>${fixed(row.delta,3)}</td><td>${fixed(row.gamma,4)}</td><td>${fixed(row.theta,3)}</td><td>${fixed(row.vega,3)}</td><td>${safeNumber(row.iv)==null?"—":fixed(100*row.iv,1)+"%"}</td><td>${fixed(row.vanna,4)}</td><td>${fixed(row.charm,4)}</td><td>${safeNumber(row.gex)==null?"—":Number(row.gex).toExponential(2)}</td><td>${integer(row.open_interest)} / ${integer(row.volume)}</td><td>${esc(row.flow_context||"—")}</td><td>${percent(row.model_probability)}<br><small>${row.grade?`Grade ${esc(row.grade)} · Aim +${integer(row.aim_for_percent)}%`:"No grade"}</small></td><td class="${qAge>5000?"age-stale":""}">Q ${age(qAge)}<br>G ${age(gAge)}</td>`;existing.delete(row.contract_key);} existing.forEach(row=>row.remove()); $("#ladderEmpty").hidden=rows.length>0;}

  function renderHealth(){const rows=$("#healthRows");rows.replaceChildren();let overall="LIVE";providerHealthIds.forEach(name=>{const item=state.health[name]||{status:"UNAVAILABLE",age_ms:null};const liveAge=currentAge(item.last_real_provider_event_time,item.age_ms);if(item.status!=="LIVE"&&item.status!=="VERIFIED")overall=item.status==="UNAVAILABLE"?"BLOCKED":"DEGRADED";const row=document.createElement("div");row.className="health-row";row.innerHTML=`<i class="health-dot ${item.status==="LIVE"||item.status==="VERIFIED"?"live":item.status==="UNAVAILABLE"?"blocked":"degraded"}"></i><strong>${name.replaceAll("_"," ")}</strong><span>${item.status} · ${age(liveAge)}</span>`;rows.append(row);});const pill=$("#healthToggle");pill.className=`health-pill is-${overall.toLowerCase()}`;$("span",pill).textContent=overall;}
  function renderAll(){renderContexts();modelOrder.forEach(renderModel);renderGex();renderLadder();renderHealth();}

  function unwrap(row){return row?.payload&&typeof row.payload==="object"?{...row.payload,...row}:row;}
  function ingest(table,row){const value=unwrap(row);if(!value)return;if(table==="predictive_model_state_live")state.models[value.model_id]=value;else if(table==="predictive_market_context_live")state.contexts[value.symbol]=value;else if(table==="predictive_gex_surface_live")state.gex[`${value.symbol}:${value.surface_kind}:${value.scope}`]=value;else if(table==="predictive_option_ladder_live")state.ladder.set(value.contract_key,value);else if(table==="predictive_provider_health_live")state.health[value.provider]=value;}
  function patch(table,row){const started=performance.now();ingest(table,row);if(table==="predictive_model_state_live")renderModel(row.model_id||row.payload?.model_id);else if(table==="predictive_market_context_live")renderContexts();else if(table==="predictive_gex_surface_live")renderGex();else if(table==="predictive_option_ladder_live")renderLadder();else renderHealth();window.dispatchEvent(new CustomEvent("predictive-render-latency",{detail:{table,ms:performance.now()-started,received_at:new Date().toISOString()}}));}

  async function loadCurrent(){const tables=["predictive_model_state_live","predictive_market_context_live","predictive_gex_surface_live","predictive_option_ladder_live","predictive_provider_health_live"];for(const table of tables){const {data,error}=await client.from(table).select("*");if(error)throw error;(data||[]).forEach(row=>ingest(table,row));}renderAll();}
  function subscribe(){if(state.channel)client.removeChannel(state.channel);state.channel=client.channel("predictive-live-v1");["predictive_model_state_live","predictive_market_context_live","predictive_gex_surface_live","predictive_option_ladder_live","predictive_provider_health_live"].forEach(table=>state.channel.on("postgres_changes",{event:"*",schema:"public",table},payload=>patch(table,payload.new)));state.channel.subscribe(status=>{state.health.SUPABASE={provider:"SUPABASE",status:status==="SUBSCRIBED"?"LIVE":"DEGRADED",age_ms:0};renderHealth();});}
  async function bootAuthenticated(session){if(!session)throw new Error("Authentication required");$("#authDialog").hidden=true;$("#app").hidden=false;await loadCurrent();subscribe();document.documentElement.dataset.mode="live";}

  function bind(){
    $$(".tab").forEach(button=>button.addEventListener("click",()=>{$$(".tab").forEach(x=>x.classList.toggle("active",x===button));$("#dashboardView").classList.toggle("active",button.dataset.tab==="dashboard");$("#ladderView").classList.toggle("active",button.dataset.tab==="ladder");}));
    $$("[data-symbol]").forEach(button=>button.addEventListener("click",()=>{state.symbol=button.dataset.symbol;$$('[data-symbol]').forEach(x=>x.classList.toggle("active",x===button));renderLadder();}));
    $$("[data-side]").forEach(button=>button.addEventListener("click",()=>{state.side=button.dataset.side;$$('[data-side]').forEach(x=>x.classList.toggle("active",x===button));renderLadder();}));
    const setPanel=open=>{$("#healthPanel").classList.toggle("open",open);$("#healthPanel").setAttribute("aria-hidden",String(!open));$("#scrim").hidden=!open;$("#healthToggle").setAttribute("aria-expanded",String(open));};
    $("#healthToggle").addEventListener("click",()=>setPanel(true));$("#healthClose").addEventListener("click",()=>setPanel(false));$("#scrim").addEventListener("click",()=>setPanel(false));
    $("#authButton").addEventListener("click",async()=>{if(state.demo)return;if((await client.auth.getSession()).data.session){await client.auth.signOut();location.reload();}else $("#authDialog").hidden=false;});$("#closeAuth").addEventListener("click",()=>$("#authDialog").hidden=true);
    $("#loginForm").addEventListener("submit",async event=>{event.preventDefault();$("#loginError").textContent="";const {data,error}=await client.auth.signInWithPassword({email:$("#loginEmail").value,password:$("#loginPassword").value});if(error)$("#loginError").textContent=error.message;else await bootAuthenticated(data.session);});
  }
  function clock(){const now=new Date();$("#sessionClock").textContent=now.toLocaleTimeString("en-US",{timeZone:cfg.timezone||"America/Chicago",hour12:false})+" CT";const backendSession=state.contexts.SPY?.session?.state||state.contexts.QQQ?.session?.state;$("#sessionState").textContent=backendSession||"UNAVAILABLE";modelOrder.forEach(renderModel);renderLadder();renderHealth();}
  async function start(){initCards();bind();clock();setInterval(clock,1000);if(state.demo){demoData();const params=new URLSearchParams(location.search);if(params.get("scenario")==="degraded"){state.models.SPY_OPTIONS_PLUS_ES.state="BLOCKED";state.models.SPY_OPTIONS_PLUS_ES.guidance_state="BLOCKED";state.models.SPY_OPTIONS_PLUS_ES.grade=null;state.models.SPY_OPTIONS_PLUS_ES.aim_for_percent=null;state.models.SPY_OPTIONS_PLUS_ES.invalidation_reason="DATA DEGRADED / GUIDANCE UNAVAILABLE · ES feed stale";state.models.QQQ_OPTIONS_ONLY.state="INVALIDATED";state.models.QQQ_OPTIONS_ONLY.thesis_state="INVALIDATED";state.models.QQQ_OPTIONS_ONLY.aim_for_percent=null;state.models.QQQ_OPTIONS_ONLY.target_premium=null;state.models.QQQ_OPTIONS_ONLY.invalidation_reason="MODEL_REVERSAL_CONFIRMED";state.health.NINJATRADER_ES={provider:"NINJATRADER_ES",status:"STALE",age_ms:7200,as_of:new Date().toISOString()};}$("#app").hidden=false;const ribbon=document.createElement("div");ribbon.className="demo-ribbon";ribbon.textContent="LOCAL PREVIEW · DEMONSTRATION STATE";document.body.append(ribbon);document.documentElement.dataset.mode="demo";renderAll();clock();if(params.get("tab")==="ladder")document.querySelector('[data-tab="ladder"]').click();return;}if(!cfg.supabaseUrl||!cfg.supabasePublishableKey||!window.supabase){$("#loginError").textContent="Browser configuration unavailable.";$("#authDialog").hidden=false;return;}client=window.supabase.createClient(cfg.supabaseUrl,cfg.supabasePublishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});client.auth.onAuthStateChange((_event,session)=>{if(session&&$("#app").hidden)bootAuthenticated(session).catch(error=>$("#loginError").textContent=error.message);});const {data}=await client.auth.getSession();if(data.session)await bootAuthenticated(data.session);else $("#authDialog").hidden=false;}
  start().catch(error=>{$("#loginError").textContent=error.message;$("#authDialog").hidden=false;});
})();
