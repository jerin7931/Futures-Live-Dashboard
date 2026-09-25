import {filterTracking,focusRows,gateRows,href,trackingPopulation} from "./cash-open-core.js?v=4.0.0";
import {renderCompactGamma,renderOptionsAnalysis} from "./options-analysis-view.js?v=4.0.0";

const esc=value=>String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[char]));
const numeric=value=>value===null||value===undefined||value===""?null:Number.isFinite(Number(value))?Number(value):null;
const fixed=(value,digits=2)=>numeric(value)===null?"—":Number(value).toLocaleString("en-US",{minimumFractionDigits:digits,maximumFractionDigits:digits});
const signed=(value,digits=2)=>numeric(value)===null?"—":`${Number(value)>0?"+":""}${fixed(value,digits)}`;
const time=value=>Number.isFinite(Date.parse(value||""))?new Date(value).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",timeZone:"America/Chicago"}):"—";
const evidence=row=>row.standard_0900_evidence||row.gate_0845_evidence||{};
const status=row=>esc(row.data_status||"UNAVAILABLE");
const option=row=>esc(row.option_quality_current||row.option_quality_at_lock||"UNAVAILABLE");
const pill=(value,tone="")=>`<span class="cash-pill ${tone}">${esc(value)}</span>`;
const empty=text=>`<p class="cash-empty">${esc(text)}</p>`;

function focusCard(row){
  const e=evidence(row),c=row.current_context||{},atr=c.m5_atr||{};
  return `<button type="button" class="cash-focus-card ${row.direction==="SHORT"?"short":"long"}" data-action="detail" data-symbol="${esc(row.symbol)}">
    <div class="cash-focus-top"><span class="cash-rank">#${esc(row.lane_rank||"—")}</span><div><strong>${esc(row.symbol)}</strong><small>${esc(row.company||row.name||"")}</small></div>${pill(row.direction,row.direction==="SHORT"?"negative":"positive")}</div>
    <div class="cash-focus-main"><div><small>Opening Volume</small><strong>${fixed(e.opening_volume_ratio)}×</strong></div><div><small>Opening Efficiency</small><strong>${fixed(e.opening_efficiency,3)}</strong></div><div><small>Displacement</small><strong>${fixed(e.open_to_anchor_atr)} ATR</strong></div></div>
    <div class="cash-focus-meta"><span>SPY ${row.direction==="LONG"?"alignment":"relative"}: ${signed(e.relative_to_spy_pct)}%</span><span>5m volume: ${esc(e.volume_state||"—")}</span><span>Room: ${fixed(e.room_to_level_atr)} ATR</span><span>Options: ${option(row)}</span></div>
    <div class="cash-focus-bottom"><span>Current Eff ${fixed(c.current_efficiency,3)}</span><span>5m Trail ${fixed(atr.trail)}</span><span>${status(row)}</span></div>
  </button>`;
}

function focusLane(rows,direction){
  return `<section class="cash-lane ${direction.toLowerCase()}"><header><h2>${direction} FOCUS</h2><span>${rows.length} selected</span></header><div class="cash-lane-cards">${rows.length?rows.map(focusCard).join(""):empty(`No ${direction} Focus setup qualified at 09:00.`)}</div></section>`;
}

function newsItems(news,limit){
  const articles=(news?.articles||[]).slice(0,limit);
  if(!articles.length)return empty("No current headlines are published.");
  return `<div class="cash-news-list">${articles.map(article=>{
    const url=String(article.url||"");const safe=/^https?:\/\//i.test(url)?url:"";
    return `<article class="cash-news-item"><time>${time(article.first_seen_at)}</time><div>${safe?`<a href="${esc(safe)}" target="_blank" rel="noopener noreferrer">${esc(article.title)}</a>`:`<strong>${esc(article.title)}</strong>`}<small>${esc(article.source||"Unattributed")} · ${esc((article.symbols||[]).join(", ")||"Market")}</small></div></article>`;
  }).join("")}</div>`;
}

export function renderHome(model,demo=false){
  const rows=model.candidates||[],long=focusRows(rows,"LONG"),short=focusRows(rows,"SHORT"),
    gamma=new Map((model.gamma||[]).map(row=>[row.symbol,row]));
  const gammaCards=["SPX","SPY","QQQ","IWM"].map(symbol=>`<a class="panel cash-gamma-card" href="${href("options-analysis",demo)}" data-gamma-symbol="${symbol}"><header><h3>${symbol}</h3><span>Full analysis ↗</span></header>${renderCompactGamma(gamma.get(symbol))}</a>`).join("");
  return `<div class="cash-home"><section class="cash-focus-grid">${focusLane(long,"LONG")}${focusLane(short,"SHORT")}</section>
    <section class="cash-home-section"><div class="cash-section-heading"><div><span class="eyebrow">MARKET STRUCTURE</span><h2>0DTE Gamma Structure</h2></div><a href="${href("options-analysis",demo)}">Full Options Analysis →</a></div><div class="cash-gamma-grid">${gammaCards}</div></section>
    <section class="panel cash-home-section"><div class="cash-section-heading"><div><span class="eyebrow">CURRENT HEADLINES</span><h2>Market News</h2></div><a href="${href("news",demo)}">View all →</a></div>${newsItems(model.news,8)}</section></div>`;
}

function table(rows,stage){
  if(!rows.length)return empty("No matching candidates in this section.");
  return `<div class="cash-table-scroll"><table class="cash-table"><thead><tr><th>Stage / Rank</th><th>Symbol</th><th>Direction</th><th>Opening Vol</th><th>Opening Eff</th><th>Disp ATR</th><th>5m Volume</th><th>Rel vs SPY</th><th>Room</th><th>Current Eff</th><th>5m ATR</th><th>Options</th><th>Data</th></tr></thead><tbody>${rows.map(row=>{
    const e=evidence(row),c=row.current_context||{},atr=c.m5_atr||{};
    return `<tr class="${row.selected_0900?"cash-selected-row":""}"><td>${esc(row.selected_0900?`${row.lane} #${row.lane_rank}`:`08:45 #${row.gate_rank||"—"}`)}</td><td><button type="button" class="cash-symbol" data-action="detail" data-symbol="${esc(row.symbol)}">${esc(row.symbol)}</button><small>${esc(row.company||row.name||"")}</small></td><td>${pill(row.direction||"—",row.direction==="SHORT"?"negative":"positive")}</td><td>${fixed(e.opening_volume_ratio)}×</td><td>${fixed(e.opening_efficiency,3)}</td><td>${fixed(e.open_to_anchor_atr)}</td><td>${esc(e.volume_state||"—")}</td><td>${signed(e.relative_to_spy_pct)}%</td><td>${fixed(e.room_to_level_atr)} ATR</td><td>${fixed(c.current_efficiency,3)}</td><td>${fixed(atr.trail)}</td><td>${option(row)}</td><td>${status(row)}</td></tr>`;
  }).join("")}</tbody></table></div>`;
}

const options=(values,current)=>values.map(([value,label])=>`<option value="${esc(value)}" ${value===current?"selected":""}>${esc(label)}</option>`).join("");
export function renderTracking(model,filters,feedback=""){
  const rows=model.candidates||[],f={query:"",direction:"ALL",stage:"ALL",option:"ALL",sort:"opening-rank",...filters},
    filtered=filterTracking(rows,f),session=model.session||{};
  const strip=[["08:45 Gate",session.gate_0845_count],["LONG Focus",session.long_selected_count],
    ["SHORT Focus",session.short_selected_count],["SPY Open",`${signed(session.spy_open_return)}%`],
    ["Focus Lock",time(session.focus_locked_at)],["Evidence",time(session.source_as_of)]];
  return `<div class="cash-tracking"><section class="cash-summary-strip">${strip.map(([label,value])=>`<div class="panel"><small>${esc(label)}</small><strong>${esc(value??"—")}</strong></div>`).join("")}</section>
    <section class="panel cash-controls"><div class="cash-filter-grid"><label>Search<input name="query" value="${esc(f.query)}" placeholder="Ticker or company"></label>
    <label>Direction<select name="direction">${options([["ALL","All"],["LONG","Long"],["SHORT","Short"]],f.direction)}</select></label>
    <label>Stage<select name="stage">${options([["ALL","All"],["FOCUS","09:00 Focus"],["GATE","08:45 Gate"]],f.stage)}</select></label>
    <label>Option Quality<select name="option">${options([["ALL","All"],["FAIR+","Fair+"],["GOOD+","Good+"],["EXCELLENT","Excellent"],["GOOD","Good"],["FAIR","Fair"],["UNAVAILABLE","Unavailable"]],f.option)}</select></label>
    <label>Sort<select name="sort">${options([["opening-rank","Opening Rank"],["current-efficiency","Current Efficiency"],["opening-efficiency","Opening Efficiency"],["opening-volume","Opening Volume"],["symbol","Symbol"]],f.sort)}</select></label></div>
    <div class="cash-export-controls"><span>${filtered.count} matching / ${trackingPopulation(rows).length} tracked</span><div><button type="button" data-action="export-tradingview">Export TradingView .txt</button><button type="button" data-action="copy-tradingview">Copy TradingView Symbols</button></div><small id="cashExportFeedback" role="status">${esc(feedback)}</small></div></section>
    <section class="panel cash-tracking-section"><div class="cash-section-heading"><h2>09:00 Daily Focus · Pinned</h2><small>Membership locks for the session</small></div><h3 class="cash-lane-label positive">LONG FOCUS</h3>${table(filtered.selectedLong,"FOCUS")}
    <h3 class="cash-lane-label negative">SHORT FOCUS</h3>${table(filtered.selectedShort,"FOCUS")}</section>
    <section class="panel cash-tracking-section"><div class="cash-section-heading"><h2>08:45 Opening Gate</h2><small>Broad-qualified, not selected above</small></div>${table(filtered.gate,"GATE")}</section></div>`;
}

export function renderNews(model,query=""){
  const lower=query.trim().toLowerCase();
  const articles=(model.news?.articles||[]).filter(article=>!lower||
    `${article.title||""} ${article.source||""} ${(article.symbols||[]).join(" ")}`.toLowerCase().includes(lower));
  return `<div class="cash-news-page"><section class="panel cash-news-filter"><label>Search headlines<input name="newsQuery" value="${esc(query)}" placeholder="Headline, ticker, or source"></label><span>${articles.length} current headlines · source ${time(model.news?.source_as_of)}</span></section><section class="panel">${newsItems({articles},500)}</section></div>`;
}

export function renderPage(model,ui){
  if(ui.page==="home")return renderHome(model,ui.demo);
  if(ui.page==="tracking")return renderTracking(model,ui.filters,ui.exportFeedback);
  if(ui.page==="news")return renderNews(model,ui.newsQuery);
  return renderOptionsAnalysis(model.gamma||[],ui.optionsSymbol,Date.now(),model.gammaState||"READY",ui.optionsZoom);
}

export function renderDetail(row){
  const e=evidence(row),gate=row.gate_0845_evidence||{},standard=row.standard_0900_evidence||{},c=row.current_context||{},atr=c.m5_atr||{},opt=row.option_evidence||{};
  return `<div class="cash-detail-head"><div><span class="eyebrow">CASH-OPEN EVIDENCE</span><h2>${esc(row.symbol)} · ${esc(row.company||row.name||"")}</h2></div><button type="button" data-action="close-detail" aria-label="Close details">×</button></div>
    <div class="cash-detail-grid"><div><small>Direction</small><strong>${esc(row.direction||"—")}</strong></div><div><small>Stage</small><strong>${row.selected_0900?"09:00 Focus":row.gate_0845?"08:45 Gate":"—"}</strong></div><div><small>Opening Volume</small><strong>${fixed(e.opening_volume_ratio)}×</strong></div><div><small>Opening Efficiency</small><strong>${fixed(e.opening_efficiency,3)}</strong></div><div><small>Displacement</small><strong>${fixed(e.open_to_anchor_atr)} ATR</strong></div><div><small>Option Quality</small><strong>${option(row)}</strong></div><div><small>Current Efficiency</small><strong>${fixed(c.current_efficiency,3)}</strong></div><div><small>5m ATR Trail</small><strong>${fixed(atr.trail)}</strong></div><div><small>5m Volume State</small><strong>${esc(e.volume_state||"—")}</strong></div><div><small>SPY Relative</small><strong>${signed(e.relative_to_spy_pct)}%</strong></div><div><small>Nearest Opposing</small><strong>${fixed(e.nearest_opposing_level)}</strong></div><div><small>Room</small><strong>${fixed(e.room_to_level_atr)} ATR</strong></div></div>
    <p class="cash-detail-note">08:45 gate: ${gate.broad_qualified?"qualified":"not qualified"} · 09:00 standard: ${standard.standard_qualified?"qualified":"not qualified"} · Current context is descriptive and does not change locked membership.</p>
    ${opt.reference_contract?`<div class="cash-detail-option"><h3>Reference option context</h3><p>${esc(opt.reference_contract.symbol)} · ${esc(opt.quality)} · quote ${time(opt.reference_contract.quote_time)} · spread ${fixed(opt.reference_contract.spread_pct)}%</p></div>`:""}`;
}
