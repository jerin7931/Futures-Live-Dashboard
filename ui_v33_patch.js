(()=>{"use strict";
const $=id=>document.getElementById(id);
const state=window.FM_V33_STATE,client=window.FM_V33_CLIENT;
if(!state||!client)return;
if(!document.getElementById("uiV33PatchStyle")){const st=document.createElement("style");st.id="uiV33PatchStyle";st.textContent=`
/* V33 UI patch V1.0.5 — restored Market Update chart, EMA snapshot + compact Supertrend, preserved chart zoom */
.patch-panel{margin-top:0}
.chart-head-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}.chart-mode-toggle{display:inline-flex;gap:2px;padding:3px;border:1px solid var(--line);border-radius:999px;background:#09111d}.chart-mode-toggle button{border:0;background:transparent;color:var(--muted);padding:6px 9px;border-radius:999px;font-size:9px;font-weight:850;letter-spacing:.04em;white-space:nowrap}.chart-mode-toggle button.active{background:#17304a;color:var(--cyan)}
.ema-snapshot-panel{padding-bottom:14px}.ema-snapshot-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin-top:14px}.ema-snapshot-card{display:grid;gap:8px;text-align:left;background:#0a101a;color:var(--text);border:1px solid #1d2b3f;border-radius:13px;padding:13px;min-height:132px}.ema-snapshot-card:hover{border-color:#405a78;transform:translateY(-1px)}.ema-snapshot-card.trade{border-top:2px solid var(--cyan)}.ema-snapshot-card.won{border-top:2px solid var(--green)}.ema-snapshot-card.lost{border-top:2px solid var(--red)}.ema-snapshot-card.skip{border-top:2px solid #52657d}.ema-snapshot-card.empty{opacity:.55;cursor:default}.ema-snap-top{display:flex;align-items:center;justify-content:space-between;gap:8px}.ema-snap-top strong{font-size:16px;display:flex;align-items:center;gap:7px}.ema-snap-top span{font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);text-align:right}.ema-grade{font-size:9px;font-style:normal;line-height:1;border:1px solid #33465f;border-radius:999px;padding:4px 6px;letter-spacing:.04em}.ema-grade.top{color:var(--green);border-color:rgba(68,209,157,.45);background:rgba(68,209,157,.08)}.ema-grade.mid{color:var(--cyan);border-color:rgba(98,199,255,.4);background:rgba(98,199,255,.07)}.ema-grade.low{color:var(--amber);border-color:rgba(245,189,89,.4);background:rgba(245,189,89,.07)}.ema-grade.skip{color:var(--muted)}.ema-snap-main{font-size:20px;font-weight:850}.ema-snap-main em{font-size:11px;font-style:normal;color:var(--muted);font-weight:700}.ema-snap-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:5px}.ema-snap-stats span{display:grid;gap:2px;color:var(--muted);font-size:9px;text-transform:uppercase;letter-spacing:.06em}.ema-snap-stats b{color:var(--text);font-size:12px;font-variant-numeric:tabular-nums}.ema-snapshot-card>small{color:var(--muted);font-size:10px}.supertrend-card{cursor:default;min-height:132px}.supertrend-card:hover{transform:none;border-color:#1d2b3f}.supertrend-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:2px}.supertrend-cell{display:grid;gap:3px;padding:8px 9px;background:#0e1724;border:1px solid #1f2e42;border-radius:9px}.supertrend-cell span{color:var(--muted);font-size:9px;font-weight:800;letter-spacing:.07em}.supertrend-cell strong{font-size:12px}.supertrend-cell.bull strong{color:var(--green)}.supertrend-cell.bear strong{color:var(--red)}.supertrend-cell.wait strong{color:var(--muted)}
.market-roadmap-panel{overflow:hidden}.market-roadmap-chart-layout{display:grid;grid-template-columns:minmax(0,1.75fr) minmax(290px,.65fr);gap:14px;margin-top:10px}.market-roadmap-chart{height:500px;margin-top:0}.market-roadmap-levels{max-height:500px;overflow:auto;display:grid;align-content:start;gap:7px;padding-right:3px}.roadmap-level{display:grid;gap:4px;padding:10px 11px;background:#09111d;border:1px solid var(--line);border-left:3px solid var(--level,#73859a);border-radius:10px}.roadmap-level>div{display:flex;justify-content:space-between;gap:8px}.roadmap-level strong{font-variant-numeric:tabular-nums}.roadmap-level span,.roadmap-level small{color:var(--muted);font-size:10px}.dot.resistance{background:var(--red)}.dot.pivot{background:var(--amber)}.dot.support{background:var(--green)}
.tv-sync-panel{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:13px 15px;margin-top:0;border-color:#26384f}.tv-sync-main{display:grid;gap:4px;min-width:0}.tv-sync-main .eyebrow{margin:0}.tv-sync-status{font-size:14px;font-weight:850}.tv-sync-status.changed{color:var(--amber)}.tv-sync-status.copied{color:var(--cyan)}.tv-sync-status.synced{color:var(--green)}.tv-sync-meta{color:var(--muted);font-size:10px;line-height:1.45}.tv-sync-actions{display:flex;gap:7px;align-items:center;flex-wrap:wrap;justify-content:flex-end}.tv-sync-actions button{white-space:nowrap}.tv-sync-actions .hidden{display:none!important}@media(max-width:700px){.tv-sync-panel{align-items:flex-start;flex-direction:column}.tv-sync-actions{width:100%;justify-content:flex-start}}

.detail-modal{position:fixed;inset:0;z-index:50;display:grid;place-items:center;padding:24px}.detail-modal-backdrop{position:absolute;inset:0;background:rgba(2,6,11,.78);backdrop-filter:blur(4px)}.detail-modal-card{position:relative;width:min(1080px,96vw);max-height:88vh;overflow:auto;background:linear-gradient(180deg,#111b2b,#0a111c);border:1px solid #2a3a51;border-radius:18px;padding:20px;box-shadow:0 30px 90px rgba(0,0,0,.55)}.detail-modal-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;position:sticky;top:-20px;background:#101927;padding:10px 0 14px;z-index:2}.detail-modal-head h2{margin:3px 0}.detail-modal-head small{color:var(--muted)}.detail-kv{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin-top:8px}.detail-kv>div{display:grid;gap:4px;background:#090f18;border:1px solid #1c293b;border-radius:10px;padding:10px}.detail-kv span{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.07em}.detail-kv strong{font-size:12px;word-break:break-word}.detail-context{margin-top:14px}.detail-context summary{cursor:pointer;color:var(--cyan)}.detail-context pre{max-height:320px}
@media(max-width:1150px){.ema-snapshot-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.market-roadmap-chart-layout{grid-template-columns:1fr}.market-roadmap-levels{max-height:300px;grid-template-columns:1fr 1fr}.detail-kv{grid-template-columns:1fr 1fr}}
@media(max-width:700px){.ema-snapshot-grid{grid-template-columns:1fr 1fr}.market-roadmap-levels{grid-template-columns:1fr}.detail-kv{grid-template-columns:1fr}.market-roadmap-chart{height:360px}}
`;document.head.appendChild(st);}
const EMA_TFS=["5m","10m","15m","1h"], ST_TFS=["1m","5m","15m","1h"];
const P={context:{mes_bars:[],tf_bars:[]},contextAt:0,marketChart:null,marketCandles:null,marketLines:[],marketRange:null,marketFit:true,structRange:null,structAllowFit:false,lastFullFetch:0,live:{},quoteChannel:null};

const n=(v,d=2)=>v===null||v===undefined||v===""||!Number.isFinite(Number(v))?"—":Number(v).toLocaleString(undefined,{minimumFractionDigits:d,maximumFractionDigits:d});
const pct=v=>v===null||v===undefined||!Number.isFinite(Number(v))?"—":`${(Number(v)*100).toFixed(1)}%`;
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const ct=(v,withDate=false)=>{if(!v)return"—";try{return new Intl.DateTimeFormat("en-US",{timeZone:"America/Chicago",...(withDate?{month:"short",day:"numeric"}:{}),hour:"numeric",minute:"2-digit",hour12:true}).format(new Date(v))+" CT";}catch{return"—";}};
const chartDate=t=>typeof t==="number"?new Date(t*1000):t&&typeof t==="object"&&t.year?new Date(Date.UTC(t.year,t.month-1,t.day)):new Date(t);
const chartTime=(t,withDate=true)=>{try{return new Intl.DateTimeFormat("en-US",{timeZone:"America/Chicago",...(withDate?{month:"short",day:"numeric"}:{}),hour:"numeric",minute:"2-digit",hour12:true,timeZoneName:withDate?"short":undefined}).format(chartDate(t));}catch{return"—";}};
const chartTick=t=>{try{return new Intl.DateTimeFormat("en-US",{timeZone:"America/Chicago",hour:"numeric",minute:"2-digit",hour12:true}).format(chartDate(t));}catch{return null;}};
const latestQuote=sym=>(state.quotes||[]).filter(x=>x.symbol===sym).sort((a,b)=>new Date(b.updated_at||b.timestamp)-new Date(a.updated_at||a.timestamp))[0]||null;
const lastClose=rows=>{const a=[...(rows||[])].sort((x,y)=>Number(x.bar_open_ms)-Number(y.bar_open_ms));return Number(a[a.length-1]?.close);};
const key=(s,tf)=>`${s}:${tf}`;
const chartMode=key=>{try{return localStorage.getItem(`v33-chart-mode-${key}`)==="candles"?"candles":"linebreak";}catch{return"linebreak";}};
const chartModeToggle=key=>`<div class="chart-mode-toggle" data-chart-mode="${key}"><button type="button" data-mode="linebreak">3-Line Break</button><button type="button" data-mode="candles">Candles</button></div>`;
function syncChartModeButtons(){document.querySelectorAll("[data-chart-mode]").forEach(h=>h.querySelectorAll("button[data-mode]").forEach(b=>b.classList.toggle("active",b.dataset.mode===chartMode(h.dataset.chartMode))));}
function lineBreak3(rows){const f=window.FM_V33_LINE_BREAK_3;return typeof f==="function"?f(rows,3):[];}
function lineBreakPlot(lines){const f=window.FM_V33_LINE_BREAK_PLOT;return typeof f==="function"?f(lines):lines;}
function lineBreakState(lines){const f=window.FM_V33_LINE_BREAK_STATE;return typeof f==="function"?f(lines):{label:"WAITING"};}
function quoteMs(row){const t=Date.parse(row?.timestamp||row?.updated_at||"");return Number.isFinite(t)?t:Date.now();}
function liveBar(symbol,tf,price,ts,openHint){
  const int=tf==="1m"?60000:300000,bucket=Math.floor(ts/int)*int,k=key(symbol,tf),cur=P.live[k];
  if(cur&&cur.bar_open_ms===bucket){cur.high=Math.max(cur.high,price);cur.low=Math.min(cur.low,price);cur.close=price;return cur;}
  const o=Number.isFinite(Number(openHint))?Number(openHint):price;return P.live[k]={bar_open_ms:bucket,bar_close_ms:bucket+int,open:o,high:Math.max(o,price),low:Math.min(o,price),close:price};
}
const chartBar=b=>({time:Math.floor(Number(b.bar_open_ms)/1000),open:Number(b.open),high:Number(b.high),low:Number(b.low),close:Number(b.close)});
function setLiveFromQuote(row){
  const price=Number(row?.last);if(!Number.isFinite(price))return;const ts=quoteMs(row);
  if(row.symbol==="ES"){
    liveBar("ES","1m",price,ts,lastClose(state.rawBars));
    const bucket=Math.floor(ts/300000)*300000,partial=(state.rawBars||[]).filter(b=>Number(b.bar_open_ms)>=bucket&&Number(b.bar_open_ms)<bucket+300000).sort((a,b)=>Number(a.bar_open_ms)-Number(b.bar_open_ms));
    const base5=state.bars||[],o=partial.length?Number(partial[0].open):lastClose(base5),b=liveBar("ES","5m",price,ts,o);
    if(partial.length){b.open=Number(partial[0].open);b.high=Math.max(b.high,...partial.map(x=>Number(x.high)));b.low=Math.min(b.low,...partial.map(x=>Number(x.low)));}
  }else if(row.symbol==="MES")liveBar("MES","5m",price,ts,lastClose(P.context.mes_bars));
}


function stBars(tf){
  if(tf==="1m")return[...(state.rawBars||[])].sort((a,b)=>Number(a.bar_open_ms)-Number(b.bar_open_ms));
  return[...((P.context&&P.context.tf_bars)||[])].filter(b=>b.symbol==="ES"&&b.timeframe===tf).sort((a,b)=>Number(a.bar_open_ms)-Number(b.bar_open_ms));
}
function pineRma(vals,n){
  const o=Array(vals.length).fill(null);if(vals.length<n)return o;let s=0;
  for(let i=0;i<n;i++)s+=vals[i];
  o[n-1]=s/n;
  for(let i=n;i<vals.length;i++)o[i]=vals[i]/n+(1-1/n)*o[i-1];
  return o;
}
function supertrendState(bs,n=10,f=3){
  if(bs.length<n+2)return"WAITING";
  const tr=bs.map((b,i)=>i===0?Number(b.high)-Number(b.low):Math.max(Number(b.high)-Number(b.low),Math.abs(Number(b.high)-Number(bs[i-1].close)),Math.abs(Number(b.low)-Number(bs[i-1].close))));
  const atr=pineRma(tr,n),up=[],lo=[],st=[],dir=[];
  for(let i=0;i<bs.length;i++){
    if(!Number.isFinite(atr[i])){up[i]=lo[i]=st[i]=dir[i]=null;continue;}
    let u=(Number(bs[i].high)+Number(bs[i].low))/2+f*atr[i],l=(Number(bs[i].high)+Number(bs[i].low))/2-f*atr[i];
    const pu=Number.isFinite(up[i-1])?up[i-1]:u,pl=Number.isFinite(lo[i-1])?lo[i-1]:l;
    if(i>0){l=(l>pl||Number(bs[i-1].close)<pl)?l:pl;u=(u<pu||Number(bs[i-1].close)>pu)?u:pu;}
    lo[i]=l;up[i]=u;
    if(i===0||!Number.isFinite(atr[i-1]))dir[i]=1;
    else if(st[i-1]===up[i-1])dir[i]=Number(bs[i].close)>u?-1:1;
    else dir[i]=Number(bs[i].close)<l?1:-1;
    st[i]=dir[i]===-1?l:u;
  }
  const d=[...dir].reverse().find(Number.isFinite);
  return d===-1?"BULLISH":d===1?"BEARISH":"WAITING";
}
function gradeClass(g){
  const x=String(g||"").toUpperCase();
  if(x==="A+"||x==="A")return"top";
  if(x==="B+"||x==="B")return"mid";
  if(x==="SKIP")return"skip";
  return"low";
}
function supertrendCard(){
  const cells=ST_TFS.map(tf=>{const s=supertrendState(stBars(tf)),cls=s==="BULLISH"?"bull":s==="BEARISH"?"bear":"wait";return`<div class="supertrend-cell ${cls}"><span>${tf.toUpperCase()}</span><strong>${s}</strong></div>`;}).join("");
  return`<article class="ema-snapshot-card supertrend-card"><div class="ema-snap-top"><strong>SUPERTREND</strong><span>ES CONTEXT</span></div><div class="supertrend-grid">${cells}</div><small>Prior-version Supertrend · completed bars</small></article>`;
}

function installDom(){
  document.querySelector(".price-strip")?.remove();
  const brief=$("briefCard");
  if(brief&&!$("emaSnapshotGridPatch"))brief.insertAdjacentHTML("afterend",`
    <article class="panel ema-snapshot-panel patch-panel">
      <div class="panel-head"><div><div class="eyebrow">ES · FROZEN EMA9/21 + CCI TRANSITION</div><h2>Signal Snapshot by Timeframe</h2><small>Latest server-scored ES event on each timeframe · click for full details.</small></div><span id="emaSnapshotFreshnessPatch" class="state-pill neutral">WAITING</span></div>
      <div id="emaSnapshotGridPatch" class="ema-snapshot-grid"></div>
    </article>`);
  const snapPanel=$("emaSnapshotGridPatch")?.closest(".ema-snapshot-panel");
  if(snapPanel&&!$("tvLevelSyncPatch"))snapPanel.insertAdjacentHTML("afterend",`<article id="tvLevelSyncPatch" class="panel tv-sync-panel patch-panel"><div class="tv-sync-main"><div class="eyebrow">TRADINGVIEW · MES MARKET MAP</div><div id="tvSyncStatusPatch" class="tv-sync-status changed">Waiting for MES Market Map</div><div id="tvSyncMetaPatch" class="tv-sync-meta">Latest hourly NY MES roadmap only · support / pivot / resistance · Order Flow excluded.</div></div><div class="tv-sync-actions"><button id="tvCopyLevelsPatch" class="primary" type="button" disabled>COPY NEW LEVELS</button><button id="tvMarkSyncedPatch" class="ghost hidden" type="button">MARK SYNCED</button></div></article>`);
  const structural=$("priceChart")?.closest(".chart-panel");
  if(structural&&!$("marketRoadmapChartPatch"))structural.insertAdjacentHTML("beforebegin",`
    <article class="panel chart-panel market-roadmap-panel patch-panel">
      <div class="panel-head"><div><div class="eyebrow">MARKET UPDATE · SPX → MES ROADMAP</div><h2>MES Market Map</h2><small id="marketChartStatusPatch">Canonical ES 5m structure · MES roadmap levels · Central Time (CT)</small></div><div class="chart-head-actions">${chartModeToggle("ny")}<span id="marketChartBriefTimePatch" class="state-pill neutral">WAITING</span></div></div>
      <div class="market-roadmap-chart-layout"><div id="marketRoadmapChartPatch" class="chart market-roadmap-chart"></div><aside id="marketRoadmapLevelsPatch" class="market-roadmap-levels"><div class="empty-state">Waiting for the latest Market Update level map.</div></aside></div>
      <div class="chart-legend"><span><i class="dot resistance"></i>Resistance</span><span><i class="dot pivot"></i>Pivot</span><span><i class="dot support"></i>Support</span><span>Levels come directly from the stored Market Update SPX→MES conversion.</span></div>
    </article>`);
  if(structural){const h=structural.querySelector(".panel-head h2");if(h)h.textContent="Price + Important Active Levels";const head=structural.querySelector(".panel-head");if(head&&!head.querySelector('[data-chart-mode="structural"]'))head.insertAdjacentHTML("beforeend",chartModeToggle("structural"));}syncChartModeButtons();
  if(!$("emaDetailModalPatch"))$("toast")?.insertAdjacentHTML("beforebegin",`
    <div id="emaDetailModalPatch" class="detail-modal hidden" role="dialog" aria-modal="true" aria-labelledby="emaDetailTitlePatch">
      <div class="detail-modal-backdrop" data-ema-close-patch></div>
      <div class="detail-modal-card"><div class="detail-modal-head"><div><div class="eyebrow">FROZEN EMA9/21 + CCI · FULL EVENT DETAILS</div><h2 id="emaDetailTitlePatch">ES Signal Details</h2><small id="emaDetailSubtitlePatch">—</small></div><button class="ghost" type="button" data-ema-close-patch>Close</button></div><div id="emaDetailBodyPatch"></div></div>
    </div>`);
}

function latestEma(tf){return(state.emaEvents||[]).filter(e=>e.timeframe===tf).sort((a,b)=>new Date(b.signal_close_utc)-new Date(a.signal_close_utc))[0]||null;}
function emaTone(e){if(!e)return"empty";const s=String(e.execution_state||"").toUpperCase();if(s==="TP_HIT")return"won";if(s==="SL_HIT")return"lost";return e.v2_decision==="TRADE"?"trade":"skip";}
function renderSnapshot(){
  const host=$("emaSnapshotGridPatch");if(!host)return;const h=(state.health||[]).find(x=>x.service==="ema_cci_v2_model"),ok=h&&String(h.status).toUpperCase()==="LIVE";
  const pill=$("emaSnapshotFreshnessPatch");if(pill){pill.textContent=ok?"LIVE":"STALE";pill.className=`state-pill ${ok?"good":"bad"}`;}
  const cards=EMA_TFS.map(tf=>{const e=latestEma(tf);if(!e)return`<button class="ema-snapshot-card empty" disabled><div class="ema-snap-top"><strong>${tf.toUpperCase()} <em class="ema-grade skip">—</em></strong><span>NO EVENT</span></div><div class="ema-snap-main">—</div></button>`;const entry=e.actual_fill_price??e.planned_entry_price??e.v2_entry_proxy_price,sl=e.actual_stop_price??e.planned_stop_price,grade=e.production_quality||"—";return`<button class="ema-snapshot-card ${emaTone(e)}" data-ema-tf-patch="${tf}" type="button"><div class="ema-snap-top"><strong>${tf.toUpperCase()} <em class="ema-grade ${gradeClass(grade)}">${esc(grade)}</em></strong><span>${esc(String(e.execution_state||e.v2_decision||"—").replaceAll("_"," "))}</span></div><div class="ema-snap-main">${esc(e.direction||"—")} <em>${esc(e.signal||"")}</em></div><div class="ema-snap-stats"><span>P(TP) <b>${pct(e.v2_p_tp)}</b></span><span>Entry <b>${n(entry)}</b></span><span>SL <b>${n(sl)}</b></span></div><small>${ct(e.signal_close_utc,true)} · click for details</small></button>`;}).join("");
  host.innerHTML=cards+supertrendCard();
}
async function openEma(tf){
  let e=latestEma(tf);if(!e)return;
  try{const r=await client.from("ema_cci_v2_events").select("*").eq("event_id",e.event_id).single();if(!r.error&&r.data)e=r.data;}catch{}
  $("emaDetailTitlePatch").textContent=`ES ${tf.toUpperCase()} · ${e.direction||"—"} ${e.signal||""}`;$("emaDetailSubtitlePatch").textContent=`${ct(e.signal_close_utc,true)} · ${e.v2_decision||"—"} · ${e.execution_state||"—"}`;
  const rows=[["Contract",e.contract],["Session",e.session_scope],["Trading day",e.trading_day],["Direction",e.direction],["Signal",e.signal],["V2 decision",e.v2_decision],["Quality",e.production_quality],["P(TP)",pct(e.v2_p_tp)],["Predicted EV",e.gam_predicted_ev===null?"—":Number(e.gam_predicted_ev).toFixed(4)+"R"],["GAM policy",e.gam_policy],["Entry method",e.entry_method],["Planned entry",n(e.planned_entry_price??e.v2_entry_proxy_price)],["Actual fill",n(e.actual_fill_price)],["Stop method",e.stop_method],["Planned stop",n(e.planned_stop_price)],["Actual stop",n(e.actual_stop_price)],["Target R",e.target_r===null?"—":n(e.target_r,1)+"R"],["Planned target",n(e.planned_target_price)],["Actual target",n(e.actual_target_price)],["Risk",e.risk_points===null?"—":n(e.risk_points)+" pts"],["Valid until",e.entry_valid_until?ct(e.entry_valid_until,true):"—"],["Filled at",e.filled_at?ct(e.filled_at,true):"—"],["Resolved at",e.resolved_at?ct(e.resolved_at,true):"—"],["Outcome",e.outcome||"—"],["Feature version",e.feature_version],["GAM SHA",e.gam_sha256],["V2 SHA",e.v2_sha256],["Inference",e.model_inference_at?ct(e.model_inference_at,true):"—"]];
  $("emaDetailBodyPatch").innerHTML=`<div class="detail-kv">${rows.map(([k,v])=>`<div><span>${esc(k)}</span><strong>${esc(v??"—")}</strong></div>`).join("")}</div><details class="detail-context"><summary>Model context</summary><pre>${esc(JSON.stringify(e.context_summary||{},null,2))}</pre></details>`;$("emaDetailModalPatch").classList.remove("hidden");
}
const closeEma=()=>$("emaDetailModalPatch")?.classList.add("hidden");

function latestBrief(){return[...(state.briefs||[])].sort((a,b)=>new Date(b.brief_time)-new Date(a.brief_time))[0]||null;}
function roadLevels(){const b=latestBrief();if(!b||!Array.isArray(b.levels))return[];return b.levels.map(l=>{const ml=Number(l.mes_low??l.mes_level??l.mes_price),mh=Number(l.mes_high??l.mes_level??l.mes_price),sl=Number(l.spx_low??l.spx_level??l.spx_price),sh=Number(l.spx_high??l.spx_level??l.spx_price);return{...l,ml,mh,mid:Number.isFinite(ml)&&Number.isFinite(mh)?(ml+mh)/2:NaN,sl,sh};}).filter(l=>Number.isFinite(l.mid));}
function roadColor(l){const t=String(l.type||l.status||"").toUpperCase();return t.includes("RESIST")?"#ff6b78":t.includes("SUPPORT")||t.includes("RECLAIM")?"#44d19d":"#f5bd59";}
const TV_SYNC_KEY="v33-tv-execution-levels-synced",TV_COPY_KEY="v33-tv-execution-levels-copied";
function tvTick(v){return Math.round(Number(v)*4)/4;}
function tvNum(v){return Number.isFinite(Number(v))?tvTick(v).toFixed(2):"";}
function tvCode(t){const x=String(t||"").toUpperCase(),m={PREV_SESSION_POC:"PS_POC",PREV_RTH_POC:"RTH_POC",NAKED_POC:"NPOC",DEV_SESSION_POC:"DEV_POC",DEV_SESSION_VAH:"DEV_VAH",DEV_SESSION_VAL:"DEV_VAL",PREV_SESSION_HVN:"PS_HVN",PREV_SESSION_LVN:"PS_LVN",PREV_RTH_VAH:"RTH_VAH",PREV_RTH_VAL:"RTH_VAL",ROLL5_POC:"R5_POC",ROLL3_POC:"R3_POC",PRIOR_RTH_CLOSE:"RTH_CLOSE",SESSION_OPEN:"OPEN",PRIOR_RTH_HIGH:"RTH_HIGH",PRIOR_RTH_LOW:"RTH_LOW",PRIOR_SESSION_HIGH:"PS_HIGH",PRIOR_SESSION_LOW:"PS_LOW",SWING_1H_HIGH:"1H_HIGH",SWING_1H_LOW:"1H_LOW",SWING_5M_HIGH:"5M_HIGH",SWING_5M_LOW:"5M_LOW"};return m[x]||x.replace(/[^A-Z0-9]+/g,"_").replace(/^_+|_+$/g,"").slice(0,16)||"LEVEL";}
function tvPenalty(r){const f=String(r.level_family||""),t=String(r.level_type||"");if(f==="PROFILE_DEVELOPING")return 0;if(f==="PROFILE_COMPLETED")return 1;if(f==="PROFILE_PERSISTENT")return 2;if(f==="PROFILE_NODE")return 3;if(f==="PROFILE_COMPOSITE")return 4;if(f==="PRICE_STRUCTURE")return 5;if(f==="PRICE_SWING"&&t.startsWith("SWING_1H_"))return 6;return 99;}
function tvRange(r){let p=Number(r.reference_price),lo=r.zone_low===null||r.zone_low===undefined?NaN:Number(r.zone_low),hi=r.zone_high===null||r.zone_high===undefined?NaN:Number(r.zone_high);if(!Number.isFinite(p))return null;if(!Number.isFinite(lo))lo=p;if(!Number.isFinite(hi))hi=p;if(lo>hi)[lo,hi]=[hi,lo];lo=tvTick(lo);hi=tvTick(hi);return{r,lo,hi,mid:(lo+hi)/2,pen:tvPenalty(r),code:tvCode(r.level_type)};}
function tvServingLive(){const h=state.ofHealth,m=h&&typeof h.metadata==="object"?h.metadata:{},age=(Date.now()-Date.parse(h?.updated_at||0))/1000,scope=Array.isArray(m.production_scope)?m.production_scope.map(String):[];return !!(h&&String(h.status).toUpperCase()==="LIVE"&&h.scoring_enabled===true&&age>=0&&age<120&&m.supabase_publication_enabled===true&&m.website_serving_enabled===true&&m.nq_mnq_retired===true&&scope.length===2&&scope.includes("ES")&&scope.includes("MES"));}
function tvClusterLabel(items){const a=[...(items||[])].sort((x,y)=>x.pen-y.pen||x.mid-y.mid),codes=a.map(x=>x.code),parts=[];const poc=codes.filter(x=>x.includes("POC")).length;if(poc>=2)parts.push(`POCx${poc}`);const rest=[...new Set(codes.filter(x=>!(poc>=2&&x.includes("POC"))))];parts.push(...rest.slice(0,3));if(rest.length>3)parts.push(`N${rest.length-3}`);return parts.join("+")||"OF";}
function tvClusters(items,mesPx){const src=[...(items||[])].sort((a,b)=>a.mid-b.mid),out=[];for(const x of src){const c=out[out.length-1],newLo=c?Math.min(c.lo,x.lo):x.lo,newHi=c?Math.max(c.hi,x.hi):x.hi;if(c&&x.lo<=c.hi+.5&&newHi-newLo<=4){c.lo=newLo;c.hi=newHi;c.mid=(newLo+newHi)/2;c.items.push(x);c.pen=Math.min(c.pen,x.pen);}else out.push({lo:x.lo,hi:x.hi,mid:x.mid,items:[x],pen:x.pen});}for(const c of out)c.score=Math.abs(c.mid-mesPx)+c.pen*.35-Math.min(c.items.length,5)*.2;return out.sort((a,b)=>a.score-b.score||a.mid-b.mid);}
function tvNyCode(l){const z=String(l.label||"").toUpperCase();if(z.includes("ATH CLOSE"))return"ATH_CLOSE";if(z==="ATH")return"ATH";if(z.includes("SESSION HIGH"))return"SESSION_HIGH";if(z.includes("SESSION LOW"))return"SESSION_LOW";if(z.includes("MAJOR RESISTANCE"))return"MAJOR_RES";if(z.includes("MAJOR STRUCTURAL SUPPORT"))return"STRUCT_SUP";if(z.includes("CRITICAL")||z.includes("MAJOR SUPPORT"))return"MAJOR_SUP";if(z.includes("PSYCHOLOGICAL"))return"PSYCH";if(z.includes("200-DAY"))return"200DMA";if(z.includes("CASH OPEN"))return"CASH_OPEN";if(z.includes("ACCEPTANCE"))return"ACCEPT";return tvCode(l.type||"NY");}
function tvStatusCode(s){const x=String(s||"").toUpperCase();return x==="RECLAIMED"?"RC":x==="REJECTED"?"RJ":"A";}
function tvKind(l){const x=String(l.type||l.status||"").toUpperCase();return x.includes("RESIST")?"R":x.includes("SUPPORT")||x.includes("RECLAIM")?"S":"P";}
function tvHash(s){let h=2166136261>>>0;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)>>>0;}return`V${String(h%1000000).padStart(6,"0")}`;}
function tvMapLabel(l){return String(l.label||l.type||"Market level").replace(/[|,\r\n]+/g," / ").replace(/\s+/g," ").trim().slice(0,64);}
function buildTvExecutionPacket(){const levels=roadLevels().sort((a,b)=>b.mid-a.mid);if(!levels.length)return null;const records=[];for(const l of levels){const lo=tvTick(Math.min(l.ml,l.mh)),hi=tvTick(Math.max(l.ml,l.mh));records.push(`N,${tvNum(lo)},${tvNum(hi)},${tvKind(l)},${tvStatusCode(l.status)},${tvMapLabel(l)}`);}if(!records.length)return null;const body=records.join("|"),version=tvHash(body),packet=`H,${version}|${body}`;return{packet,version,nyCount:records.length,total:records.length};}
async function tvCopy(text){if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(text);return;}const ta=document.createElement("textarea");ta.value=text;ta.style.position="fixed";ta.style.opacity="0";document.body.appendChild(ta);ta.select();document.execCommand("copy");ta.remove();}
function renderTvSync(){const host=$("tvLevelSyncPatch");if(!host)return;const x=buildTvExecutionPacket();window.FM_V33_TV_EXECUTION_PACKET=x?.packet||null;window.FM_V33_TV_EXECUTION_VERSION=x?.version||null;const status=$("tvSyncStatusPatch"),meta=$("tvSyncMetaPatch"),copy=$("tvCopyLevelsPatch"),mark=$("tvMarkSyncedPatch");if(!x){status.textContent="Waiting for MES Market Map";status.className="tv-sync-status changed";meta.textContent="Need the latest hourly NY Market Update level map.";copy.disabled=true;mark.classList.add("hidden");return;}copy.disabled=false;let synced=null,copied=null;try{synced=localStorage.getItem(TV_SYNC_KEY);copied=localStorage.getItem(TV_COPY_KEY);}catch{}if(synced===x.version){status.textContent=`TradingView synced — ${x.version}`;status.className="tv-sync-status synced";copy.textContent="COPY AGAIN";mark.classList.add("hidden");}else if(copied===x.version){status.textContent=`Copied ${x.version} — paste into TradingView`;status.className="tv-sync-status copied";copy.textContent="COPY AGAIN";mark.classList.remove("hidden");}else{status.textContent=`Levels changed — ${x.version}`;status.className="tv-sync-status changed";copy.textContent="COPY NEW LEVELS";mark.classList.add("hidden");}meta.textContent=`${x.total} MES Market Map levels · same support / pivot / resistance colors · Order Flow excluded`;copy.dataset.packet=x.packet;mark.dataset.version=x.version;}
function ensureMarketChart(){
  const el=$("marketRoadmapChartPatch");if(P.marketChart||!el||!window.LightweightCharts)return;
  P.marketChart=LightweightCharts.createChart(el,{layout:{background:{color:"#0b111c"},textColor:"#9aacc0"},grid:{vertLines:{color:"#131e2d"},horzLines:{color:"#131e2d"}},rightPriceScale:{borderColor:"#233248"},localization:{timeFormatter:t=>chartTime(t,true)},timeScale:{borderColor:"#233248",timeVisible:true,secondsVisible:false,tickMarkFormatter:t=>chartTick(t)},crosshair:{mode:0}});
  P.marketCandles=P.marketChart.addSeries(LightweightCharts.CandlestickSeries,{upColor:"#44d19d",downColor:"#ff6b78",borderVisible:false,wickUpColor:"#44d19d",wickDownColor:"#ff6b78",priceLineVisible:true,lastValueVisible:true});
  new ResizeObserver(()=>P.marketChart?.applyOptions({width:el.clientWidth,height:el.clientHeight})).observe(el);
}
function mergeLive(rows,symbol,tf){const data=(rows||[]).map(chartBar).filter(x=>[x.open,x.high,x.low,x.close,x.time].every(Number.isFinite)).sort((a,b)=>a.time-b.time),live=P.live[key(symbol,tf)];if(!live)return data;const l={...chartBar(live),projected:true},i=data.findIndex(x=>x.time===l.time);if(i>=0){const b=data[i];data[i]={time:b.time,open:b.open,high:Math.max(b.high,l.high),low:Math.min(b.low,l.low),close:l.close,projected:true};}else if(!data.length||l.time>data[data.length-1].time)data.push(l);return data;}
function canonicalEs5mLineBreakSource(){
  const rows=[...(state.market5mBars||[])].sort((a,b)=>Number(a.bar_open_ms)-Number(b.bar_open_ms));
  const data=rows.map(chartBar).filter(x=>[x.open,x.high,x.low,x.close,x.time].every(Number.isFinite));
  const q=latestQuote("ES"),price=Number(q?.last),ts=Date.parse(q?.timestamp||q?.updated_at||""),lastCloseMs=Number(rows[rows.length-1]?.bar_close_ms);
  if(!Number.isFinite(price)||!Number.isFinite(ts)||!Number.isFinite(lastCloseMs)||ts<lastCloseMs||Date.now()-ts>120000)return data;
  const bucket=Math.floor(ts/300000)*300000,time=bucket/1000,last=data[data.length-1],open=Number.isFinite(Number(last?.close))?Number(last.close):price,l={time,open,high:Math.max(open,price),low:Math.min(open,price),close:price,projected:true},i=data.findIndex(x=>x.time===time);
  if(i>=0){const b=data[i];data[i]={time:b.time,open:b.open,high:Math.max(b.high,price),low:Math.min(b.low,price),close:price,projected:true};}
  else if(!data.length||time>data[data.length-1].time)data.push(l);
  return data;
}
function renderMarketChart(){
  ensureMarketChart();if(!P.marketCandles)return;const mode=chartMode("ny"),q=latestQuote("MES");if(mode==="candles"&&q)setLiveFromQuote(q);const source=mode==="linebreak"?canonicalEs5mLineBreakSource():mergeLive(P.context.mes_bars,"MES","5m"),lb=mode==="linebreak"?lineBreak3(source):[],data=mode==="linebreak"?lineBreakPlot(lb):source,range=P.marketRange||P.marketChart.timeScale().getVisibleLogicalRange();P.marketCandles.applyOptions({wickVisible:mode==="candles",borderVisible:false});P.marketCandles.setData(data);
  for(const x of P.marketLines)try{P.marketCandles.removePriceLine(x);}catch{}P.marketLines=[];
  const levels=roadLevels();for(const l of levels)for(const price of [...new Set([l.ml,l.mh].filter(Number.isFinite))])try{P.marketLines.push(P.marketCandles.createPriceLine({price,color:roadColor(l),lineWidth:2,lineStyle:l.ml!==l.mh?2:0,axisLabelVisible:true,title:l.label||l.type||"Market level"}));}catch{}
  if(P.marketFit&&data.length){P.marketChart.timeScale().fitContent();P.marketFit=false;}else if(range)try{P.marketChart.timeScale().setVisibleLogicalRange(range);}catch{}
  P.marketRange=P.marketChart.timeScale().getVisibleLogicalRange();const b=latestBrief(),lbs=mode==="linebreak"?lineBreakState(lb):null;$("marketChartBriefTimePatch").textContent=b?ct(b.brief_time,true):"WAITING";$("marketChartStatusPatch").textContent=mode==="linebreak"?`Canonical ES 5m · 3-Line Break · ${data.length} lines · ${lbs?.label||"WAITING"} · live ES projection · ${levels.length} MES roadmap levels · CT`:`5m MES · ${data.length} bars incl. live-forming candle · ${levels.length} Market Update levels · Central Time (CT)`;
  $("marketRoadmapLevelsPatch").innerHTML=levels.length?levels.sort((a,b)=>b.mid-a.mid).map(l=>{const mes=l.ml!==l.mh?`${n(l.ml)}–${n(l.mh)}`:n(l.mid),spx=Number.isFinite(l.sl)?(l.sl!==l.sh?`${n(l.sl)}–${n(l.sh)}`:n(l.sl)):"—";return`<div class="roadmap-level" style="--level:${roadColor(l)}"><div><strong>MES ${mes}</strong><span>${esc(l.type||"LEVEL")} · ${esc(l.status||"ACTIVE")}</span></div><small>SPX ${spx} · ${esc(l.label||"")}</small></div>`;}).join(""):'<div class="empty-state">Waiting for the latest Market Update levels.</div>';
}
async function refreshContext(force=false){if(!state.session)return;if(!force&&Date.now()-P.contextAt<15000)return;const {data,error}=await client.rpc("get_command_center_context_v33");if(!error&&data){P.context=data;P.contextAt=Date.now();window.FM_V33_CONTEXT=data;window.FM_V33_CONTEXT_AT=P.contextAt;window.dispatchEvent(new CustomEvent("fm-v33-context-updated",{detail:{context:data,contextAt:P.contextAt}}));const q=latestQuote("MES");if(q)setLiveFromQuote(q);renderMarketChart();}}

function importantPenalty(r,ids){if(ids.has(r.level_id))return-100;const f=String(r.level_family||""),t=String(r.level_type||"");if(f==="PRICE_STRUCTURE")return 0;if(f==="PROFILE_DEVELOPING")return 1;if(f==="PROFILE_COMPLETED")return 2;if(f==="PROFILE_PERSISTENT")return 3;if(f==="PROFILE_COMPOSITE")return 4;if(f==="PROFILE_NODE")return 5;if(f==="PRICE_SWING"&&t.startsWith("SWING_1H_"))return 6;return 999;}
function importantLevels(px){const shared=window.FM_V33_IMPORTANT_LEVELS;if(typeof shared==="function")return shared(px);const ids=new Set((state.models||[]).map(m=>m.level_id).filter(Boolean));return(state.levels||[]).map(r=>{const p=Number(r.reference_price),pen=importantPenalty(r,ids),d=Number.isFinite(px)&&Number.isFinite(p)?Math.abs(p-px):9999;return{r,pen,d,score:pen*4+Math.min(d,250)/10};}).filter(x=>x.pen<999).sort((a,b)=>a.score-b.score||a.d-b.d).slice(0,18).map(x=>x.r);}
function styleStructural(){
  if(!state.chart||!state.candles)return;state.chart.applyOptions({localization:{timeFormatter:t=>chartTime(t,true)},timeScale:{timeVisible:true,secondsVisible:false,tickMarkFormatter:t=>chartTick(t)}});
  const q=latestQuote("ES"),px=Number(q?.last),drawn=importantLevels(px);for(const l of state.priceLines||[])try{state.candles.removePriceLine(l);}catch{}state.priceLines=[];
  for(const r of drawn){const p=Number(r.reference_price);if(!Number.isFinite(p))continue;let color="#708196",style=2,width=1;const w=r.watch_probability,s=r.standard_probability,f=String(r.level_family||"");if(s!==null&&s!==undefined){color="#62c7ff";style=0;width=2;}else if(w!==null&&w!==undefined){color="#a98cff";style=0;width=2;}else if(f.startsWith("PROFILE_"))color="#f5bd59";else if(f==="PRICE_STRUCTURE")color="#d5dde8";try{state.priceLines.push(state.candles.createPriceLine({price:p,color,lineWidth:width,lineStyle:style,axisLabelVisible:true,title:String(r.level_type||"").replaceAll("_"," ")}));}catch{}}
  if(P.structAllowFit){P.structAllowFit=false;P.structRange=null;}else if(P.structRange)try{state.chart.timeScale().setVisibleLogicalRange(P.structRange);}catch{}
  const mode=chartMode("structural"),dataCount=(state.bars||[]).length+1;if(mode==="linebreak"){const rr=window.FM_V33_RENDER_STRUCTURAL_CHART;if(typeof rr==="function")rr();}else $("chartStatus").textContent=`${state.tf} · ${dataCount} bars incl. live-forming candle · ${drawn.length} important levels drawn (${(state.levels||[]).length} active loaded) · Central Time (CT)`;
  if(q&&mode==="candles"){setLiveFromQuote(q);const b=P.live[key("ES",state.tf)];if(b)try{state.candles.update(chartBar(b));}catch{}}
}
function liveStructural(row){if(row.symbol!=="ES")return;setLiveFromQuote(row);if(state.candles){if(chartMode("structural")==="linebreak"){const rr=window.FM_V33_RENDER_STRUCTURAL_CHART;if(typeof rr==="function")rr();}else{const b=P.live[key("ES",state.tf)];if(b)try{state.candles.update(chartBar(b));}catch{}}}if(chartMode("ny")==="linebreak")renderMarketChart();}
function liveMarket(row){if(row.symbol!=="MES")return;window.FM_V33_LIVE_MES_QUOTE=row;window.dispatchEvent(new CustomEvent("fm-v33-mes-live-quote",{detail:row}));if(!P.marketCandles)return;setLiveFromQuote(row);if(chartMode("ny")==="linebreak"){renderMarketChart();return;}const b=P.live[key("MES","5m")];if(b)try{P.marketCandles.update(chartBar(b));}catch{}}

function fullRefresh(){
  installDom();const stamp=state.lastFetch instanceof Date?state.lastFetch.getTime():Date.parse(state.lastFetch||0)||0;
  if(stamp!==P.lastFullFetch){P.lastFullFetch=stamp;renderSnapshot();styleStructural();renderTvSync();void refreshContext(true);}
}
function captureRanges(){if(state.chart&&!P.structAllowFit){const r=state.chart.timeScale().getVisibleLogicalRange();if(r)P.structRange={from:r.from,to:r.to};}if(P.marketChart){const r=P.marketChart.timeScale().getVisibleLogicalRange();if(r)P.marketRange={from:r.from,to:r.to};}}

installDom();renderSnapshot();
window.addEventListener("fm-v33-state-updated",fullRefresh);
window.addEventListener("fm-v33-realtime-data",e=>{const tables=new Set(e.detail?.tables||[]);if(tables.has("ema_cci_v2_events")||tables.has("service_health"))renderSnapshot();if(["orderflow_levels","orderflow_model_state","orderflow_chart_bars"].some(t=>tables.has(t)))styleStructural();if(tables.has("market_briefs")){renderTvSync();renderMarketChart();}});
window.addEventListener("fm-v33-live-quote",e=>{const r=e.detail;if(!r||!["ES","MES"].includes(r.symbol))return;if(r.symbol==="ES")liveStructural(r);else liveMarket(r);});
document.addEventListener("click",e=>{const snap=e.target.closest("[data-ema-tf-patch]");if(snap)void openEma(snap.dataset.emaTfPatch);if(e.target.closest("[data-ema-close-patch]"))closeEma();},true);
document.addEventListener("keydown",e=>{if(e.key==="Escape")closeEma();});
document.addEventListener("click",e=>{if(e.target.closest("[data-tf]")){P.structAllowFit=true;P.structRange=null;}},true);
document.addEventListener("click",e=>{const b=e.target.closest('[data-chart-mode] button[data-mode]');if(!b)return;const h=b.closest('[data-chart-mode]'),keyName=h?.dataset.chartMode,mode=b.dataset.mode;if(!["ny","structural"].includes(keyName)||!(["linebreak","candles"].includes(mode)))return;try{localStorage.setItem(`v33-chart-mode-${keyName}`,mode);}catch{}syncChartModeButtons();if(keyName==="ny"){P.marketFit=true;P.marketRange=null;renderMarketChart();}else{P.structAllowFit=true;P.structRange=null;const rr=window.FM_V33_RENDER_STRUCTURAL_CHART;if(typeof rr==="function"){rr.fitNext=true;rr();}styleStructural();}},true);

document.addEventListener("click",async e=>{const copy=e.target.closest("#tvCopyLevelsPatch"),mark=e.target.closest("#tvMarkSyncedPatch");if(copy){const packet=copy.dataset.packet;if(!packet)return;try{await tvCopy(packet);const v=buildTvExecutionPacket()?.version;if(v)try{localStorage.setItem(TV_COPY_KEY,v);}catch{}renderTvSync();}catch(err){console.error("TradingView packet copy failed",err);copy.textContent="COPY FAILED";}return;}if(mark){const v=mark.dataset.version;if(v)try{localStorage.setItem(TV_SYNC_KEY,v);}catch{}renderTvSync();}},true);

setInterval(captureRanges,300);setInterval(()=>{if(state.session)void refreshContext();},20000);setTimeout(fullRefresh,500);
})();