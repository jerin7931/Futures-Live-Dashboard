import {ROUTES,SORTS,STATES,filterOpportunities,paginate,availableIndustries,filterNews,selectOpportunity,dashboardStatus,routeHref} from "./dashboard-core.js?v=3.0.15";
import {TRACKER_SORTS,TRACKER_TERMINAL,defaultTrackerFilters,hydrateTrackerRows,filterTracked} from "./tracking-core.js?v=3.0.15";

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
function home(model,ui){const rows=discoveryRows(model).slice(0,9);const selected=rows.find(row=>row.symbol===ui.selectedSymbol)||rows[0];return `<div class="summary-grid">${marketPanel(model)}${marketNewsPanel(model)}${groupPanel("Sector performance","CURRENT RADAR",model.sectors||[],"sectors",model)}${groupPanel("Top industries","LEADERS & LAGGARDS",model.industries||[],"sectors",model)}</div>${capacityWarnings(model)}<div class="home-main"><section class="panel radar-panel"><div class="panel-title"><div><span class="eyebrow">NEWEST &amp; MEANINGFULLY CHANGED</span><h2>Opportunity Radar</h2></div><a href="${routeHref("opportunities",ui.demo)}">Open full radar →</a></div>${radarTable(rows,{compactHome:true,watchlist:ui.watchlist})}</section>${detail(selected,{inline:true,model})}</div>`;}

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
  const sectors=[...new Set(rows.map(row=>row.sector).filter(Boolean))].sort();
  const industries=[...new Set(rows.map(row=>row.industry).filter(Boolean))].sort();
  const menu=(name,label,values)=>`<label>${label}<select name="${name}">${values.map(([value,text])=>`<option value="${esc(value)}"${selected(f[name],value)}>${esc(text)}</option>`).join("")}</select></label>`;
  return `<form id="trackingFilters" class="filter-panel panel"><div class="filter-main">
    <label>Search<input name="query" value="${esc(f.query)}" placeholder="Symbol or company"></label>
    ${menu("direction","Direction",[["ALL","All"],["LONG","Long"],["SHORT","Short"]])}
    ${menu("status","Tracker status",[["ALL","All"],["ACTIVE","All nonterminal"],...["TRACKING","WEAKENING","RECOVERING","INVALIDATION_PENDING","INVALIDATED","SESSION_EXPIRED"].map(x=>[x,x.replaceAll("_"," ")])])}
    ${menu("v1","Current V1",[["ALL","All"],...STATES.map(x=>[x,x.replaceAll("_"," ")])])}
    ${menu("movement","Movement",[["ALL","All"],["HIGH","High"],["GOOD+","Good+"],["ACCEPTABLE+","Acceptable+"],["DOLLAR_MOVER","Dollar Movers"]])}
    ${menu("atrPercent","ATR %",[["ALL","All"],...["2.00","1.75","1.50","1.25"].map(x=>[x,`≥ ${x}%`])])}
    ${menu("efficiency","Efficiency",[["ALL","All"],...["0.80","0.70","0.60","0.50","0.40","0.35"].map(x=>[x,`≥ ${x}`])])}
    ${menu("optionQuality","Option quality",[["ALL","All"],["EXCELLENT","Excellent"],["GOOD+","Good+"],["FAIR+","Fair+"],["THIN+","Thin+"],["POOR","Poor"],["UNAVAILABLE","Unavailable"]])}
    ${menu("sector","Sector",[["ALL","All"],...sectors.map(x=>[x,x])])}
    ${menu("industry","Industry",[["ALL","All"],...industries.map(x=>[x,x])])}
    ${menu("data","Data",[["ALL","All"],["FRESH","Fresh"],["STALE","Stale"],["DELAYED","Delayed"],["UNAVAILABLE","Unavailable"]])}
    ${menu("sort","Sort",[["default","Section default"],...Object.entries(TRACKER_SORTS)])}
  </div><div class="filter-toggles"><label><input type="checkbox" name="nonterminalOnly"${f.nonterminalOnly?" checked":""}>Nonterminal only</label><button type="button" class="quiet-button" data-action="clear-tracking-filters">Clear filters</button></div></form>`;
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

function trackedTable(rows,now,aiState){
  if(!rows.length)return `<p class="empty">No lifecycles match these filters.</p>`;
  return `<div class="tracked-table-wrap"><table class="tracked-table"><thead><tr><th>Symbol</th><th>Direction</th><th>Tracker / Structure</th><th>V1 / ATR</th><th>Efficiency / Move</th><th>Options</th><th>Confirmed / Aligned</th><th>Sector / Industry</th><th>Data</th><th>Evidence</th></tr></thead><tbody>${rows.map(row=>{
    const terminal=TRACKER_TERMINAL.has(row.tracker_state);
    const structure=row.alignment==="UNKNOWN"?"ATR UNKNOWN · AWAITING 5M DATA":row.alignment||"LEGACY · STRUCTURE UNKNOWN";
    const movement=row.movement_quality||"UNAVAILABLE";
    return `<tr class="${terminal?"tracked-terminal":""}"><td><strong>${esc(row.symbol)}</strong><small>${esc(row.company_name)}</small></td>
      <td>${badge(row.direction,row.direction==="LONG"?"positive direction-long":"negative direction-short")}</td>
      <td>${badge(row.tracker_state,terminal?"negative":"blue")}<small>${esc(structure)}</small>${row.first_alignment_at&&row.initial_alignment==="COUNTERTREND"?`<small>CT → ALIGNED</small>`:""}</td>
      <td><strong>${esc(row.v1_state)}</strong><small>5m ${row.atr_m5_direction===1?"BULLISH":row.atr_m5_direction===-1?"BEARISH":"UNKNOWN"}</small><small>1m ${esc(row.atr_m1_warning||"UNAVAILABLE")}</small></td>
      <td><strong>${fmt(row.efficiency,2)}</strong><small>ATR $${fmt(row.atr_dollars)} · ${pct(row.atr_percent)}</small><small>${esc(movement)}</small></td>
      <td>${badge(row.option_quality,`option-${String(row.option_quality||"unavailable").toLowerCase()}`)}<small>${terminal?"Last retained context":"Read-only enrichment"}</small></td>
      <td>${dateTime(row.first_confirmed_at)}<small>Aligned ${dateTime(row.first_alignment_at)}</small></td>
      <td>${esc(row.sector||"Unknown")}<small>${esc(row.industry||"Unknown")}</small></td>
      <td>${badge(row.data_status||"UNAVAILABLE",String(row.data_status||"unavailable").toLowerCase())}</td>
      <td><details><summary>View</summary><dl><dt>Tracker ID</dt><dd>${esc(row.id)}</dd><dt>Confirmed price</dt><dd>${esc(row.confirmed_price||"—")}</dd><dt>5m trail</dt><dd>${fmt(row.atr_m5_trail==null?null:Number(row.atr_m5_trail))}</dd><dt>5m bar</dt><dd>${dateTime(row.last_m5_bar_end)}</dd><dt>Invalidated</dt><dd>${dateTime(row.invalidated_at)}</dd><dt>Reason</dt><dd>${esc(row.invalidation_reason||"—")}</dd><dt>Data status</dt><dd>${esc(row.data_status||"—")}</dd></dl><h4>AI Analysis</h4>${aiAnalysis(row,now,aiState)}</details></td></tr>`;
  }).join("")}</tbody></table></div>`;
}

function tracking(model,ui,now=Date.now()){
  const all=hydrateTrackerRows(model),f={...defaultTrackerFilters(),...(ui.trackerFilters||{})};
  const filtered=filterTracked(all,f);
  const aligned=filtered.filter(row=>row.alignment==="ALIGNED");
  const pending=filtered.filter(row=>row.alignment!=="ALIGNED");
  const section=(title,rows,total)=>`<section class="panel tracked-section"><div class="panel-title"><div><span class="eyebrow">DURABLE LIFECYCLES · READ ONLY</span><h2>${title}</h2></div><span>${rows.filter(row=>!TRACKER_TERMINAL.has(row.tracker_state)).length} active · ${total} session total</span></div>${trackedTable(rows,now,model.ai_analysis_state)}</section>`;
  const notice=model.tracker_history_state&&model.tracker_history_state!=="READY"?`<div class="capacity-warning"><strong>Tracker history ${esc(model.tracker_history_state)}</strong><span>Historical rows may be incomplete; no provider request was made.</span></div>`:"";
  return `${trackerFilters(all,ui)}${notice}${section("ALIGNED",aligned,all.filter(row=>row.alignment==="ALIGNED").length)}${section("COUNTERTREND / AWAITING ALIGNMENT",pending,all.filter(row=>row.alignment!=="ALIGNED").length)}`;
}

function market(model){const sections=[["BROAD INDEXES",["SPY","QQQ","IWM"]],["VOLATILITY",["VIX"]],["RATES",["US2Y","US10Y"]],["DOLLAR",["DXY"]],["COMMODITIES",["WTI"]]];return `<div class="market-sections">${sections.map(([title,symbols])=>`<section class="panel"><span class="eyebrow">${title}</span><div class="metric-cards">${symbols.map(symbol=>{const row=model.market.find(value=>(value.key||value.symbol)===symbol)||{};return `<article><div><strong>${esc(row.key||row.symbol||symbol)}</strong><small>${esc(row.label||symbol)}</small></div><b>${fmt(row.value)}</b><span class="${tone(marketChange(row))}">${pct(marketChange(row))}</span>${macroStatus(row)}<small>${esc(row.source||"UNAVAILABLE")}${row.source_symbol?` · ${esc(row.source_symbol)}`:""}</small></article>`;}).join("")}</div></section>`).join("")}</div><div class="two-column">${groupPanel("Leading sectors","DERIVED RADAR CONTEXT",model.sectors||[],"sectors",model)}${groupPanel("Leading industries","DERIVED RADAR CONTEXT",model.industries||[],"sectors",model)}</div>${marketNewsPanel(model)}`;}

function groupTable(rows,type){if(!rows.length)return `<p class="empty">No ${esc(type)} data available.</p>`;return `<table class="group-table"><thead><tr><th>${esc(type)}</th><th>1D</th><th>5m</th><th>Breadth</th><th>Radar</th><th>Leaders</th><th>Laggards</th></tr></thead><tbody>${rows.map(row=>`<tr><td><button data-action="group" data-group-type="${type.toLowerCase()}" data-group="${esc(row.name)}">${esc(row.name)}</button><small>${esc(row.source)}</small></td><td class="${tone(row.performance_1d_pct)}">${pct(row.performance_1d_pct)}</td><td class="${tone(row.performance_5m_pct)}">${pct(row.performance_5m_pct)}</td><td>${finite(row.breadth)?pct(row.breadth*100):"—"}</td><td>${row.radar_member_count}</td><td>${esc((row.leaders||[]).join(" · "))}</td><td>${esc((row.laggards||[]).join(" · "))}</td></tr>`).join("")}</tbody></table>`;}
function sectors(model,ui){const chosen=ui.groupSelection;const peers=chosen?(model.opportunities||[]).filter(row=>row.sector===chosen.name||row.industry===chosen.name):[];return `<div class="two-column sector-columns"><section class="panel"><div class="panel-title"><div><span class="eyebrow">CURRENT RADAR PEER UNIVERSE</span><h2>Sectors</h2></div><span>Descriptive only</span></div>${groupTable(model.sectors||[],"Sector")}</section><section class="panel"><div class="panel-title"><div><span class="eyebrow">FINVIZ CLASSIFICATION</span><h2>Industries</h2></div><span>Click to inspect</span></div>${groupTable(model.industries||[],"Industry")}</section></div>${chosen?`<section class="panel"><div class="panel-title"><div><span class="eyebrow">SELECTED ${esc(chosen.type.toUpperCase())}</span><h2>${esc(chosen.name)}</h2></div><button data-action="clear-group" class="quiet-button">Close</button></div>${radarTable(peers,{watchlist:ui.watchlist})}</section>`:""}`;}

function newsFilters(model,ui){const f=ui.newsFilters;const sectors=[...new Set((model.news||[]).flatMap(row=>row.sector||[]))].sort();const categories=[...new Set((model.news||[]).map(row=>row.category).filter(Boolean))].sort();return `<form id="newsFilters" class="filter-panel panel"><div class="filter-main"><label>Scope<select name="scope"><option value="ALL">All scopes</option>${["COMPANY","INDUSTRY","SECTOR","MARKET","MULTI_COMPANY"].map(value=>`<option${selected(f.scope,value)}>${value}</option>`).join("")}</select></label><label>Category<select name="category"><option value="ALL">All categories</option>${categories.map(value=>`<option${selected(f.category,value)}>${esc(value)}</option>`).join("")}</select></label><label>Symbol<input name="symbol" value="${esc(f.symbol)}" placeholder="AMD"></label><label>Sector<select name="sector"><option value="ALL">All sectors</option>${sectors.map(value=>`<option${selected(f.sector,value)}>${esc(value)}</option>`).join("")}</select></label><label>Time range<select name="range"><option value="ALL">All retained</option><option value="1"${selected(f.range,"1")}>Past hour</option><option value="4"${selected(f.range,"4")}>Past 4 hours</option><option value="24"${selected(f.range,"24")}>Past day</option></select></label><label>Sort<select name="sort"><option value="firstSeen"${selected(f.sort,"firstSeen")}>Newest first observed</option><option value="published"${selected(f.sort,"published")}>Newest published</option></select></label></div></form>`;}
function news(model,ui){const rows=filterNews(model.news,ui.newsFilters);return `${newsFilters(model,ui)}<section class="panel"><div class="panel-title"><div><span class="eyebrow">CAUSAL ORDER: FIRST OBSERVED</span><h2>News &amp; Catalysts</h2></div><span>${rows.length} headlines</span></div><table class="news-table"><thead><tr><th>First seen</th><th>Published</th><th>Headline</th><th>Source</th><th>Scope</th><th>Category</th><th>Symbols</th><th>Sector</th><th>Industry</th></tr></thead><tbody>${rows.map(item=>{const url=safeUrl(item.url);return `<tr><td>${dateTime(item.first_seen_at)}</td><td>${dateTime(item.publication_at)}</td><td>${url?`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(item.headline)}</a>`:esc(item.headline)}</td><td>${esc(item.source||"—")}</td><td>${badge(item.scope)}</td><td>${esc(item.category)}</td><td>${esc((item.symbols||[]).join(" · ")||"—")}</td><td>${esc((item.sector||[]).join(" · ")||"—")}</td><td>${esc((item.industry||[]).join(" · ")||"—")}</td></tr>`;}).join("")||`<tr><td colspan="9" class="empty">No headlines match the current filters.</td></tr>`}</tbody></table></section>`;}

function watchlist(model,ui){const rows=(model.opportunities||[]).filter(row=>ui.watchlist.has(row.symbol));return `<section class="panel watchlist-head"><div><span class="eyebrow">PRIVATE OWNER WATCHLIST</span><h2>${rows.length} pinned symbol${rows.length===1?"":"s"}</h2><p>Pinning never evicts an active V1 lifecycle commitment.</p></div><form id="watchlistAdd"><label>Add current radar symbol<select name="symbol"><option value="">Choose symbol</option>${model.opportunities.filter(row=>!ui.watchlist.has(row.symbol)).map(row=>`<option>${esc(row.symbol)}</option>`).join("")}</select></label><button>Add</button></form></section>${!model.watchlist_capacity?.monitoring_enabled?`<div class="capacity-warning"><strong>Monitoring capacity notice</strong><span>${esc(model.watchlist_capacity?.message||"A separate bounded provider lane is not enabled.")}</span></div>`:""}<section class="panel">${rows.length?radarTable(rows,{watchlist:ui.watchlist}):`<div class="empty-state"><strong>Your watchlist is empty.</strong><p>Add a symbol from the Opportunity Radar or use the control above.</p></div>`}</section>`;}

const TITLES={home:["LIVE OPPORTUNITY WORKSTATION","Home"],opportunities:["FULL FILTERED UNIVERSE","Opportunity Radar"],tracking:["DURABLE CONFIRMED LIFECYCLES","Tracked Opportunities"],market:["BROAD CONTEXT · DESCRIPTIVE ONLY","Market Dashboard"],sectors:["PEER CONTEXT · NO ALIGNMENT GATE","Sectors & Industries"],news:["HEADLINE-ONLY EVIDENCE","News & Catalysts"],watchlist:["PRIVATE · OWNER ONLY","Watchlist"]};

export function renderWorkstation(doc,model,ui,now=Date.now()){
  const page=ROUTES.includes(ui.page)?ui.page:"home";const [eyebrow,title]=TITLES[page];
  doc.getElementById("pageEyebrow").textContent=eyebrow;doc.getElementById("pageTitle").textContent=title;
  doc.getElementById("demoBanner").hidden=!ui.demo;doc.getElementById("modeBadge").textContent=ui.demo?"SIMULATED":"READ ONLY";
  for(const link of doc.querySelectorAll("[data-route]")){link.classList.toggle("active",link.dataset.route===page);link.href=routeHref(link.dataset.route,ui.demo);}
  const status=dashboardStatus(model,now);doc.getElementById("snapshotTime").textContent=model?.as_of?`Snapshot ${dateTime(model.as_of)}`:"No snapshot";
  doc.getElementById("connection").textContent=ui.demo?"Isolated static demo":`${status.state}${finite(status.age)?` · ${Math.round(status.age)}s old`:""}`;
  const renderers={home,opportunities,tracking:(m,u)=>tracking(m,u,now),market,sectors,news,watchlist};doc.getElementById("page").innerHTML=model?renderers[page](model,ui):`<section class="panel empty-state"><strong>Normalized live dashboard is not published yet.</strong><p>The authenticated site is healthy, but this projection predates the new read-only dashboard contract. Demo mode remains fully available at <a href="#/demo/home">#/demo</a>.</p></section>`;
}

export function renderDetail(doc,row,model=null){const overlay=doc.getElementById("detailOverlay");if(!row){overlay.hidden=true;doc.getElementById("detailDialog").replaceChildren();return;}overlay.hidden=false;doc.getElementById("detailDialog").innerHTML=detail(row,{model});}
