import {renderOptionsAnalysis} from "./options-analysis-view.js?v=5.4.0";
import {renderOptionChain} from "./option-chain-view.js?v=5.2.0";
const ORDER=["SPX","QQQ","IWM","SPY"];
const esc=value=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
const num=value=>value===null||value===undefined||!Number.isFinite(Number(value))?null:Number(value);
const fixed=(value,places=2)=>num(value)===null?"—":Number(value).toLocaleString("en-US",{minimumFractionDigits:places,maximumFractionDigits:places});
const time=value=>Number.isFinite(Date.parse(value||""))?new Date(value).toLocaleString("en-US",{dateStyle:"short",timeStyle:"short",timeZone:"America/Chicago"}):"—";

function stateTop(row){
  const direction=row?.direction_state||"MIXED",arrow=direction==="BULLISH"?"↑":direction==="BEARISH"?"↓":"↔";
  const pb=row?.pullback_mode?`${row.pullback_mode} ${row.pullback_mode==="EXT"?"+":""}${fixed(row.pullback_value,0)}%`:"PB —";
  const active=row?.event_state&&!["QUIET","ENDED"].includes(row.event_state);
  const current=Math.max(num(row?.percentile_1m)||0,num(row?.percentile_5m)||0);
  const peak=row?.event_state==="5M STANDALONE"?(num(row?.peak_5m_percentile)||0):Math.max(num(row?.peak_1m_percentile)||0,num(row?.peak_5m_percentile)||0);
  const percentile=active?peak:current;
  const move=percentile?`MOVE ${fixed(percentile*100,1)}%${active?" PEAK":""}`:"MOVE WARMUP";
  const age=row?.event_started_at?Math.max(0,Math.floor((Date.now()-Date.parse(row.event_started_at))/60000)):null;
  const event=row?.event_state&&row.event_state!=="ENDED"?row.event_state:"QUIET";
  const confirm=row?.first_5m_confirmation_at?"5M CONFIRMED":num(row?.score_5m)!==null?"5M BUILDING":"5M NORMAL";
  return `<div class="lppc-top"><strong>${esc(row?.symbol)} <span>${row?.symbol==="SPX"?fixed(row?.price,1):`$${fixed(row?.price)}`}</span></strong><span class="direction-${direction.toLowerCase()}">${arrow} ${direction} · ${pb}</span><span>${move}</span><span>${event}${age!==null?` · ${age}m`:""}</span><span>${confirm}</span><em>${esc(row?.source_status||"UNAVAILABLE")}</em></div>`;
}

function gammaCompact(row,state){
  const summary=row?.payload?.summary||{},status=row?.status||"UNAVAILABLE",sourceAt=time(row?.source_as_of);
  return `<div class="lppc-tv-summary"><div><small>LPPC 1M score</small><strong>${fixed(state?.score_1m,4)}</strong></div><div><small>LPPC 5M score</small><strong>${fixed(state?.score_5m,4)}</strong></div><div><small>Move percentile</small><strong>${fixed(Math.max(num(state?.percentile_1m)||0,num(state?.percentile_5m)||0)*100,1)}%</strong></div><div><small>Gamma regime</small><strong>${esc(summary.gamma_regime||"UNAVAILABLE")}</strong></div><div><small>Gamma flip</small><strong>${fixed(summary.zero_gamma, state?.symbol==="SPX"?1:2)}</strong></div><div><small>Gamma source</small><strong class="freshness-${String(status).toLowerCase()}">${esc(status)} · ${sourceAt}</strong></div></div>`;
}

function tradingViewExport(ui){
  const feedback=ui.tradingViewGammaFeedback?`<pre class="tv-gamma-feedback" role="status" aria-live="polite">${esc(ui.tradingViewGammaFeedback)}</pre>`:"<span class=\"tv-gamma-hint\">One gamma-only TVG2 packet · SPX / QQQ / IWM / SPY</span>";
  const fallback=ui.tradingViewGammaFallback?`<div class="tv-gamma-modal" role="dialog" aria-modal="true" aria-labelledby="tvGammaFallbackTitle"><div class="panel"><h2 id="tvGammaFallbackTitle">Copy TradingView Gamma manually</h2><p>Clipboard access was unavailable. Select and copy the complete TVG2 packet below.</p><textarea readonly rows="14" data-tv-gamma-fallback>${esc(ui.tradingViewGammaFallback)}</textarea><button type="button" data-action="close-tv-gamma-fallback">Close</button></div></div>`:"";
  return `<section class="panel tv-gamma-export"><div><strong>TradingView is the primary market chart</strong>${feedback}</div><button type="button" class="tv-gamma-copy" data-action="copy-tradingview-gamma">Copy TradingView Gamma</button></section>${fallback}`;
}

function aiAnalysis(symbol,current,history,ui){
  const rows=history.filter(row=>row.symbol===symbol).sort((a,b)=>Date.parse(b.analysis_slot_at||b.generated_at)-Date.parse(a.analysis_slot_at||a.generated_at));
  const latest=current.find(row=>row.symbol===symbol)||rows[0],open=Boolean(ui.aiExpanded[symbol]);
  const fields=row=>[["Summary",row.analysis_summary],["Structure",row.structure_read],["Levels",row.levels_read],["Options",row.options_read],["Market context",row.market_context],["Risks",row.risks],["Watch for",row.watch_for]].map(([label,value])=>`<div><dt>${label}</dt><dd>${esc(value||"UNAVAILABLE")}</dd></div>`).join("");
  return `<section class="lppc-ai"><button type="button" class="lppc-ai-toggle" data-action="toggle-ai" data-symbol="${symbol}" aria-expanded="${open}"><span>AI Analysis</span><small>${latest?`${time(latest.analysis_slot_at||latest.generated_at)} · ${esc(latest.analysis_status||"UNAVAILABLE")}`:"Awaiting first scheduled slot"}</small></button>${open?`<div class="lppc-ai-body" data-ai-history-scroll data-symbol="${symbol}">${latest?`<article><header><strong>Latest scheduled analysis</strong><span>Descriptive only · ${esc(latest.model_label||"")}</span></header><dl>${fields(latest)}</dl></article>`:`<p>No scheduled analysis is available.</p>`}<details><summary>Earlier analyses (${rows.length})</summary>${rows.map(row=>`<article><header><strong>${time(row.analysis_slot_at||row.generated_at)}</strong><span>${esc(row.analysis_status||"UNAVAILABLE")}</span></header><dl>${fields(row)}</dl></article>`).join("")||"<p>No history.</p>"}</details></div>`:""}</section>`;
}

export function renderHome(model,ui){
  ui.aiExpanded=ui.aiExpanded||{};
  const byState=new Map((model.lppc||[]).map(row=>[row.symbol,row])),gamma=new Map((model.gamma||[]).map(row=>[row.symbol,row]));
  return `<div class="lppc-home">${tradingViewExport(ui)}<div class="lppc-tv-grid">${ORDER.map(symbol=>{const row=byState.get(symbol)||{symbol,source_status:"UNAVAILABLE",event_state:"QUIET"};return `<section class="panel lppc-workstation" data-symbol="${symbol}">${stateTop(row)}${gammaCompact(gamma.get(symbol),row)}${aiAnalysis(symbol,model.aiCurrent||[],model.aiHistory||[],ui)}</section>`;}).join("")}</div></div>`;
}

export function renderPage(model,ui){
  if(ui.page==="home")return renderHome(model,ui);
  if(ui.page==="options-analysis")return renderOptionsAnalysis(model.gamma||[],ui.optionsSymbol,Date.now(),model.gammaState||"READY",ui);
  return renderOptionChain(model,ui);
}
