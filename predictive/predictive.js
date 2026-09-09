(() => {
  "use strict";
  const cfg = window.PREDICTIVE_LIVE_CONFIG || {};
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const modelOrder = ["SPY_OPTIONS_ONLY", "SPY_OPTIONS_PLUS_ES", "QQQ_OPTIONS_ONLY", "QQQ_OPTIONS_PLUS_NQ"];
  const surfaceTargets = [5,10,15,20,25,30], surfaceHorizons = [10,20,30];
  const providerHealthIds = ["QUANT_DATA","QUANT_CONTEXT","WEBULL","NINJATRADER_ES","NINJATRADER_NQ","V2_STRUCTURE_SPY","V2_STRUCTURE_QQQ","SUPABASE","MODEL_ARTIFACTS"];
  const modelNames = {
    SPY_OPTIONS_ONLY: ["SPY", "OPTIONS ONLY"], SPY_OPTIONS_PLUS_ES: ["SPY", "OPTIONS + ES"],
    QQQ_OPTIONS_ONLY: ["QQQ", "OPTIONS ONLY"], QQQ_OPTIONS_PLUS_NQ: ["QQQ", "OPTIONS + NQ"]
  };
  const state = {models: {}, contexts: {}, gex: {}, ladder: new Map(), health: {}, cards: new Map(), channel: null,
    symbol: "SPY", side: "ALL", scope: "0DTE", deltaMin: .49, deltaMax: .70,
    grade: "ALL", sort: "strike-desc",
    demo: new URLSearchParams(location.search).get(cfg.demoQueryParameter || "demo") === "1"};
  let client = null;

  const safeNumber = value => Number.isFinite(Number(value)) ? Number(value) : null;
  const percent = value => value == null ? "—" : `${(100 * Number(value)).toFixed(1)}%`;
  const fixed = (value, digits = 2) => safeNumber(value) == null ? "—" : safeNumber(value).toFixed(digits);
  const integer = value => safeNumber(value) == null ? "—" : Math.round(safeNumber(value)).toLocaleString();
  const age = ms => ms == null ? "—" : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
  const currentAge = (stamp, fallback) => { const parsed=Date.parse(stamp||""); return Number.isFinite(parsed)?Math.max(0,Date.now()-parsed):fallback; };
  const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[ch]));
  const directSurface = strength => Object.fromEntries(surfaceHorizons.flatMap((horizon,hIndex)=>surfaceTargets.map((target,tIndex)=>[
    `p${target}_${horizon}`, Math.max(.018,Math.min(.93,strength + .36 - tIndex*.072 + hIndex*.055))
  ])));

  function demoData() {
    const now = new Date().toISOString();
    modelOrder.forEach((id, index) => {const strengths=[.128,.284,.112,.181],surface=directSurface(strengths[index]-.065),aims={"10":11+index,"20":14+index,"30":16+index};state.models[id] = {
      model_id:id, model_version:["e0a81ddb5479","688ad9e3e589","6d3a2c06ed5d","832666b15ab4"][index],
      symbol:modelNames[id][0], state:index === 2 ? "WARNING" : "LIVE", guidance_state:"LIVE",
      thesis_state:index === 2 ? "WARNING" : "LIVE", setup_episode_id:`demo-${index+1}`, direction:index < 2 ? "CALL" : "PUT",
      grade:index === 1 ? "A" : index === 3 ? "B" : "C", probability:strengths[index],grade_probability:strengths[index],
      surface_contract:"DIRECT_TIME_CONDITIONED_MFE_SURFACE_V1",raw_probability_surface:surface,display_probability_surface:surface,
      raw_aim_for_by_horizon:{"10":.11+index*.01,"20":.14+index*.01,"30":.16+index*.01},aim_for_percent_by_horizon:aims,
      selected_contract_probability_at_selection:strengths[index], selected_contract_event_time:now,
      latest_same_side_probability:strengths[index], latest_same_side_event_time:now,
      latest_same_side_age_ms:780+index*90, latest_same_side_fresh:true,
      latest_opposite_side_probability:[.16,.16,.13,.13][index], latest_opposite_side_event_time:now,
      latest_opposite_side_age_ms:920+index*90, latest_opposite_side_fresh:true,
      aim_for_percent:aims["30"],
      candidate_contract:index < 2 ? "SPY260908C00650000" : "QQQ260908P00582000", expiration:"2026-09-08",
      strike:index < 2 ? 650 : 582, delta:index < 2 ? .65 : -.64, bid:index < 2 ? 2.11 : 1.51, ask:index < 2 ? 2.14 : 1.54,
      relative_spread:index < 2 ? .014 : .019, model_event_time:now, model_age_ms:780 + index*90,
      latest_quote_time:now, quote_age_ms:180 + index*45, invalid_if:index < 2 ? "Invalid if SPY accepts below 647.80 support" : "Invalid if QQQ accepts above 585.40 resistance",
    };});
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
        flow_context:index%3===0?"BUYING":"MIXED",quote_age_ms:150+index*31,greek_age_ms:2400+index*110,eligible:Math.abs(delta)>=.49&&Math.abs(delta)<=.70,
        selected:index===2||index===6,model_probability:index===2?.284:index===6?.181:.07+index*.012,p30_30:index===2?.284:index===6?.181:.07+index*.012,grade:index===2?"A":index===6?"B":null,aim_for_percent_by_horizon:index===2?{"10":12,"20":14,"30":16}:index===6?{"10":10,"20":12,"30":14}:null});
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
    $(".score",card).textContent=percent(row?.grade_probability??row?.probability);
    const surface=row?.display_probability_surface||{};surfaceTargets.filter(target=>[10,20,30].includes(target)).forEach(target=>surfaceHorizons.forEach(horizon=>{$(`.p${target}-${horizon}`,card).textContent=percent(surface[`p${target}_${horizon}`]);}));
    const aims=row?.aim_for_percent_by_horizon||{};surfaceHorizons.forEach(horizon=>{$(`.aim${horizon}`,card).textContent=aims[String(horizon)]==null?"—":`+${Math.round(aims[String(horizon)])}%`;});
    $(".contract",card).textContent=row?.candidate_contract?`${row.symbol} ${row.strike} ${row.direction} · 1DTE`:"No eligible contract";
    $(".contract-meta",card).textContent=row?.delta==null?"Waiting for eligible Quant event":`Δ ${Number(row.delta).toFixed(2)} · ${row.expiration||"—"}`;
    $(".bid",card).textContent=fixed(row?.bid);$(".ask",card).textContent=fixed(row?.ask);
    $(".invalid-if",card).textContent=row?.invalidation_reason||row?.invalid_if||"Guidance unavailable while blocked";
    const modelAge=currentAge(row?.model_event_time,row?.model_age_ms),quoteAge=currentAge(row?.latest_quote_time,row?.quote_age_ms);
    $(".model-age",card).textContent=`Model ${age(modelAge)}`; $(".quote-age",card).textContent=`Quote ${age(quoteAge)}`;
    $(".thesis-label",card).textContent=`Thesis ${row?.thesis_state||"HOLD"}`;$(".data-label",card).textContent=`Data ${row?.guidance_state||"BLOCKED"}`;
    card.classList.toggle("runtime-stale",row?.guidance_state==="STALE"||modelAge>(cfg.stalenessMs?.quantOptionEvent||90000)||quoteAge>(cfg.stalenessMs?.webullQuote||5000));
    const sameAge=currentAge(row?.latest_same_side_event_time,row?.latest_same_side_age_ms),oppositeAge=currentAge(row?.latest_opposite_side_event_time,row?.latest_opposite_side_age_ms);
    const full=`<div class="details-surface"><span></span>${surfaceHorizons.map(h=>`<span>${h}m</span>`).join("")}${surfaceTargets.map(target=>`<span>+${target}%</span>${surfaceHorizons.map(h=>`<span>${percent(surface[`p${target}_${h}`])}</span>`).join("")}`).join("")}</div>`;
    $(".details",card).innerHTML=`${full}Guidance <b>${esc(row?.guidance_state||"BLOCKED")}</b> · Thesis <b>${esc(row?.thesis_state||"HOLD")}</b> · Episode <b>${esc(row?.setup_episode_id||"—")}</b><br>Selected at <b>${percent(row?.selected_contract_probability_at_selection)}</b> · Latest ${esc(row?.direction||"same-side")} evidence <b>${percent(row?.latest_same_side_probability)}</b> (${age(sameAge)}) · Opposite <b>${percent(row?.latest_opposite_side_probability)}</b> (${age(oppositeAge)})<br>Delta band <b>${esc(row?.candidate_delta_band||"—")}</b> · Current-session volume <b>${integer(row?.current_session_volume)}</b><br>Selection <b>${esc(row?.contract_selection_reason||"—")}</b><br>Version <b>${esc(row?.model_version||"—")}</b> · ${esc(row?.surface_contract||"DIRECT MFE SURFACE")}<br>Model-implied historical proxy favorable-MFE target derived from the direct probability surface. Not a guaranteed or continuous executable-NBBO probability.`;
    card.dataset.renderMs=(performance.now()-started).toFixed(3);
  }

  function renderContexts() {
    const grid=$("#contextGrid"); grid.replaceChildren(); ["SPY","QQQ"].forEach(symbol=>{const row=state.contexts[symbol]||{};const article=document.createElement("article");article.className="context-card";
      article.innerHTML=`<strong class="context-symbol">${symbol}</strong><div class="context-cell"><span>GAMMA REGIME</span><strong>${esc(row.gamma_regime||"UNAVAILABLE")}</strong><div class="reasons"><span class="reason">balance ${safeNumber(row.gamma_balance)?.toFixed(2)??"—"}</span><span class="reason">${state.scope.replaceAll("_"," ").toLowerCase()}</span></div></div><div class="context-cell"><span>MARKET CONDITION</span><strong>${esc(row.market_condition||"UNAVAILABLE")}</strong><div class="reasons">${(row.reasons||["waiting for causal context"]).slice(0,4).map(reason=>`<span class="reason">${esc(reason)}</span>`).join("")}</div></div>`;grid.append(article);});
  }

  function selectedGexPoints(points,spot) {
    const clean=points.filter(p=>safeNumber(p.strike)!=null&&safeNumber(p.value)!=null);
    const core=[...clean].sort((a,b)=>Math.abs(Number(a.strike)-spot)-Math.abs(Number(b.strike)-spot)).slice(0,15);
    const keys=new Set(core.map(p=>String(p.strike)));
    [...clean].sort((a,b)=>Math.abs(Number(b.value))-Math.abs(Number(a.value))).slice(0,4).forEach(p=>{if(!keys.has(String(p.strike))){core.push(p);keys.add(String(p.strike));}});
    return core.sort((a,b)=>Number(b.strike)-Number(a.strike));
  }
  function chartCard(symbol,kind) {const key=`${symbol}:${kind}:${state.scope}`,row=state.gex[key]||{},spot=safeNumber(row.spot),points=selectedGexPoints(row.points||[],spot??0);const card=document.createElement("article");card.className="gex-card";
    const title=kind==="CURRENT"?"CURRENT GEX":"INTRADAY ΔGEX",w=640,rowH=18,top=18,bottom=24,h=Math.max(210,top+bottom+points.length*rowH),labelW=55,right=20,zero=labelW+(w-labelW-right)/2,max=Math.max(...points.map(p=>Math.abs(Number(p.value))),1),half=w-zero-right;
    const bars=points.map((p,i)=>{const value=Number(p.value),width=Math.max(1,Math.abs(value)/max*half),y=top+i*rowH+2,x=value>=0?zero:zero-width;return `<text class="gex-axis gex-strike" x="${labelW-7}" y="${y+10}">${Number(p.strike).toFixed(0)}</text><rect class="gex-bar ${value>=0?"positive":"negative"}" x="${x}" y="${y}" width="${width}" height="12"><title>Strike ${p.strike} · ${value.toLocaleString()} GEX per 1% underlying move</title></rect>`}).join("");
    let spotLine="";if(points.length&&spot!=null){const hi=Number(points[0].strike),lo=Number(points[points.length-1].strike),plot=Math.max(rowH,points.length*rowH-rowH);const y=top+(hi===lo?plot/2:(hi-spot)/(hi-lo)*plot)+8;spotLine=`<line class="gex-spot" x1="${labelW}" y1="${y}" x2="${w-right}" y2="${y}"/><text class="gex-spot-label" x="${w-right-2}" y="${Math.max(10,y-3)}">SPOT ${fixed(spot)}</text>`;}
    const empty=points.length?"":`<text class="gex-empty" x="${w/2}" y="${h/2}">${kind==="INTRADAY_DELTA"&&!row.baseline_time?"RTH baseline unavailable":"No current 0DTE GEX"}</text>`;
    card.innerHTML=`<div class="gex-title"><strong>${symbol} ${title}</strong><span>${esc(row.scope||state.scope)} · GEX / 1% move · ${row.as_of?new Date(row.as_of).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}):"—"}</span></div><svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${symbol} ${title} horizontal bars by descending strike"><line class="gex-zero" x1="${zero}" y1="8" x2="${zero}" y2="${h-bottom+4}"/>${bars}${spotLine}${empty}</svg>`;return card;}
  function renderGex(){const grid=$("#gexGrid");grid.replaceChildren(chartCard("SPY","CURRENT"),chartCard("SPY","INTRADAY_DELTA"),chartCard("QQQ","CURRENT"),chartCard("QQQ","INTRADAY_DELTA"));}

  function ladderSort(a,b){const spread=row=>{const bid=safeNumber(row.bid),ask=safeNumber(row.ask);return bid!=null&&ask!=null&&ask+bid>0?(ask-bid)/((ask+bid)/2):Infinity;},gradeRank={A:3,B:2,C:1};if(state.sort==="delta-desc")return Math.abs(Number(b.delta||0))-Math.abs(Number(a.delta||0))||Number(b.strike)-Number(a.strike);if(state.sort==="volume-desc")return Number(b.volume||0)-Number(a.volume||0)||Number(b.strike)-Number(a.strike);if(state.sort==="grade-desc")return (gradeRank[b.grade]||0)-(gradeRank[a.grade]||0)||Number(b.model_probability||0)-Number(a.model_probability||0);if(state.sort==="spread-asc")return spread(a)-spread(b)||Number(b.strike)-Number(a.strike);return Number(b.strike)-Number(a.strike)||String(a.contract_type).localeCompare(String(b.contract_type));}
  function ladderMatches(row){const absDelta=Math.abs(Number(row.delta));const grade=row.grade||"UNGRADED";return row.active!==false&&row.symbol===state.symbol&&(state.side==="ALL"||row.contract_type===state.side)&&Number.isFinite(absDelta)&&absDelta>=state.deltaMin&&absDelta<=state.deltaMax&&(state.grade==="ALL"||grade===state.grade);}
  function renderLadder() {const body=$("#optionTable tbody"),all=[...state.ladder.values()].filter(row=>row.active!==false&&row.symbol===state.symbol),rows=all.filter(ladderMatches).sort(ladderSort);
    const existing=new Map($$("tr",body).map(row=>[row.dataset.key,row])); for(const row of rows){let tr=existing.get(row.contract_key);if(!tr){tr=document.createElement("tr");tr.dataset.key=row.contract_key;body.append(tr);}const bid=safeNumber(row.bid),ask=safeNumber(row.ask),spread=bid!=null&&ask!=null&&ask+bid>0?100*(ask-bid)/((ask+bid)/2):null,qAge=currentAge(row.quote_time,row.quote_age_ms),gAge=currentAge(row.greek_context_time,row.greek_age_ms),aims=row.aim_for_percent_by_horizon||{};tr.className=`${row.eligible?"eligible":""} ${row.selected?"selected":""}`;tr.innerHTML=`<td><strong>${fixed(row.strike,0)}</strong><br><span class="badge">${row.selected?"SELECTED":row.eligible?"ELIGIBLE":"CONTEXT"}</span></td><td>${esc(row.contract_type||"—")}</td><td>${fixed(bid)} / ${fixed(ask)}<br><small>${integer(row.bid_size)} × ${integer(row.ask_size)}</small></td><td>${spread==null?"—":fixed(spread,1)+"%"}</td><td>${fixed(row.delta,3)}<br><small>${esc(row.candidate_delta_band||"")}</small></td><td>${fixed(row.gamma,4)}</td><td>${fixed(row.theta,3)}</td><td>${fixed(row.vega,3)}</td><td>${safeNumber(row.iv)==null?"—":fixed(100*row.iv,1)+"%"}</td><td>${fixed(row.vanna,4)}</td><td>${fixed(row.charm,4)}</td><td>${safeNumber(row.gex)==null?"—":Number(row.gex).toExponential(2)}</td><td>${integer(row.open_interest)} / ${integer(row.volume)}</td><td>${esc(row.flow_context||"—")}</td><td>${percent(row.p30_30??row.model_probability)}<br><small>${row.grade?`Grade ${esc(row.grade)} · Aim ${integer(aims["10"])} / ${integer(aims["20"])} / ${integer(aims["30"])}%`:"No grade"}</small></td><td class="${qAge>5000?"age-stale":""}">Q ${age(qAge)}<br>G ${age(gAge)}</td>`;existing.delete(row.contract_key);} existing.forEach(row=>row.remove()); $("#ladderEmpty").hidden=rows.length>0;const selectedHidden=all.some(row=>row.selected&&!ladderMatches(row));$("#selectedHiddenNotice").hidden=!selectedHidden;}

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
    $$("[data-grade]").forEach(button=>button.addEventListener("click",()=>{state.grade=button.dataset.grade;$$('[data-grade]').forEach(x=>x.classList.toggle("active",x===button));renderLadder();}));
    $("#deltaPreset").addEventListener("change",event=>{const parts=event.target.value.split("-").map(Number);if(parts.length===2&&parts.every(Number.isFinite)){state.deltaMin=parts[0];state.deltaMax=parts[1];$("#deltaMin").value=parts[0];$("#deltaMax").value=parts[1];renderLadder();}});
    ["deltaMin","deltaMax"].forEach(id=>$("#"+id).addEventListener("change",()=>{state.deltaMin=Math.max(0,Number($("#deltaMin").value));state.deltaMax=Math.min(1,Number($("#deltaMax").value));$("#deltaPreset").value="custom";renderLadder();}));
    $("#ladderSort").addEventListener("change",event=>{state.sort=event.target.value;renderLadder();});
    $("#resetLadderFilters").addEventListener("click",()=>{state.deltaMin=.49;state.deltaMax=.70;state.grade="ALL";state.side="ALL";$("#deltaMin").value=.49;$("#deltaMax").value=.70;$("#deltaPreset").value=".49-.70";$$('[data-side]').forEach(x=>x.classList.toggle("active",x.dataset.side==="ALL"));$$('[data-grade]').forEach(x=>x.classList.toggle("active",x.dataset.grade==="ALL"));renderLadder();});
    const setPanel=open=>{$("#healthPanel").classList.toggle("open",open);$("#healthPanel").setAttribute("aria-hidden",String(!open));$("#scrim").hidden=!open;$("#healthToggle").setAttribute("aria-expanded",String(open));};
    $("#healthToggle").addEventListener("click",()=>setPanel(true));$("#healthClose").addEventListener("click",()=>setPanel(false));$("#scrim").addEventListener("click",()=>setPanel(false));
    $("#authButton").addEventListener("click",async()=>{if(state.demo)return;if((await client.auth.getSession()).data.session){await client.auth.signOut();location.reload();}else $("#authDialog").hidden=false;});$("#closeAuth").addEventListener("click",()=>$("#authDialog").hidden=true);
    $("#loginForm").addEventListener("submit",async event=>{event.preventDefault();$("#loginError").textContent="";const {data,error}=await client.auth.signInWithPassword({email:$("#loginEmail").value,password:$("#loginPassword").value});if(error)$("#loginError").textContent=error.message;else await bootAuthenticated(data.session);});
  }
  function clock(){const now=new Date();$("#sessionClock").textContent=now.toLocaleTimeString("en-US",{timeZone:cfg.timezone||"America/Chicago",hour12:false})+" CT";const backendSession=state.contexts.SPY?.session?.state||state.contexts.QQQ?.session?.state;$("#sessionState").textContent=backendSession||"UNAVAILABLE";modelOrder.forEach(renderModel);renderLadder();renderHealth();}
  async function start(){initCards();bind();clock();setInterval(clock,1000);if(state.demo){demoData();const params=new URLSearchParams(location.search);if(params.get("scenario")==="degraded"){state.models.SPY_OPTIONS_PLUS_ES.state="BLOCKED";state.models.SPY_OPTIONS_PLUS_ES.guidance_state="BLOCKED";state.models.SPY_OPTIONS_PLUS_ES.grade=null;state.models.SPY_OPTIONS_PLUS_ES.aim_for_percent=null;state.models.SPY_OPTIONS_PLUS_ES.aim_for_percent_by_horizon=null;state.models.SPY_OPTIONS_PLUS_ES.invalidation_reason="DATA DEGRADED / GUIDANCE UNAVAILABLE · ES feed stale";state.models.QQQ_OPTIONS_ONLY.state="INVALIDATED";state.models.QQQ_OPTIONS_ONLY.thesis_state="INVALIDATED";state.models.QQQ_OPTIONS_ONLY.aim_for_percent=null;state.models.QQQ_OPTIONS_ONLY.aim_for_percent_by_horizon=null;state.models.QQQ_OPTIONS_ONLY.invalidation_reason="MODEL_REVERSAL_CONFIRMED";state.health.NINJATRADER_ES={provider:"NINJATRADER_ES",status:"STALE",age_ms:7200,as_of:new Date().toISOString()};}$("#app").hidden=false;const ribbon=document.createElement("div");ribbon.className="demo-ribbon";ribbon.textContent="LOCAL PREVIEW · DEMONSTRATION STATE";document.body.append(ribbon);document.documentElement.dataset.mode="demo";renderAll();clock();if(params.get("tab")==="ladder")document.querySelector('[data-tab="ladder"]').click();return;}if(!cfg.supabaseUrl||!cfg.supabasePublishableKey||!window.supabase){$("#loginError").textContent="Browser configuration unavailable.";$("#authDialog").hidden=false;return;}client=window.supabase.createClient(cfg.supabaseUrl,cfg.supabasePublishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});client.auth.onAuthStateChange((_event,session)=>{if(session&&$("#app").hidden)bootAuthenticated(session).catch(error=>$("#loginError").textContent=error.message);});const {data}=await client.auth.getSession();if(data.session)await bootAuthenticated(data.session);else $("#authDialog").hidden=false;}
  start().catch(error=>{$("#loginError").textContent=error.message;$("#authDialog").hidden=false;});
})();
