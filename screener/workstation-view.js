import {ROUTES,SORTS,STATES,filterOpportunities,paginate,availableIndustries,filterNews,selectOpportunity,dashboardStatus,routeHref} from "./dashboard-core.js?v=3.0.31";
import {renderOptionsAnalysis} from "./options-analysis-view.js?v=3.0.36";
import {TRACKER_SORTS,TRACKER_TERMINAL,TRACKER_FIELDS,defaultTrackerFilters,hydrateTrackerRows,filterTracked,matchesTrackerRule,HIGH_QUALITY_RULES} from "./tracking-core.js?v=3.0.39";

export const esc=value=>String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
const finite=value=>typeof value==="number"&&Number.isFinite(value);
const fmt=(value,digits=2)=>finite(value)?value.toLocaleString(undefined,{minimumFractionDigits:digits,maximumFractionDigits:digits}):"—";
const pct=(value,digits=2)=>finite(value)?`${value>0?"+":""}${fmt(value,digits)}%`:"—";
const compact=value=>finite(value)?Intl.NumberFormat(undefined,{notation:"compact",maximumFractionDigits:1}).format(value):"—";
const clock=value=>{const time=Date.parse(value||"");return Number.isFinite(time)?new Date(time).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"}):"—";};
const dateTime=value=>{const time=Date.parse(value||"");return Number.isFinite(time)?new Date(time).toLocaleString([],{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}):"—";};
const tone=value=>finite(value)?value>0?"positive":value<0?"negative":"neutral":"muted";
const stateTone=value=>({CONFIRMED:"positive",CONFIRMING:"cyan",EMERGING:"blue",DEGRADING:"amber",REVERSED:"violet",NO_TREND:"muted"}[value]||"muted");
const safeUrl=value=>{try{const url=new URL(value);return url.protocol==="https:"?url.href:null;}catch{return null;}};
const checked=(array,value)=>array.includes(value)?" checked":"";
const selected=(actual,value)=>actual===value?" selected":"";

function badge(text,kind="muted"){return `<span class="badge ${esc(kind)}">${esc(text||"—")}</span>`;}
function freshness(value){return badge(value?.state||"UNAVAILABLE",String(value?.state||"unavailable").toLowerCase());}
function direction(row){if(!row?.v1_direction)return `<span class="direction-none" title="Last evidence bias: ${esc(row?.last_evidence_bias||"none")}">—</span>`;return badge(row.v1_direction,row.v1_direction==="LONG"?"positive direction-long":"negative direction-short");}
function stateBadge(row){const label=row.v1_state==="REVERSED"?`REVERSED → ${row.v1_direction||"—"}`:row.v1_state;return badge(label,`${stateTone(row.v1_state)} state-${String(row.v1_state||"unknown").toLowerCase().replaceAll("_","-")}`);}
function optionBadge(row){const value=row.option_quality||row.option_status||"NOT_REQUIRED";if(value==="NOT_REQUIRED")return `<span class="direction-none">—</span>`;return badge(value,`option-${String(value).toLowerCase().replaceAll("_","-")}`);}
function trackerBadge(row){return row.tracker_state?badge(row.tracker_state,`tracker-${String(row.tracker_state).toLowerCase().replaceAll("_","-")}`):"";}
function tmCell(row){const values=["5","15","30","60"].map(key=>row.trend_magic?.timeframes?.[key]);const known=values.filter(value=>value?.state);if(!known.length)return `<span class="muted">Warming up</span>`;return `<div class="tm-dots" title="${esc(row.trend_magic?.agreement_pattern||"")}">${values.map((value,index)=>`<span class="tm-dot ${value?.state==="BLUE"?"up":value?.state==="RED"?"down":"warm"}">${[5,15,30,60][index]}</span>`).join("")}</div>`;}
function newsLink(item,small=false){const url=safeUrl(item?.url);const title=esc(item?.headline||"No current headline");return `<div class="news-line${small?" compact":""}"><span class="news-time">${clock(item?.first_seen_at)}</span><span>${url?`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${title}</a>`:title}<small>${esc(item?.source||"Unknown source")} · ${esc(item?.category||"UNCLASSIFIED")}</small></span></div>`;}
function relatedNews(row,model){const news=model?.news||[];const groups={company:row.news||[],industry:news.filter(item=>row.industry&&(item.industry||[]).includes(row.industry)&&!(item.symbols||[]).includes(row.symbol)),sector:news.filter(item=>row.sector&&(item.sector||[]).includes(row.sector)&&!(item.symbols||[]).includes(row.symbol)),market:news.filter(item=>item.scope==="MARKET")};const labels={company:"Company news",industry:"Industry news",sector:"Sector news",market:"Market news"};return Object.entries(labels).map(([key,label])=>{const items=groups[key]||[];return `<div class="related-news"><strong>${label}</strong>${items.slice(0,3).map(item=>newsLink(item,true)).join("")||`<small>None currently mapped.</small>`}</div>`;}).join("");}
function why(row){return (row.why_picked||[]).length?row.why_picked.map(value=>`<span>${esc(value)}</span>`).join(""):"<span>Discovery evidence unavailable</span>";}
function capacityWarnings(model){return (model.capacity_warnings||[]).map(value=>`<div class="capacity-warning"><strong>${esc(value.warning||value.state)}</strong><span>${esc((value.affected_symbols||[]).join(" · ")||"Provider capacity is currently deferred.")}</span></div>`).join("");}

function opportunityRows(rows,{compactHome=false,watchlist=new Set()}={}){
  if(!rows.length)return `<tr><td colspan="14" class="empty">No opportunities match the current filters.</td></tr>`;
  return rows.map(row=>`<tr data-symbol="${esc(row.symbol)}" class="selectable-row${row.freshness?.quote?.state==="STALE"?" stale-row":""}">
    <td><button class="symbol-button" data-action="select" data-symbol="${esc(row.symbol)}">${esc(row.symbol)}</button><small>${esc(row.company_name||"")}</small></td>
    <td>${direction(row)}</td><td>${stateBadge(row)}${trackerBadge(row)}</td><td>${tmCell(row)}</td>
    <td><div class="why-cell">${why(row)}</div></td><td class="${tone(row.change_1d_pct)}">${pct(row.change_1d_pct)}</td><td class="${tone(row.move_5m_pct)}">${pct(row.move_5m_pct)}</td>
    <td><strong>${compact(row.session_volume)}</strong><small>RVOL ${fmt(row.finviz_rvol,2)}</small></td><td>${fmt(row.efficiency,2)}<small>ATR $${fmt(row.atr_dollars)} · ${pct(row.atr_percent)}</small><small>${esc(row.movement_quality||"Unavailable")}</small></td><td class="${tone(row.market_relative)}">${pct(row.market_relative)}</td>
    <td>${optionBadge(row)}<small>${esc(row.option_status==="NOT_REQUIRED"?"Not tracked":row.option_status||row.option_execution_quality?.state||"Queued")}</small></td>
    <td><span>${esc(row.sector||"Unknown")}</span><small>${esc(row.industry||"Unknown")}</small></td>
    <td>${row.news?.length?`<span class="catalyst-dot"></span>${esc(row.news[0].category)}`:`<span class="muted">No news</span>`}</td>
    <td><button class="icon-button" data-action="watch" data-symbol="${esc(row.symbol)}" aria-label="${watchlist.has(row.symbol)?"Remove from":"Add to"} watchlist">${watchlist.has(row.symbol)?"★":"☆"}</button><button class="view-button" data-action="select" data-symbol="${esc(row.symbol)}">View</button></td>
  </tr>`).join("");
}

function radarTable(rows,options={}){return `<div class="radar-table-wrap"><table class="radar-table${options.compactHome?" home-table":""}"><colgroup><col class="c-symbol"><col class="c-direction"><col class="c-state"><col class="c-tm"><col class="c-why"><col class="c-number"><col class="c-number"><col class="c-volume"><col class="c-eff"><col class="c-rel"><col class="c-options"><col class="c-sector"><col class="c-news"><col class="c-action"></colgroup><thead><tr><th>Symbol</th><th>Direction</th><th>Trend State / Tracker</th><th>Trend Magic</th><th>Why it was picked</th><th>1D</th><th>5m</th><th>Volume / RVOL</th><th>Efficiency</th><th>Rel. Strength</th><th>Options</th><th>Sector / Industry</th><th>Catalyst / News</th><th>Action</th></tr></thead><tbody>${opportunityRows(rows,options)}</tbody></table></div>`;}

function marketChange(item){return finite(item.change_pct)?item.change_pct:item.change_1d_pct;}
function macroStatus(item){if(item.freshness?.state==="STALE")return freshness(item.freshness);if(item.delayed===true)return badge("DELAYED","delayed");return freshness(item.freshness);}
function marketPanel(model){return `<article class="panel summary-card"><div class="panel-title"><div><span class="eyebrow">BROAD MARKET</span><h2>Market pulse</h2></div><a href="${routeHref("market",model.data_mode.startsWith("SIMULATED"))}">View all →</a></div><div class="market-list">${(model.market||[]).slice(0,8).map(item=>`<div><span><strong>${esc(item.key||item.symbol)}</strong><small>${esc(item.label||item.key||item.symbol)}</small></span><span class="metric-value">${fmt(item.value,2)}<small class="${tone(marketChange(item))}">${pct(marketChange(item))}</small>${macroStatus(item)}</span></div>`).join("")}</div></article>`;}
function marketNewsPanel(model){return `<article class="panel summary-card"><div class="panel-title"><div><span class="eyebrow">MARKET NEWS</span><h2>News &amp; catalysts</h2></div><a href="${routeHref("news",model.data_mode.startsWith("SIMULATED"))}">Live feed →</a></div><div class="news-list">${(model.market_news||[]).slice(0,4).map(item=>newsLink(item,true)).join("")||`<p class="empty">No current broad-market headline.</p>`}</div></article>`;}
function groupPanel(title,eyebrow,rows,route,model){return `<article class="panel summary-card"><div class="panel-title"><div><span class="eyebrow">${esc(eyebrow)}</span><h2>${esc(title)}</h2></div><a href="${routeHref(route,model.data_mode.startsWith("SIMULATED"))}">Explore →</a></div><div class="group-bars">${rows.slice(0,6).map(row=>`<div><span>${esc(row.name)}<small>${row.radar_member_count} radar</small></span><span class="bar-track"><i class="${tone(row.performance_1d_pct)}" style="width:${Math.min(100,Math.max(5,Math.abs(row.performance_1d_pct||0)*15))}%"></i></span><strong class="${tone(row.performance_1d_pct)}">${pct(row.performance_1d_pct)}</strong></div>`).join("")||`<p class="empty">Unavailable</p>`}</div></article>`;}

function optionExecutionDetail(row){
  const context=row.option_execution_quality;
  if(row.option_status==="NOT_REQUIRED")return `<p class="muted">Not tracked · option enrichment begins only for an active sticky confirmed lifecycle.</p>`;
  if(!context||!(context.contracts||[]).length)return `<p class="muted">${esc(row.option_status||context?.state||"QUEUED")}${row.option_reason_code?` · ${esc(row.option_reason_code)}`:""} · read-only Webull option market data; no trade suggestion.</p>`;
  return `<div class="tracker-option-list">${context.contracts.map(contract=>`<article><div>${badge(contract.expiry_label,"blue")}${badge(contract.quality,`option-${String(contract.quality).toLowerCase()}`)}</div><strong>${esc(contract.right)} ${esc(contract.expiration)} · ${fmt(Number(contract.strike))}</strong><small>${esc(contract.symbol)}</small><dl><dt>Bid / ask</dt><dd>${fmt(Number(contract.bid))} / ${fmt(Number(contract.ask))}</dd><dt>Midpoint</dt><dd>${fmt(Number(contract.midpoint))}</dd><dt>Spread</dt><dd>${fmt(Number(contract.spread_pct),1)}%</dd><dt>Size</dt><dd>${esc(contract.bid_size||"—")} / ${esc(contract.ask_size||"—")}</dd><dt>Volume / OI</dt><dd>${compact(Number(contract.volume))} / ${compact(Number(contract.open_interest))}</dd><dt>Delta</dt><dd>${fmt(Number(contract.delta),3)}</dd><dt>Gamma / theta</dt><dd>${fmt(Number(contract.gamma),3)} / ${fmt(Number(contract.theta),3)}</dd><dt>IV</dt><dd>${finite(Number(contract.implied_volatility))?pct(Number(contract.implied_volatility)*100,1):"—"}</dd><dt>Quote age</dt><dd>${fmt(Number(contract.quote_age_seconds),1)}s · ${esc(contract.freshness)}</dd></dl></article>`).join("")}</div><small>Reference contract: |delta| nearest 0.65, then spread, volume and open interest. Comparison only; no “best” claim or order action.</small>`;
}

function detail(row,{inline=false,model=null}={}){
  if(!row)return `<article class="panel detail-panel"><p class="empty">Select an opportunity to inspect its evidence.</p></article>`;
  const tms=[5,15,30,60].map(frame=>{const value=row.trend_magic?.timeframes?.[String(frame)];return `<div><span>${frame}m</span>${value?.state?badge(value.state,value.state==="BLUE"?"positive":"negative"):badge(value?.status||"UNAVAILABLE","muted")}</div>`;}).join("");
  return `<article class="${inline?"":"panel "}detail-panel"><div class="detail-head"><div><span class="eyebrow">SECURITY DETAIL</span><h2>${esc(row.symbol)}</h2><p>${esc(row.company_name||"")}</p></div>${inline?"":`<button class="close-button" data-action="close-detail" aria-label="Close details">×</button>`}</div>
    <div class="detail-badges">${direction(row)}${stateBadge(row)}${trackerBadge(row)}${optionBadge(row)}${freshness(row.freshness?.quote)}</div>
    ${row.v1_state==="REVERSED"?`<p class="callout">Current ${esc(row.v1_direction)} · reversed from ${esc(row.reversed_from||"prior direction")}</p>`:""}
    <div class="detail-price"><strong>$${fmt(row.price)}</strong><span class="${tone(row.change_1d_pct)}">${pct(row.change_1d_pct)} today</span></div>
    <h3>Trend Magic <small>Descriptive only</small></h3><div class="tm-grid">${tms}</div>
    <h3>Relative strength</h3><dl><dt>vs ${esc(row.benchmark_symbol||"broad benchmark")}</dt><dd>${pct(row.market_relative)}</dd><dt>vs sector</dt><dd>${pct(row.sector_relative)}</dd><dt>vs industry</dt><dd>${pct(row.industry_relative)}</dd><dt>Peer breadth</dt><dd>${finite(row.peer_breadth)?pct(row.peer_breadth*100):"—"}</dd></dl>
    <h3>Key metrics</h3><dl><dt>Efficiency</dt><dd>${fmt(row.efficiency,2)}</dd><dt>Persistence</dt><dd>${fmt(row.persistence,2)}</dd><dt>5m move</dt><dd>${pct(row.move_5m_pct)}</dd><dt>Live volume</dt><dd>${compact(row.session_volume)}</dd><dt>Finviz RVOL</dt><dd>${fmt(row.finviz_rvol,2)}</dd><dt>Average volume</dt><dd>${compact(row.avg_volume)}</dd><dt>ATR $</dt><dd>${fmt(row.atr_dollars)}</dd><dt>ATR %</dt><dd>${pct(row.atr_percent)}</dd><dt>Movement</dt><dd>${esc(row.movement_quality||"Unavailable")}</dd><dt>Movement basis</dt><dd>${esc(row.movement_admission_basis||"—")}</dd></dl>
    <h3>Confirmed tracker</h3><dl><dt>Status</dt><dd>${esc(row.tracker_state||"Not started")}</dd><dt>First confirmed</dt><dd>${dateTime(row.tracker_first_confirmed_at)}</dd><dt>Current V1</dt><dd>${esc(row.v1_state||"—")}</dd></dl>
    <h3>Option execution quality <small>Market data only</small></h3>${optionExecutionDetail(row)}
    <h3>Why it was picked</h3><div class="tag-list">${why(row)}</div>
    <h3>Sector / industry</h3><p>${esc(row.sector||"Unknown")} · ${esc(row.industry||"Unknown")}</p>
    <h3>Catalyst &amp; news</h3><div class="news-list">${relatedNews(row,model)}</div>
    <details><summary>Evidence &amp; provenance</summary><dl><dt>Quote source</dt><dd>${esc(row.provenance?.price||"—")}</dd><dt>V1 state source</dt><dd>${esc(row.provenance?.v1_state||"—")}</dd><dt>Classification</dt><dd>${esc(row.provenance?.classification||"—")}</dd><dt>First nominated</dt><dd>${dateTime(row.first_nominated_at)}</dd><dt>Last nominated</dt><dd>${dateTime(row.last_nominated_at)}</dd><dt>Structural break</dt><dd>${row.structural_break?`${esc(row.structural_break.direction)} · ${clock(row.structural_break.at)}`:"—"}</dd></dl></details>
  </article>`;
}

function discoveryRows(model){return (model.opportunities||[]).filter(row=>!(row.confirmed_tracker?.alignment&&row.tracker_state&&!TRACKER_TERMINAL.has(row.tracker_state)));}
export function homeFocusData(model,now=Date.now()){
  const rows=hydrateTrackerRows(model,now).filter(row=>!TRACKER_TERMINAL.has(row.tracker_state));
  const highQuality=row=>matchesTrackerRule(row,HIGH_QUALITY_RULES[1])&&matchesTrackerRule(row,HIGH_QUALITY_RULES[2]);
  const best=rows.filter(row=>row.alignment==="ALIGNED"&&highQuality(row)).sort((a,b)=>(b.current_efficiency??-1)-(a.current_efficiency??-1)||(b.efficiency_at_confirmation??-1)-(a.efficiency_at_confirmation??-1)||a.id.localeCompare(b.id)).slice(0,5);
  const groups={ALIGNED:rows.filter(row=>row.alignment==="ALIGNED"),COUNTERTREND:rows.filter(row=>row.alignment!=="ALIGNED"),RECOVERING:rows.filter(row=>row.tracker_state==="RECOVERING")};
  const attention=rows.map(row=>{const reason=row.tracker_state==="INVALIDATION_PENDING"?"Invalidation pending":row.tracker_state==="WEAKENING"?"Weakening":row.tracker_state==="RECOVERING"?"Recovering":row.atr_fib?.status==="CURRENT"&&["50_TO_61_8","61_8_TO_78_6","78_6_TO_88_6","88_6_TO_TRAIL","BEYOND_TRAIL"].includes(row.atr_fib.zone)?`5m ATR pullback ${FIB_LABELS[row.atr_fib.zone]}`:null;
    return reason?{row,reason,priority:{INVALIDATION_PENDING:0,WEAKENING:1,RECOVERING:2}[row.tracker_state]??3}:null;}).filter(Boolean).sort((a,b)=>a.priority-b.priority||a.row.id.localeCompare(b.row.id)).slice(0,5);
  const symbols=new Set(rows.map(row=>row.symbol)),sectors=new Set(rows.map(row=>row.sector).filter(Boolean)),industries=new Set(rows.map(row=>row.industry).filter(Boolean));
  const news=[...(model.news||[])].sort((a,b)=>{
    const rank=item=>(item.symbols||[]).some(s=>symbols.has(s))?0:["FED","MACRO","ECON"].includes(item.category)||item.scope==="MARKET"?1:(item.symbols||[]).some(s=>["SPY","QQQ","IWM"].includes(s))?2:(item.sector||[]).some(s=>sectors.has(s))||(item.industry||[]).some(s=>industries.has(s))?3:4;
    return rank(a)-rank(b)||(Date.parse(b.first_seen_at||"")||0)-(Date.parse(a.first_seen_at||"")||0);
  }).slice(0,6);
  return {rows,best,groups,attention,news,highQuality};
}
function home(model,ui){
  const data=homeFocusData(model);const demo=ui.demo;const hour=new Date().getHours();const greeting=hour<12?"Good Morning":hour<18?"Good Afternoon":"Good Evening";
  const benchmarks=new Map((model.market_benchmarks||[]).map(row=>[row.symbol,row]));
  const markets=["SPY","QQQ","IWM"].map(symbol=>{const stored=benchmarks.get(symbol),value=stored?.payload||{};const same=stored?.session_date===model.market_session?.date;
    const direction=same?value.atr_5m_direction:null;const fib=same?value.atr_5m_fib:null;const quoteAge=benchmarkAge(value.latest_price_as_of,Date.now());const stale=!same||quoteAge==null||quoteAge>300;
    const vwap=same&&["ABOVE","BELOW"].includes(value.vwap_position)?`${value.vwap_position} VWAP`:"VWAP unavailable";
    return `<article class="panel focus-market-card"><div><strong>${symbol}</strong><b>${same&&finite(value.latest_valid_price)?`$${fmt(value.latest_valid_price)}`:"—"}</b></div><span class="${direction===1?"positive":direction===-1?"negative":"muted"}">${direction===1?"↑ BULLISH":direction===-1?"↓ BEARISH":"Unavailable"}</span><small>${esc(vwap)} · PB ${fib?.status==="CURRENT"&&!stale&&finite(fib.pullback_pct_raw)?`${fmt(fib.pullback_pct_raw,0)}%`:"—"}${stale?" · STALE PRICE":""}</small></article>`;}).join("");
  const pulse=Object.entries(data.groups).map(([name,items])=>`<article class="panel focus-pulse-card"><strong>${items.length}</strong><span>${name}</span><small>${items.filter(data.highQuality).length} High Quality</small></article>`).join("");
  const best=data.best.length?`<div class="focus-table-wrap"><table class="focus-table"><thead><tr><th>Symbol</th><th>Direction</th><th>Confirm Eff</th><th>Current Eff</th><th>5m Pullback</th><th>Options</th><th>State</th></tr></thead><tbody>${data.best.map(row=>`<tr><td><strong>${esc(row.symbol)}</strong></td><td>${esc(row.direction)}</td><td>${fmt(row.efficiency_at_confirmation)}</td><td>${fmt(row.current_efficiency)}</td><td>${esc(fibSummary(row))}</td><td>${esc(row.option_quality)}</td><td>${esc(row.tracker_state)}</td></tr>`).join("")}</tbody></table></div>`:`<p class="empty">No setups meet the High Quality view right now.</p>`;
  return `<div class="focus-header"><div><span class="eyebrow">FOCUS DASHBOARD</span><h2>${greeting}</h2></div><small>Updated ${model.as_of?new Date(model.as_of).toLocaleTimeString("en-US",{timeZone:"America/Chicago",hour:"numeric",minute:"2-digit"}):"—"} CT</small></div>
    <section class="focus-section"><h2>Market State</h2><div class="focus-grid">${markets}</div></section>
    <section class="focus-section"><h2>Opportunity Pulse</h2><div class="focus-grid">${pulse}</div></section>
    <section class="panel focus-section"><div class="panel-title"><h2>Best Setups Right Now</h2><a href="${routeHref("tracking",demo)}" data-action="high-quality-view">View all opportunities →</a></div>${best}</section>
    <section class="panel focus-section"><h2>Needs Attention</h2>${data.attention.length?`<div class="focus-attention">${data.attention.map(({row,reason})=>`<div><strong>${esc(row.symbol)}</strong><span>${esc(reason)}</span><small>${esc(row.direction)} · ${fmt(row.current_efficiency)}</small></div>`).join("")}</div>`:`<p class="empty">Nothing currently needs attention.</p>`}</section>
    <section class="panel focus-section"><div class="panel-title"><h2>Market News</h2><a href="${routeHref("news",demo)}">All news →</a></div><div class="focus-news">${data.news.map(item=>{const url=safeUrl(item.url);return `<article><span class="badge blue">${esc(item.category||item.scope||"MARKET")}</span><div>${url?`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(item.headline)}</a>`:`<strong>${esc(item.headline)}</strong>`}<small>${esc(item.source||"Unknown source")} · ${dateTime(item.first_seen_at)} · ${esc((item.symbols||[]).join(" · "))}</small></div></article>`;}).join("")||`<p class="empty">No stored current headlines.</p>`}</div></section>`;
}

function filterControls(model,ui){
  const f=ui.filters;const sectors=[...new Set((model.opportunities||[]).map(row=>row.sector).filter(Boolean))].sort();
  const industries=availableIndustries(model.opportunities,f.sector);const sensors=[...new Set((model.opportunities||[]).flatMap(row=>(row.finviz_sensors||[]).map(value=>value.sensor)).filter(Boolean))].sort();
  const trackerStates=["TRACKING","WEAKENING","RECOVERING","INVALIDATION_PENDING","INVALIDATED","SESSION_EXPIRED"];
  return `<form id="radarFilters" class="filter-panel panel"><div class="filter-main">
    <label>Search<input name="query" value="${esc(f.query)}" placeholder="Ticker or company"></label>
    <label>Asset<select name="asset"><option value="ALL">All admitted</option><option value="STOCK"${selected(f.asset,"STOCK")}>Stocks</option><option value="ETF"${selected(f.asset,"ETF")}>ETFs only</option></select></label>
    <label>Efficiency<select name="efficiency"><option value="ALL">All</option>${[.70,.60,.50,.40,.35].map(value=>`<option value="${value}"${selected(f.efficiency,String(value))}>≥ ${value.toFixed(2)}</option>`).join("")}</select></label>
    <label>Option quality<select name="optionQuality">${["ALL","EXCELLENT","GOOD+","FAIR+","THIN+","POOR","UNAVAILABLE","QUEUED","CAPACITY_DEFERRED","RETRY_PENDING","ERROR_RETRYABLE"].map(value=>`<option value="${value}"${selected(f.optionQuality,value)}>${esc(value)}</option>`).join("")}</select></label>
    <label>Tracker<select name="tracker"><option value="ALL">All tracker states</option>${trackerStates.map(value=>`<option value="${value}"${selected(f.tracker,value)}>${esc(value.replaceAll("_"," "))}</option>`).join("")}</select></label>
    <label>Sector<select name="sector"><option value="ALL">All sectors</option>${sectors.map(value=>`<option${selected(f.sector,value)}>${esc(value)}</option>`).join("")}</select></label>
    <label>Industry<select name="industry"><option value="ALL">All industries</option>${industries.map(value=>`<option${selected(f.industry,value)}>${esc(value)}</option>`).join("")}</select></label>
    <label>Catalyst<select name="catalyst"><option value="ALL">All news states</option><option value="FRESH"${selected(f.catalyst,"FRESH")}>Fresh catalyst</option><option value="ANY"${selected(f.catalyst,"ANY")}>Has news</option><option value="NONE"${selected(f.catalyst,"NONE")}>No news</option></select></label>
    <label>Sensor<select name="sensor"><option value="ALL">All sensors</option>${sensors.map(value=>`<option${selected(f.sensor,value)} value="${esc(value)}">${esc(value.replaceAll("TREND_","").replaceAll("_"," "))}</option>`).join("")}</select></label>
    <label>Sort<select name="sort">${Object.entries(SORTS).map(([value,label])=>`<option value="${value}"${selected(f.sort,value)}>${esc(label)}</option>`).join("")}</select></label>
  </div><div class="filter-toggles"><fieldset><legend>Direction</legend><label><input type="checkbox" name="direction" value="LONG"${checked(f.directions,"LONG")}>Long</label><label><input type="checkbox" name="direction" value="SHORT"${checked(f.directions,"SHORT")}>Short</label></fieldset><fieldset><legend>State</legend>${STATES.map(value=>`<label><input type="checkbox" name="state" value="${value}"${checked(f.states,value)}>${esc(value.replaceAll("_"," "))}</label>`).join("")}</fieldset><label><input type="checkbox" name="includeETFs"${f.includeETFs?" checked":""}>Include ETFs</label><label><input type="checkbox" name="watchlistOnly"${f.watchlistOnly?" checked":""}>Watchlist only</label><label><input type="checkbox" name="freshOnly"${f.freshOnly?" checked":""}>Fresh data only</label><button type="button" class="quiet-button" data-action="clear-filters">Clear all</button></div></form>`;
}

function opportunities(model,ui){const universe=discoveryRows(model);const filtered=filterOpportunities(universe,ui.filters,ui.watchlist);const pages=paginate(filtered,ui.filters.page,ui.filters.pageSize);return `${filterControls(model,ui)}${capacityWarnings(model)}<section class="panel"><div class="panel-title"><div><span class="eyebrow">USER-CONTROLLED ORDERING</span><h2>Opportunity Radar</h2></div><span>${pages.total} of ${universe.length} visible · rank ≠ entry signal</span></div>${radarTable(pages.rows,{watchlist:ui.watchlist})}<div class="pagination"><button data-action="page" data-page="${pages.page-1}"${pages.page<=1?" disabled":""}>← Previous</button><span>Page ${pages.page} / ${pages.pages}</span><button data-action="page" data-page="${pages.page+1}"${pages.page>=pages.pages?" disabled":""}>Next →</button></div></section>`;}

function trackerFilters(rows,ui){
  const f={...defaultTrackerFilters(),...(ui.trackerFilters||{})};
  const editor=ui.trackerEditor,field=TRACKER_FIELDS[editor?.field||"direction"];
  const values=editor?.field==="sector"?[...new Set(rows.map(row=>row.sector).filter(Boolean))].sort():editor?.field==="industry"?[...new Set(rows.map(row=>row.industry).filter(Boolean))].sort():field?.values||[];
  const operators=field?.numeric?[">",">=","<","<=","=","between"]:field?.boolean?["is"]:["is","is not","is one of",...(field?.ordered?[">=","<="]:[])];
  const editorHtml=editor?`<form id="trackingRuleEditor" class="tracker-rule-editor"><label>Field<select name="field">${Object.entries(TRACKER_FIELDS).map(([key,value])=>`<option value="${key}"${selected(editor.field,key)}>${esc(value.label)}</option>`).join("")}</select></label><label>Operator<select name="operator">${operators.map(value=>`<option value="${esc(value)}"${selected(editor.operator,value)}>${esc(value)}</option>`).join("")}</select></label>${field?.boolean?`<label>Value<select name="value"><option value="true"${selected(editor.value,true)}>Yes</option><option value="false"${selected(editor.value,false)}>No</option></select></label>`:field?.numeric?`<label>Value<input name="value" type="number" step="any" required value="${esc(editor.value??"")}"></label>${editor.operator==="between"?`<label>To<input name="value2" type="number" step="any" required value="${esc(editor.value2??"")}"></label>`:""}`:editor.operator==="is one of"?`<label>Values (comma-separated)<input name="value" required value="${esc(editor.value??"")}"></label>`:`<label>Value<select name="value">${values.map(value=>`<option value="${esc(value)}"${selected(editor.value,value)}>${esc(value.replaceAll("_"," "))}</option>`).join("")}</select></label>`}<button type="submit">Apply</button><button type="button" class="quiet-button" data-action="cancel-tracker-rule">Cancel</button></form>`:"";
  const chip=rule=>`${esc(TRACKER_FIELDS[rule.field]?.label||rule.field)} ${esc(rule.operator)} ${esc(String(rule.value).replaceAll("_"," "))}${rule.operator==="between"?`–${esc(rule.value2)}`:""}`;
  const presets=ui.trackerPresets||[];
  const presetEditor=ui.trackerPresetEditor;
  const presetHtml=presetEditor?`<form id="trackingPresetEditor" class="tracker-rule-editor"><label>View name<input name="name" maxlength="80" required value="${esc(presetEditor.name||"")}" placeholder="Name this Tracking view"></label><button type="submit">${presetEditor.mode==="delete"?"Delete View":presetEditor.mode==="update"?"Update View":"Save View"}</button><button type="button" class="quiet-button" data-action="cancel-tracking-view">Cancel</button>${ui.trackerPresetError?`<span role="alert">${esc(ui.trackerPresetError)}</span>`:""}</form>`:"";
  return `<div id="trackingFilters" class="panel tracking-controls" data-revision="${ui.trackerFormRevision||0}"><div class="tracking-toolbar"><label>View<select name="view"><option value="builtin:high-quality"${selected(ui.selectedTrackingView,"builtin:high-quality")}>High Quality</option><option value="custom"${selected(ui.selectedTrackingView,"custom")}>Custom / unsaved</option>${presets.map(p=>`<option value="${esc(p.id)}"${selected(ui.selectedTrackingView,p.id)}>${esc(p.name)}${p.is_default?" · Default":""}${ui.trackerViewDirty&&p.id===ui.selectedTrackingView?" · Modified":""}</option>`).join("")}</select></label><label>Search<input name="query" value="${esc(f.query)}" placeholder="Ticker / company"></label><button type="button" data-action="add-tracker-rule">+ Filter</button><label>Sort<select name="sort"><option value="default"${selected(f.sort,"default")}>Section default</option>${Object.entries(TRACKER_SORTS).map(([value,label])=>`<option value="${esc(value)}"${selected(f.sort,value)}>${esc(label)}</option>`).join("")}</select></label><button type="button" data-action="save-tracking-view"${ui.demo?" disabled":""}>Save View</button>${presets.some(p=>p.id===ui.selectedTrackingView)?`<button type="button" data-action="update-tracking-view">Update</button><button type="button" data-action="set-default-tracking-view">Set Default</button><button type="button" data-action="delete-tracking-view">Delete</button>`:""}</div><div class="tracking-chips">${(f.rules||[]).map((rule,index)=>`<span class="tracker-chip"><button type="button" data-action="edit-tracker-rule" data-index="${index}">${chip(rule)}</button><button type="button" data-action="remove-tracker-rule" data-index="${index}" aria-label="Remove ${esc(TRACKER_FIELDS[rule.field]?.label||rule.field)}">×</button></span>`).join("")}</div>${editorHtml}${presetHtml}<div class="tracking-footer"><span class="tracking-match-count">${ui.trackingFilteredRows?.length??0} matching / ${rows.length} tracked</span><div class="tracking-export-actions"><button type="button" class="quiet-button" data-action="export-tradingview">Export TradingView .txt</button><button type="button" class="quiet-button" data-action="copy-tradingview">Copy TradingView Symbols</button><button type="button" class="quiet-button" data-action="clear-tracking-filters">Clear</button></div></div><small id="tradingViewExportFeedback" class="tracking-export-feedback" role="status" aria-live="polite">${esc(ui.tradingViewExportFeedback||"")}</small></div>`;
}

export function aiFreshness(analysis,now){
  if(!analysis)return "UNAVAILABLE";
  const at=Date.parse(analysis.source_as_of||analysis.generated_at||"");
  const age=(now-at)/60000;
  return !Number.isFinite(age)||age<0?"UNAVAILABLE":age<5?"FRESH":age<15?"AGING":"STALE";
}

function aiAnalysis(row,now,state){
  if(state==="UNAVAILABLE")return `<p class="muted">AI analysis storage unavailable; tracker remains available.</p>`;
  const analysis=row.ai_analysis;
  if(!analysis)return `<p class="muted">No AI analysis requested yet.</p>`;
  const line=(label,value)=>value?`<dt>${label}</dt><dd>${esc(value)}</dd>`:"";
  return `<div class="tracker-ai-analysis"><p>${badge(aiFreshness(analysis,now),"muted")} · Generated ${dateTime(analysis.generated_at)} · Source ${dateTime(analysis.source_as_of)}</p><dl>${line("Summary",analysis.analysis_summary)}${line("Structure",analysis.structure_read)}${line("Levels",analysis.levels_read)}${line("Options",analysis.options_read)}${line("Risks",analysis.risks)}${line("Watch for",analysis.watch_for)}</dl>${analysis.analysis_markdown?`<details><summary>Full Analysis</summary><pre>${esc(analysis.analysis_markdown)}</pre></details>`:""}</div>`;
}

const FIB_LABELS={EXTENSION:"Extension","0_TO_50":"<50%","50_TO_61_8":"50–61.8%",
  "61_8_TO_78_6":"61.8–78.6%","78_6_TO_88_6":"78.6–88.6%",
  "88_6_TO_TRAIL":"88.6%–Trail",BEYOND_TRAIL:"Beyond Trail"};
function fibSummary(row){
  const fib=row.atr_fib;
  if(fib?.status!=="CURRENT"||!finite(fib.pullback_pct_raw))return "Unavailable";
  return `${TRACKER_TERMINAL.has(row.tracker_state)?"Last ":""}${fmt(fib.pullback_pct_raw,0)}% · ${FIB_LABELS[fib.zone]||"Unavailable"}`;
}
function fibDetail(row){
  const fib=row.atr_fib;
  if(fib?.status!=="CURRENT")return `<p class="muted">Unavailable${fib?.reason?` · ${esc(fib.reason)}`:""}</p>`;
  return `<dl><dt>Direction</dt><dd>${fib.direction===1?"Bullish":fib.direction===-1?"Bearish":"Unavailable"}</dd><dt>Trend Extreme</dt><dd>${fmt(fib.trend_extreme)}</dd><dt>ATR Trail</dt><dd>${fmt(fib.atr_trail)}</dd><dt>ATR Pullback</dt><dd>${fmt(fib.pullback_pct_raw,1)}%</dd><dt>Fib 50</dt><dd>${fmt(fib.fib_50)}</dd><dt>Fib 61.8</dt><dd>${fmt(fib.fib_618)}</dd><dt>Fib 78.6</dt><dd>${fmt(fib.fib_786)}</dd><dt>Fib 88.6</dt><dd>${fmt(fib.fib_886)}</dd><dt>Current Zone</dt><dd>${esc(FIB_LABELS[fib.zone]||"Unavailable")}</dd><dt>Structure As Of</dt><dd>${dateTime(fib.structure_as_of)}</dd><dt>Price As Of</dt><dd>${dateTime(fib.price_as_of)}</dd></dl>`;
}

function trackedTable(rows,now,aiState){
  if(!rows.length)return `<p class="empty">No lifecycles match these filters.</p>`;
  return `<div class="tracked-table-wrap"><table class="tracked-table"><thead><tr><th>Symbol</th><th>Direction</th><th>Tracker / Structure</th><th>V1 / ATR</th><th>Eff @ Confirm</th><th>Current Eff</th><th>5m ATR Pullback</th><th>Options</th><th>Confirmed / Aligned</th><th>Sector / Industry</th><th>Data</th><th>Evidence</th></tr></thead><tbody>${rows.map(row=>{
    const terminal=TRACKER_TERMINAL.has(row.tracker_state);
    const structure=row.alignment==="UNKNOWN"?"ATR UNKNOWN · AWAITING 5M DATA":row.alignment||"LEGACY · STRUCTURE UNKNOWN";
    const movement=row.movement_quality||"UNAVAILABLE";
    return `<tr data-tracker-id="${esc(row.id)}" class="${terminal?"tracked-terminal":""}"><td><strong>${esc(row.symbol)}</strong><small>${esc(row.company_name)}</small></td>
      <td>${badge(row.direction,row.direction==="LONG"?"positive direction-long":"negative direction-short")}</td>
      <td>${badge(row.tracker_state,terminal?"negative":"blue")}<small>ID ${esc(row.id.slice(0,12))} · ${esc(structure)}</small>${row.first_alignment_at&&row.initial_alignment==="COUNTERTREND"?`<small>CT → ALIGNED</small>`:""}${terminal?`<small>${dateTime(row.invalidated_at||row.expired_at)} · ${esc(row.invalidation_reason||row.expiry_reason||"Session expired")}</small>`:""}</td>
      <td><strong>${esc(row.v1_state)}</strong><small>5m ${row.atr_m5_direction===1?"BULLISH":row.atr_m5_direction===-1?"BEARISH":"UNKNOWN"}</small><small>1m ${esc(row.atr_m1_warning||"UNAVAILABLE")}</small></td>
      <td><strong>${fmt(row.efficiency_at_confirmation,2)}</strong></td>
      <td><strong>${fmt(row.current_efficiency,2)}</strong><small>ATR $${fmt(row.atr_dollars)} · ${pct(row.atr_percent)}</small><small>${esc(movement)}</small></td>
      <td><strong>${esc(fibSummary(row))}</strong></td>
      <td>${badge(row.option_quality,`option-${String(row.option_quality||"unavailable").toLowerCase()}`)}<small>${terminal?"Last retained context":row.option_quality_current?"Current read-only enrichment":row.option_quality!=="UNAVAILABLE"?"Last observed · not current":"Unavailable"}</small></td>
      <td>${dateTime(row.first_confirmed_at)}<small>Aligned ${dateTime(row.first_alignment_at)}</small></td>
      <td>${esc(row.sector||"Unknown")}<small>${esc(row.industry||"Unknown")}</small></td>
      <td>${badge(row.data_status||"UNAVAILABLE",String(row.data_status||"unavailable").toLowerCase())}</td>
      <td><details><summary>View</summary><dl><dt>Tracker ID</dt><dd>${esc(row.id)}</dd><dt>Efficiency @ Confirmation</dt><dd>${fmt(row.efficiency_at_confirmation,2)}</dd><dt>Current Efficiency</dt><dd>${fmt(row.current_efficiency,2)}</dd><dt>Confirmed price</dt><dd>${esc(row.confirmed_price||"—")}</dd><dt>5m trail</dt><dd>${fmt(row.atr_m5_trail==null?null:Number(row.atr_m5_trail))}</dd><dt>5m bar</dt><dd>${dateTime(row.last_m5_bar_end)}</dd><dt>Invalidated</dt><dd>${dateTime(row.invalidated_at)}</dd><dt>Reason</dt><dd>${esc(row.invalidation_reason||"—")}</dd><dt>Data status</dt><dd>${esc(row.data_status||"—")}</dd></dl><h4>5m ATR Structure</h4>${fibDetail(row)}<h4>AI Analysis</h4>${aiAnalysis(row,now,aiState)}</details></td></tr>`;
  }).join("")}</tbody></table></div>`;
}

const BENCHMARK_SYMBOLS=["SPY","QQQ","IWM"];
const benchmarkAge=(at,now)=>{const age=now-Date.parse(at||"");return Number.isFinite(age)&&age>=0?Math.floor(age/1000):null;};
const benchmarkFreshness=age=>age==null?"UNAVAILABLE":age<=120?"NORMAL":age<=300?"AGED":"STALE";
const benchmarkAgeLabel=age=>age==null?"No quote observed":age<60?`Updated ${age}s ago`:age<3600?`Updated ${Math.floor(age/60)}m ago`:`Updated ${Math.floor(age/3600)}h ago`;
function benchmarkSection(model,now){
  const bySymbol=new Map((model.market_benchmarks||[]).map(row=>[row.symbol,row]));
  const rows=BENCHMARK_SYMBOLS.map(symbol=>{
    const stored=bySymbol.get(symbol);
    const row=stored?.payload||{};
    const sameSession=stored?.session_date===model.market_session?.date;
    const price=sameSession&&finite(row.latest_valid_price)?row.latest_valid_price:null;
    const age=sameSession?benchmarkAge(row.latest_price_as_of,now):null;
    const freshness=benchmarkFreshness(age);
    const direction=sameSession?row.atr_5m_direction:null;
    const fib=sameSession?row.atr_5m_fib:null;
    const fibValue=finite(fib?.pullback_pct_raw)?`${fmt(fib.pullback_pct_raw,0)}% · ${FIB_LABELS[fib.zone]||"Unavailable"}`:"Unavailable";
    const fibStatus=fib?.status==="CURRENT"&&freshness==="STALE"?"STALE_PRICE":fib?.status||"UNAVAILABLE";
    const vwapPosition=sameSession?row.vwap_position||"UNAVAILABLE":"UNAVAILABLE";
    const news=sameSession?row.market_news:null;
    const newsUrl=safeUrl(news?.url);
    const headline=esc(news?.headline||"No recent market news");
    const detail=`<details class="benchmark-evidence"><summary>Evidence</summary><dl><dt>Source</dt><dd>${esc(sameSession?row.source||"UNAVAILABLE":"UNAVAILABLE")}</dd><dt>Last quote</dt><dd>${dateTime(sameSession?row.latest_price_as_of:null)} · ${esc(benchmarkAgeLabel(age))} · ${esc(freshness)}</dd><dt>5m ATR as of</dt><dd>${dateTime(sameSession?row.atr_5m_structure_as_of:null)} · ${esc(row.atr_5m_structure_status||"UNAVAILABLE")}</dd><dt>ATR trail</dt><dd>${fmt(sameSession?row.atr_5m_trail:null)}</dd><dt>Fib status</dt><dd>${esc(fibStatus)}</dd><dt>Fib extreme / 50 / 61.8 / 78.6 / 88.6</dt><dd>${[fib?.trend_extreme,fib?.fib_50,fib?.fib_618,fib?.fib_786,fib?.fib_886].map(value=>fmt(value)).join(" / ")}</dd><dt>1m efficiency as of</dt><dd>${dateTime(sameSession?row.efficiency_1m_as_of:null)}</dd><dt>5m efficiency as of</dt><dd>${dateTime(sameSession?row.efficiency_5m_as_of:null)}</dd><dt>RTH VWAP / as of</dt><dd>${fmt(sameSession?row.session_vwap:null)} · ${dateTime(sameSession?row.vwap_as_of:null)}</dd><dt>News first observed</dt><dd>${dateTime(news?.first_seen_at)}</dd><dt>News published</dt><dd>${dateTime(news?.publication_at)}</dd></dl></details>`;
    return `<tr data-benchmark-symbol="${symbol}"><td><strong>${symbol}</strong>${detail}</td><td><strong>${fmt(price)}</strong><small>${esc(freshness)} · ${esc(benchmarkAgeLabel(age))}</small></td><td>${direction===1?badge("BULLISH","positive direction-long"):direction===-1?badge("BEARISH","negative direction-short"):badge("UNAVAILABLE","unavailable")}</td><td><strong>${esc(fibValue)}</strong>${fibStatus!=="CURRENT"?`<small>${esc(fibStatus.replaceAll("_"," "))}</small>`:""}</td><td><span class="${vwapPosition==="ABOVE"?"positive":vwapPosition==="BELOW"?"negative":""}">${esc(vwapPosition)}</span></td><td>${fmt(sameSession?row.efficiency_1m:null)}</td><td>${fmt(sameSession?row.efficiency_5m:null)}</td><td class="benchmark-news">${newsUrl?`<a href="${esc(newsUrl)}" target="_blank" rel="noopener noreferrer" title="${headline}">${headline}</a>`:`<span title="${headline}">${headline}</span>`}<small>${news?dateTime(news.first_seen_at):""}</small></td></tr>`;
  }).join("");
  return `<section id="marketBenchmarks" class="panel benchmark-section"><div class="panel-title"><div><span class="eyebrow">PERMANENT · DESCRIPTIVE MARKET CONTEXT</span><h2>MARKET BENCHMARKS</h2></div><span>SPY · QQQ · IWM</span></div><div class="tracked-table-wrap"><table class="tracked-table benchmark-table"><thead><tr><th>Symbol</th><th>Price</th><th>Direction</th><th>5m ATR Pullback</th><th>VWAP Position</th><th>Current 1m Efficiency</th><th>Current 5m Efficiency</th><th>Market News</th></tr></thead><tbody>${rows}</tbody></table></div><small>ATR-based market context only · not a tracker, signal, or entry condition.</small></section>`;
}

function tracking(model,ui,now=Date.now()){
  const all=hydrateTrackerRows(model,now),f={...defaultTrackerFilters(),...(ui.trackerFilters||{})};
  const filtered=filterTracked(all.filter(row=>!TRACKER_TERMINAL.has(row.tracker_state)),f);
  const aligned=filtered.filter(row=>row.alignment==="ALIGNED");
  const pending=filtered.filter(row=>row.alignment!=="ALIGNED");
  ui.trackingFilteredRows=[...aligned,...pending];
  const invalidated=all.filter(row=>row.tracker_state==="INVALIDATED").sort((a,b)=>
    (Date.parse(b.invalidated_at||"")||0)-(Date.parse(a.invalidated_at||"")||0)||a.id.localeCompare(b.id));
  const expired=all.filter(row=>row.tracker_state==="SESSION_EXPIRED");
  const section=(title,rows,total)=>`<section class="panel tracked-section"><div class="panel-title"><div><span class="eyebrow">DURABLE LIFECYCLES · READ ONLY</span><h2>${title}</h2></div><span>${rows.filter(row=>!TRACKER_TERMINAL.has(row.tracker_state)).length} active · ${total} session total</span></div>${trackedTable(rows,now,model.ai_analysis_state)}</section>`;
  const notice=model.tracker_history_state&&model.tracker_history_state!=="READY"?`<div class="capacity-warning"><strong>Tracker history ${esc(model.tracker_history_state)}</strong><span>Historical rows may be incomplete; no provider request was made.</span></div>`:"";
  return `${benchmarkSection(model,now)}${trackerFilters(all,ui)}${notice}${section("ALIGNED",aligned,all.filter(row=>!TRACKER_TERMINAL.has(row.tracker_state)&&row.alignment==="ALIGNED").length)}${section("COUNTERTREND / AWAITING ALIGNMENT",pending,all.filter(row=>!TRACKER_TERMINAL.has(row.tracker_state)&&row.alignment!=="ALIGNED").length)}<section class="panel tracked-section"><div class="panel-title"><div><span class="eyebrow">RETAINED LIFECYCLES · READ ONLY</span><h2>INVALIDATED</h2></div><span>${invalidated.length} invalidated · independent of active filters</span></div>${trackedTable(invalidated,now,model.ai_analysis_state)}${expired.length?`<details class="session-expired-history"><summary>Session-expired history (${expired.length}) · not invalidation</summary>${trackedTable(expired,now,model.ai_analysis_state)}</details>`:""}</section>`;
}

function market(model){const sections=[["BROAD INDEXES",["SPY","QQQ","IWM"]],["VOLATILITY",["VIX"]],["RATES",["US2Y","US10Y"]],["DOLLAR",["DXY"]],["COMMODITIES",["WTI"]]];return `<div class="market-sections">${sections.map(([title,symbols])=>`<section class="panel"><span class="eyebrow">${title}</span><div class="metric-cards">${symbols.map(symbol=>{const row=model.market.find(value=>(value.key||value.symbol)===symbol)||{};return `<article><div><strong>${esc(row.key||row.symbol||symbol)}</strong><small>${esc(row.label||symbol)}</small></div><b>${fmt(row.value)}</b><span class="${tone(marketChange(row))}">${pct(marketChange(row))}</span>${macroStatus(row)}<small>${esc(row.source||"UNAVAILABLE")}${row.source_symbol?` · ${esc(row.source_symbol)}`:""}</small></article>`;}).join("")}</div></section>`).join("")}</div><div class="two-column">${groupPanel("Leading sectors","DERIVED RADAR CONTEXT",model.sectors||[],"sectors",model)}${groupPanel("Leading industries","DERIVED RADAR CONTEXT",model.industries||[],"sectors",model)}</div>${marketNewsPanel(model)}`;}

function groupTable(rows,type){if(!rows.length)return `<p class="empty">No ${esc(type)} data available.</p>`;return `<table class="group-table"><thead><tr><th>${esc(type)}</th><th>1D</th><th>5m</th><th>Breadth</th><th>Radar</th><th>Leaders</th><th>Laggards</th></tr></thead><tbody>${rows.map(row=>`<tr><td><button data-action="group" data-group-type="${type.toLowerCase()}" data-group="${esc(row.name)}">${esc(row.name)}</button><small>${esc(row.source)}</small></td><td class="${tone(row.performance_1d_pct)}">${pct(row.performance_1d_pct)}</td><td class="${tone(row.performance_5m_pct)}">${pct(row.performance_5m_pct)}</td><td>${finite(row.breadth)?pct(row.breadth*100):"—"}</td><td>${row.radar_member_count}</td><td>${esc((row.leaders||[]).join(" · "))}</td><td>${esc((row.laggards||[]).join(" · "))}</td></tr>`).join("")}</tbody></table>`;}
function sectors(model,ui){const chosen=ui.groupSelection;const peers=chosen?(model.opportunities||[]).filter(row=>row.sector===chosen.name||row.industry===chosen.name):[];return `<div class="two-column sector-columns"><section class="panel"><div class="panel-title"><div><span class="eyebrow">CURRENT RADAR PEER UNIVERSE</span><h2>Sectors</h2></div><span>Descriptive only</span></div>${groupTable(model.sectors||[],"Sector")}</section><section class="panel"><div class="panel-title"><div><span class="eyebrow">FINVIZ CLASSIFICATION</span><h2>Industries</h2></div><span>Click to inspect</span></div>${groupTable(model.industries||[],"Industry")}</section></div>${chosen?`<section class="panel"><div class="panel-title"><div><span class="eyebrow">SELECTED ${esc(chosen.type.toUpperCase())}</span><h2>${esc(chosen.name)}</h2></div><button data-action="clear-group" class="quiet-button">Close</button></div>${radarTable(peers,{watchlist:ui.watchlist})}</section>`:""}`;}

function newsFilters(model,ui){const f=ui.newsFilters;const sectors=[...new Set((model.news||[]).flatMap(row=>row.sector||[]))].sort();const categories=[...new Set((model.news||[]).map(row=>row.category).filter(Boolean))].sort();return `<form id="newsFilters" class="filter-panel panel"><div class="filter-main"><label>Scope<select name="scope"><option value="ALL">All scopes</option>${["COMPANY","INDUSTRY","SECTOR","MARKET","MULTI_COMPANY"].map(value=>`<option${selected(f.scope,value)}>${value}</option>`).join("")}</select></label><label>Category<select name="category"><option value="ALL">All categories</option>${categories.map(value=>`<option${selected(f.category,value)}>${esc(value)}</option>`).join("")}</select></label><label>Symbol<input name="symbol" value="${esc(f.symbol)}" placeholder="AMD"></label><label>Sector<select name="sector"><option value="ALL">All sectors</option>${sectors.map(value=>`<option${selected(f.sector,value)}>${esc(value)}</option>`).join("")}</select></label><label>Time range<select name="range"><option value="ALL">All retained</option><option value="1"${selected(f.range,"1")}>Past hour</option><option value="4"${selected(f.range,"4")}>Past 4 hours</option><option value="24"${selected(f.range,"24")}>Past day</option></select></label><label>Sort<select name="sort"><option value="firstSeen"${selected(f.sort,"firstSeen")}>Newest first observed</option><option value="published"${selected(f.sort,"published")}>Newest published</option></select></label></div></form>`;}
function news(model,ui){const rows=filterNews(model.news,ui.newsFilters);return `${newsFilters(model,ui)}<section class="panel"><div class="panel-title"><div><span class="eyebrow">CAUSAL ORDER: FIRST OBSERVED</span><h2>News &amp; Catalysts</h2></div><span>${rows.length} headlines</span></div><table class="news-table"><thead><tr><th>First seen</th><th>Published</th><th>Headline</th><th>Source</th><th>Scope</th><th>Category</th><th>Symbols</th><th>Sector</th><th>Industry</th></tr></thead><tbody>${rows.map(item=>{const url=safeUrl(item.url);return `<tr><td>${dateTime(item.first_seen_at)}</td><td>${dateTime(item.publication_at)}</td><td>${url?`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(item.headline)}</a>`:esc(item.headline)}</td><td>${esc(item.source||"—")}</td><td>${badge(item.scope)}</td><td>${esc(item.category)}</td><td>${esc((item.symbols||[]).join(" · ")||"—")}</td><td>${esc((item.sector||[]).join(" · ")||"—")}</td><td>${esc((item.industry||[]).join(" · ")||"—")}</td></tr>`;}).join("")||`<tr><td colspan="9" class="empty">No headlines match the current filters.</td></tr>`}</tbody></table></section>`;}

function watchlist(model,ui){const rows=(model.opportunities||[]).filter(row=>ui.watchlist.has(row.symbol));return `<section class="panel watchlist-head"><div><span class="eyebrow">PRIVATE OWNER WATCHLIST</span><h2>${rows.length} pinned symbol${rows.length===1?"":"s"}</h2><p>Pinning never evicts an active V1 lifecycle commitment.</p></div><form id="watchlistAdd"><label>Add current radar symbol<select name="symbol"><option value="">Choose symbol</option>${model.opportunities.filter(row=>!ui.watchlist.has(row.symbol)).map(row=>`<option>${esc(row.symbol)}</option>`).join("")}</select></label><button>Add</button></form></section>${!model.watchlist_capacity?.monitoring_enabled?`<div class="capacity-warning"><strong>Monitoring capacity notice</strong><span>${esc(model.watchlist_capacity?.message||"A separate bounded provider lane is not enabled.")}</span></div>`:""}<section class="panel">${rows.length?radarTable(rows,{watchlist:ui.watchlist}):`<div class="empty-state"><strong>Your watchlist is empty.</strong><p>Add a symbol from the Opportunity Radar or use the control above.</p></div>`}</section>`;}

const TITLES={home:["LIVE OPPORTUNITY WORKSTATION","Home"],opportunities:["FULL FILTERED UNIVERSE","Opportunity Radar"],tracking:["DURABLE CONFIRMED LIFECYCLES","Tracked Opportunities"],"options-analysis":["0DTE · DESCRIPTIVE ONLY","Options Analysis"],market:["BROAD CONTEXT · DESCRIPTIVE ONLY","Market Dashboard"],sectors:["PEER CONTEXT · NO ALIGNMENT GATE","Sectors & Industries"],news:["HEADLINE-ONLY EVIDENCE","News & Catalysts"],watchlist:["PRIVATE · OWNER ONLY","Watchlist"]};

// A live field can change every refresh. Keep the filter form and surviving
// tracker rows mounted so a redraw does not blank the list or close evidence.
function reconcileTracking(pageNode,html){
  const incoming=pageNode.ownerDocument.createElement("div");incoming.innerHTML=html;
  const oldBench=pageNode.querySelector("#marketBenchmarks"),newBench=incoming.querySelector("#marketBenchmarks");
  if(oldBench&&newBench&&oldBench.innerHTML!==newBench.innerHTML){
    const open=new Set([...oldBench.querySelectorAll("tr[data-benchmark-symbol]")].filter(row=>row.querySelector("details")?.open).map(row=>row.dataset.benchmarkSymbol));
    oldBench.innerHTML=newBench.innerHTML;
    for(const row of oldBench.querySelectorAll("tr[data-benchmark-symbol]"))if(open.has(row.dataset.benchmarkSymbol))row.querySelector("details").open=true;
  }
  let oldForm=pageNode.querySelector("#trackingFilters");const newForm=incoming.querySelector("#trackingFilters");
  const oldSections=[...pageNode.querySelectorAll(".tracked-section")];
  const newSections=[...incoming.querySelectorAll(".tracked-section")];
  if(!oldForm||!newForm||oldSections.length!==3||newSections.length!==3){pageNode.innerHTML=html;return;}
  if(oldForm.dataset.revision!==newForm.dataset.revision){oldForm.replaceWith(newForm);oldForm=newForm;}
  const oldCount=oldForm.querySelector(".tracking-match-count"),newCount=newForm.querySelector(".tracking-match-count");
  if(oldCount&&newCount&&oldCount.textContent!==newCount.textContent)oldCount.textContent=newCount.textContent;
  for(const action of ["export-tradingview","copy-tradingview"]){
    const current=oldForm.querySelector(`[data-action="${action}"]`),next=newForm.querySelector(`[data-action="${action}"]`);
    if(current&&next)current.disabled=next.disabled;
  }
  for(const next of newForm.querySelectorAll("[name]")){
    const current=[...oldForm.querySelectorAll("[name]")].find(node=>node.name===next.name);
    if(!current)continue;
    if(current.tagName==="SELECT"&&current.innerHTML!==next.innerHTML)current.innerHTML=next.innerHTML;
    if(current.type==="checkbox")current.checked=next.checked;
    else if(current.value!==next.value)current.value=next.value;
  }
  const oldNotice=pageNode.querySelector(".capacity-warning"),newNotice=incoming.querySelector(".capacity-warning");
  if(oldNotice&&!newNotice)oldNotice.remove();
  else if(!oldNotice&&newNotice)oldForm.after(newNotice);
  else if(oldNotice&&newNotice&&oldNotice.innerHTML!==newNotice.innerHTML)oldNotice.innerHTML=newNotice.innerHTML;
  for(let i=0;i<oldSections.length;i++){
    const section=oldSections[i],nextSection=newSections[i];
    const header=section.querySelector(".panel-title"),nextHeader=nextSection.querySelector(".panel-title");
    if(header.innerHTML!==nextHeader.innerHTML)header.innerHTML=nextHeader.innerHTML;
    const body=section.querySelector(".tracked-table-wrap, .empty");
    const nextBody=nextSection.querySelector(".tracked-table-wrap, .empty");
    const oldExpired=section.querySelector(".session-expired-history"),nextExpired=nextSection.querySelector(".session-expired-history");
    if(oldExpired&&!nextExpired)oldExpired.remove();
    else if(!oldExpired&&nextExpired)section.append(nextExpired);
    else if(oldExpired&&nextExpired&&oldExpired.innerHTML!==nextExpired.innerHTML){
      const wasOpen=oldExpired.open;oldExpired.innerHTML=nextExpired.innerHTML;oldExpired.open=wasOpen;
    }
    const tbody=body?.querySelector("tbody"),nextTbody=nextBody?.querySelector("tbody");
    if(!tbody||!nextTbody){if(body.outerHTML!==nextBody.outerHTML)body.replaceWith(nextBody);continue;}
    const existing=new Map([...tbody.children].map(row=>[row.dataset.trackerId,row]));
    for(const [index,nextRow] of [...nextTbody.children].entries()){
      const row=existing.get(nextRow.dataset.trackerId)||nextRow;
      existing.delete(nextRow.dataset.trackerId);
      if(row!==nextRow&&row.innerHTML!==nextRow.innerHTML){
        const wasOpen=row.querySelector("details")?.open;
        row.innerHTML=nextRow.innerHTML;
        if(wasOpen)row.querySelector("details").open=true;
        row.className=nextRow.className;
      }
      if(tbody.children[index]!==row)tbody.insertBefore(row,tbody.children[index]||null);
    }
    for(const row of existing.values())row.remove();
  }
}

export function renderWorkstation(doc,model,ui,now=Date.now()){
  const page=ROUTES.includes(ui.page)?ui.page:"home";const [eyebrow,title]=TITLES[page];
  doc.getElementById("pageEyebrow").textContent=eyebrow;doc.getElementById("pageTitle").textContent=title;
  doc.getElementById("demoBanner").hidden=!ui.demo;doc.getElementById("modeBadge").textContent=ui.demo?"SIMULATED":"READ ONLY";
  for(const link of doc.querySelectorAll("[data-route]")){link.classList.toggle("active",link.dataset.route===page);link.href=routeHref(link.dataset.route,ui.demo);}
  const status=dashboardStatus(model,now);doc.getElementById("snapshotTime").textContent=model?.as_of?`Snapshot ${dateTime(model.as_of)}`:"No snapshot";
  doc.getElementById("connection").textContent=ui.demo?"Isolated static demo":`${status.state}${finite(status.age)?` · ${Math.round(status.age)}s old`:""}`;
  const renderers={home,opportunities,tracking:(m,u)=>tracking(m,u,now),"options-analysis":(m,u)=>renderOptionsAnalysis(u.optionsAnalysisRows,u.optionsSymbol,now,u.optionsAnalysisState,u.optionsZoom),market,sectors,news,watchlist};
  const pageNode=doc.getElementById("page");
  const html=model?renderers[page](model,ui):`<section class="panel empty-state"><strong>Normalized live dashboard is not published yet.</strong><p>The authenticated site is healthy, but this projection predates the new read-only dashboard contract. Demo mode remains fully available at <a href="#/demo/home">#/demo</a>.</p></section>`;
  if(page==="tracking"&&pageNode.innerHTML!==html&&typeof pageNode.querySelector==="function"&&pageNode.querySelector("#trackingFilters"))reconcileTracking(pageNode,html);
  else if(page!=="tracking"||pageNode.innerHTML!==html)pageNode.innerHTML=html;
}

export function renderDetail(doc,row,model=null){const overlay=doc.getElementById("detailOverlay");if(!row){overlay.hidden=true;doc.getElementById("detailDialog").replaceChildren();return;}overlay.hidden=false;doc.getElementById("detailDialog").innerHTML=detail(row,{model});}
