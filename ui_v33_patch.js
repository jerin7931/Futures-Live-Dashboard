(()=>{"use strict";
const $=id=>document.getElementById(id);
const state=window.FM_V33_STATE,client=window.FM_V33_CLIENT;
if(!state||!client)return;
if(!document.getElementById("uiV33PatchStyle")){const st=document.createElement("style");st.id="uiV33PatchStyle";st.textContent=`
/* V33 UI patch — restored Market Update chart, timeframe EMA snapshot, preserved chart zoom */
.patch-panel{margin-top:0}
.ema-snapshot-panel{padding-bottom:14px}.ema-snapshot-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin-top:14px}.ema-snapshot-card{display:grid;gap:8px;text-align:left;background:#0a101a;color:var(--text);border:1px solid #1d2b3f;border-radius:13px;padding:13px;min-height:132px}.ema-snapshot-card:hover{border-color:#405a78;transform:translateY(-1px)}.ema-snapshot-card.trade{border-top:2px solid var(--cyan)}.ema-snapshot-card.won{border-top:2px solid var(--green)}.ema-snapshot-card.lost{border-top:2px solid var(--red)}.ema-snapshot-card.skip{border-top:2px solid #52657d}.ema-snapshot-card.empty{opacity:.55;cursor:default}.ema-snap-top{display:flex;align-items:center;justify-content:space-between;gap:8px}.ema-snap-top strong{font-size:16px}.ema-snap-top span{font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);text-align:right}.ema-snap-main{font-size:20px;font-weight:850}.ema-snap-main em{font-size:11px;font-style:normal;color:var(--muted);font-weight:700}.ema-snap-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:5px}.ema-snap-stats span{display:grid;gap:2px;color:var(--muted);font-size:9px;text-transform:uppercase;letter-spacing:.06em}.ema-snap-stats b{color:var(--text);font-size:12px;font-variant-numeric:tabular-nums}.ema-snapshot-card>small{color:var(--muted);font-size:10px}
.market-roadmap-panel{overflow:hidden}.market-roadmap-chart-layout{display:grid;grid-template-columns:minmax(0,1.75fr) minmax(290px,.65fr);gap:14px;margin-top:10px}.market-roadmap-chart{height:500px;margin-top:0}.market-roadmap-levels{max-height:500px;overflow:auto;display:grid;align-content:start;gap:7px;padding-right:3px}.roadmap-level{display:grid;gap:4px;padding:10px 11px;background:#09111d;border:1px solid var(--line);border-left:3px solid var(--level,#73859a);border-radius:10px}.roadmap-level>div{display:flex;justify-content:space-between;gap:8px}.roadmap-level strong{font-variant-numeric:tabular-nums}.roadmap-level span,.roadmap-level small{color:var(--muted);font-size:10px}.dot.resistance{background:var(--red)}.dot.pivot{background:var(--amber)}.dot.support{background:var(--green)}
.detail-modal{position:fixed;inset:0;z-index:50;display:grid;place-items:center;padding:24px}.detail-modal-backdrop{position:absolute;inset:0;background:rgba(2,6,11,.78);backdrop-filter:blur(4px)}.detail-modal-card{position:relative;width:min(1080px,96vw);max-height:88vh;overflow:auto;background:linear-gradient(180deg,#111b2b,#0a111c);border:1px solid #2a3a51;border-radius:18px;padding:20px;box-shadow:0 30px 90px rgba(0,0,0,.55)}.detail-modal-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;position:sticky;top:-20px;background:#101927;padding:10px 0 14px;z-index:2}.detail-modal-head h2{margin:3px 0}.detail-modal-head small{color:var(--muted)}.detail-kv{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin-top:8px}.detail-kv>div{display:grid;gap:4px;background:#090f18;border:1px solid #1c293b;border-radius:10px;padding:10px}.detail-kv span{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.07em}.detail-kv strong{font-size:12px;word-break:break-word}.detail-context{margin-top:14px}.detail-context summary{cursor:pointer;color:var(--cyan)}.detail-context pre{max-height:320px}
@media(max-width:1150px){.ema-snapshot-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.market-roadmap-chart-layout{grid-template-columns:1fr}.market-roadmap-levels{max-height:300px;grid-template-columns:1fr 1fr}.detail-kv{grid-template-columns:1fr 1fr}}
@media(max-width:700px){.ema-snapshot-grid{grid-template-columns:1fr 1fr}.market-roadmap-levels{grid-template-columns:1fr}.detail-kv{grid-template-columns:1fr}.market-roadmap-chart{height:360px}}
`;document.head.appendChild(st);}
const TFS=["5m","10m","15m","1h","4h"];
const P={context:{mes_bars:[]},contextAt:0,marketChart:null,marketCandles:null,marketLines:[],marketRange:null,marketFit:true,structRange:null,structAllowFit:false,lastFullFetch:0,live:{},quoteChannel:null};

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

function installDom(){
  document.querySelector(".price-strip")?.remove();
  const brief=$("briefCard");
  if(brief&&!$("emaSnapshotGridPatch"))brief.insertAdjacentHTML("afterend",`
    <article class="panel ema-snapshot-panel patch-panel">
      <div class="panel-head"><div><div class="eyebrow">ES · FROZEN EMA9/21 + CCI TRANSITION</div><h2>Signal Snapshot by Timeframe</h2><small>Latest server-scored ES event on each timeframe · click for full details.</small></div><span id="emaSnapshotFreshnessPatch" class="state-pill neutral">WAITING</span></div>
      <div id="emaSnapshotGridPatch" class="ema-snapshot-grid"></div>
    </article>`);
  const structural=$("priceChart")?.closest(".chart-panel");
  if(structural&&!$("marketRoadmapChartPatch"))structural.insertAdjacentHTML("beforebegin",`
    <article class="panel chart-panel market-roadmap-panel patch-panel">
      <div class="panel-head"><div><div class="eyebrow">MARKET UPDATE · SPX → MES ROADMAP</div><h2>MES Market Map</h2><small id="marketChartStatusPatch">5-minute MES candles · live-forming candle · Central Time (CT)</small></div><span id="marketChartBriefTimePatch" class="state-pill neutral">WAITING</span></div>
      <div class="market-roadmap-chart-layout"><div id="marketRoadmapChartPatch" class="chart market-roadmap-chart"></div><aside id="marketRoadmapLevelsPatch" class="market-roadmap-levels"><div class="empty-state">Waiting for the latest Market Update level map.</div></aside></div>
      <div class="chart-legend"><span><i class="dot resistance"></i>Resistance</span><span><i class="dot pivot"></i>Pivot</span><span><i class="dot support"></i>Support</span><span>Levels come directly from the stored Market Update SPX→MES conversion.</span></div>
    </article>`);
  if(structural){const h=structural.querySelector(".panel-head h2");if(h)h.textContent="Price + Important Active Levels";}
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
  host.innerHTML=TFS.map(tf=>{const e=latestEma(tf);if(!e)return`<button class="ema-snapshot-card empty" disabled><div class="ema-snap-top"><strong>${tf.toUpperCase()}</strong><span>NO EVENT</span></div><div class="ema-snap-main">—</div></button>`;const entry=e.actual_fill_price??e.planned_entry_price??e.v2_entry_proxy_price;return`<button class="ema-snapshot-card ${emaTone(e)}" data-ema-tf-patch="${tf}" type="button"><div class="ema-snap-top"><strong>${tf.toUpperCase()}</strong><span>${esc(String(e.execution_state||e.v2_decision||"—").replaceAll("_"," "))}</span></div><div class="ema-snap-main">${esc(e.direction||"—")} <em>${esc(e.signal||"")}</em></div><div class="ema-snap-stats"><span>P(TP) <b>${pct(e.v2_p_tp)}</b></span><span>EV <b>${e.gam_predicted_ev===null?"—":Number(e.gam_predicted_ev).toFixed(3)+"R"}</b></span><span>Entry <b>${n(entry)}</b></span></div><small>${ct(e.signal_close_utc,true)} · ${esc(e.production_quality||"—")} · click for details</small></button>`;}).join("");
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
function ensureMarketChart(){
  const el=$("marketRoadmapChartPatch");if(P.marketChart||!el||!window.LightweightCharts)return;
  P.marketChart=LightweightCharts.createChart(el,{layout:{background:{color:"#0b111c"},textColor:"#9aacc0"},grid:{vertLines:{color:"#131e2d"},horzLines:{color:"#131e2d"}},rightPriceScale:{borderColor:"#233248"},localization:{timeFormatter:t=>chartTime(t,true)},timeScale:{borderColor:"#233248",timeVisible:true,secondsVisible:false,tickMarkFormatter:t=>chartTick(t)},crosshair:{mode:0}});
  P.marketCandles=P.marketChart.addSeries(LightweightCharts.CandlestickSeries,{upColor:"#44d19d",downColor:"#ff6b78",borderVisible:false,wickUpColor:"#44d19d",wickDownColor:"#ff6b78",priceLineVisible:true,lastValueVisible:true});
  new ResizeObserver(()=>P.marketChart?.applyOptions({width:el.clientWidth,height:el.clientHeight})).observe(el);
}
function mergeLive(rows,symbol,tf){const data=(rows||[]).map(chartBar).filter(x=>[x.open,x.high,x.low,x.close,x.time].every(Number.isFinite)).sort((a,b)=>a.time-b.time),live=P.live[key(symbol,tf)];if(!live)return data;const l=chartBar(live),i=data.findIndex(x=>x.time===l.time);if(i>=0){const b=data[i];data[i]={time:b.time,open:b.open,high:Math.max(b.high,l.high),low:Math.min(b.low,l.low),close:l.close};}else if(!data.length||l.time>data[data.length-1].time)data.push(l);return data;}
function renderMarketChart(){
  ensureMarketChart();if(!P.marketCandles)return;const q=latestQuote("MES");if(q)setLiveFromQuote(q);const data=mergeLive(P.context.mes_bars,"MES","5m"),range=P.marketRange||P.marketChart.timeScale().getVisibleLogicalRange();P.marketCandles.setData(data);
  for(const x of P.marketLines)try{P.marketCandles.removePriceLine(x);}catch{}P.marketLines=[];
  const levels=roadLevels();for(const l of levels)for(const price of [...new Set([l.ml,l.mh].filter(Number.isFinite))])try{P.marketLines.push(P.marketCandles.createPriceLine({price,color:roadColor(l),lineWidth:2,lineStyle:l.ml!==l.mh?2:0,axisLabelVisible:true,title:l.label||l.type||"Market level"}));}catch{}
  if(P.marketFit&&data.length){P.marketChart.timeScale().fitContent();P.marketFit=false;}else if(range)try{P.marketChart.timeScale().setVisibleLogicalRange(range);}catch{}
  P.marketRange=P.marketChart.timeScale().getVisibleLogicalRange();const b=latestBrief();$("marketChartBriefTimePatch").textContent=b?ct(b.brief_time,true):"WAITING";$("marketChartStatusPatch").textContent=`5m MES · ${data.length} bars incl. live-forming candle · ${levels.length} Market Update levels · Central Time (CT)`;
  $("marketRoadmapLevelsPatch").innerHTML=levels.length?levels.sort((a,b)=>b.mid-a.mid).map(l=>{const mes=l.ml!==l.mh?`${n(l.ml)}–${n(l.mh)}`:n(l.mid),spx=Number.isFinite(l.sl)?(l.sl!==l.sh?`${n(l.sl)}–${n(l.sh)}`:n(l.sl)):"—";return`<div class="roadmap-level" style="--level:${roadColor(l)}"><div><strong>MES ${mes}</strong><span>${esc(l.type||"LEVEL")} · ${esc(l.status||"ACTIVE")}</span></div><small>SPX ${spx} · ${esc(l.label||"")}</small></div>`;}).join(""):'<div class="empty-state">Waiting for the latest Market Update levels.</div>';
}
async function refreshContext(force=false){if(!state.session)return;if(!force&&Date.now()-P.contextAt<15000)return;const {data,error}=await client.rpc("get_command_center_context_v33");if(!error&&data){P.context=data;P.contextAt=Date.now();const q=latestQuote("MES");if(q)setLiveFromQuote(q);renderMarketChart();}}

function importantPenalty(r,ids){if(ids.has(r.level_id))return-100;const f=String(r.level_family||""),t=String(r.level_type||"");if(f==="PRICE_STRUCTURE")return 0;if(f==="PROFILE_DEVELOPING")return 1;if(f==="PROFILE_COMPLETED")return 2;if(f==="PROFILE_PERSISTENT")return 3;if(f==="PROFILE_COMPOSITE")return 4;if(f==="PROFILE_NODE")return 5;if(f==="PRICE_SWING"&&t.startsWith("SWING_1H_"))return 6;return 999;}
function importantLevels(px){const ids=new Set((state.models||[]).map(m=>m.level_id).filter(Boolean));return(state.levels||[]).map(r=>{const p=Number(r.reference_price),pen=importantPenalty(r,ids),d=Number.isFinite(px)&&Number.isFinite(p)?Math.abs(p-px):9999;return{r,pen,d,score:pen*4+Math.min(d,250)/10};}).filter(x=>x.pen<999).sort((a,b)=>a.score-b.score||a.d-b.d).slice(0,18).map(x=>x.r);}
function styleStructural(){
  if(!state.chart||!state.candles)return;state.chart.applyOptions({localization:{timeFormatter:t=>chartTime(t,true)},timeScale:{timeVisible:true,secondsVisible:false,tickMarkFormatter:t=>chartTick(t)}});
  const q=latestQuote("ES"),px=Number(q?.last),drawn=importantLevels(px);for(const l of state.priceLines||[])try{state.candles.removePriceLine(l);}catch{}state.priceLines=[];
  for(const r of drawn){const p=Number(r.reference_price);if(!Number.isFinite(p))continue;let color="#708196",style=2,width=1;const w=r.watch_probability,s=r.standard_probability,f=String(r.level_family||"");if(s!==null&&s!==undefined){color="#62c7ff";style=0;width=2;}else if(w!==null&&w!==undefined){color="#a98cff";style=0;width=2;}else if(f.startsWith("PROFILE_"))color="#f5bd59";else if(f==="PRICE_STRUCTURE")color="#d5dde8";try{state.priceLines.push(state.candles.createPriceLine({price:p,color,lineWidth:width,lineStyle:style,axisLabelVisible:true,title:String(r.level_type||"").replaceAll("_"," ")}));}catch{}}
  if(P.structAllowFit){P.structAllowFit=false;P.structRange=null;}else if(P.structRange)try{state.chart.timeScale().setVisibleLogicalRange(P.structRange);}catch{}
  const dataCount=(state.bars||[]).length+1;$("chartStatus").textContent=`${state.tf} · ${dataCount} bars incl. live-forming candle · ${drawn.length} important levels drawn (${(state.levels||[]).length} active loaded) · Central Time (CT)`;
  if(q){setLiveFromQuote(q);const b=P.live[key("ES",state.tf)];if(b)try{state.candles.update(chartBar(b));}catch{}}
}
function liveStructural(row){if(row.symbol!=="ES"||!state.candles)return;setLiveFromQuote(row);const b=P.live[key("ES",state.tf)];if(b)try{state.candles.update(chartBar(b));}catch{}}
function liveMarket(row){if(row.symbol!=="MES"||!P.marketCandles)return;setLiveFromQuote(row);const b=P.live[key("MES","5m")];if(b)try{P.marketCandles.update(chartBar(b));}catch{}}

function fullRefresh(){
  installDom();const stamp=state.lastFetch instanceof Date?state.lastFetch.getTime():Date.parse(state.lastFetch||0)||0;
  if(stamp!==P.lastFullFetch){P.lastFullFetch=stamp;renderSnapshot();styleStructural();ensureQuoteSubscription();void refreshContext(true);}
}
function captureRanges(){if(state.chart&&!P.structAllowFit){const r=state.chart.timeScale().getVisibleLogicalRange();if(r)P.structRange={from:r.from,to:r.to};}if(P.marketChart){const r=P.marketChart.timeScale().getVisibleLogicalRange();if(r)P.marketRange={from:r.from,to:r.to};}}

installDom();renderSnapshot();
window.addEventListener("fm-v33-state-updated",fullRefresh);
document.addEventListener("click",e=>{const snap=e.target.closest("[data-ema-tf-patch]");if(snap)void openEma(snap.dataset.emaTfPatch);if(e.target.closest("[data-ema-close-patch]"))closeEma();},true);
document.addEventListener("keydown",e=>{if(e.key==="Escape")closeEma();});
document.addEventListener("click",e=>{if(e.target.closest("[data-tf]")){P.structAllowFit=true;P.structRange=null;}},true);

function ensureQuoteSubscription(){
  if(!state.session||P.quoteChannel)return;
  P.quoteChannel=client.channel("v33-ui-live-candles").on("postgres_changes",{event:"*",schema:"public",table:"market_quotes_live"},p=>{const r=p.new;if(!r||!["ES","MES"].includes(r.symbol))return;if(r.symbol==="ES")liveStructural(r);else liveMarket(r);}).subscribe();
}
setInterval(captureRanges,300);setInterval(()=>{if(state.session){ensureQuoteSubscription();void refreshContext();}},20000);setTimeout(fullRefresh,500);
})();