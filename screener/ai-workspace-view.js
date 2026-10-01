import {renderOptionsAnalysis} from "./options-analysis-view.js?v=5.4.0";

const esc=value=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
const num=value=>value===null||value===undefined||!Number.isFinite(Number(value))?null:Number(value);
const fixed=(value,places=2)=>num(value)===null?"—":Number(value).toLocaleString("en-US",{minimumFractionDigits:places,maximumFractionDigits:places});
const time=value=>Number.isFinite(Date.parse(value||""))?new Date(value).toLocaleString("en-US",{dateStyle:"short",timeStyle:"short",timeZone:"America/Chicago"}):"—";
const list=value=>Array.isArray(value)?value:value&&typeof value==="object"?Object.entries(value).map(([key,item])=>`${key}: ${item}`):value?[String(value)]:[];

function tradingViewExport(ui){
  const feedback=ui.tradingViewGammaFeedback?`<pre class="tv-gamma-feedback" role="status" aria-live="polite">${esc(ui.tradingViewGammaFeedback)}</pre>`:"<span class=\"tv-gamma-hint\">One gamma-only TVG2 packet · SPX / QQQ / IWM / SPY</span>";
  const fallback=ui.tradingViewGammaFallback?`<div class="tv-gamma-modal" role="dialog" aria-modal="true" aria-labelledby="tvGammaFallbackTitle"><div class="panel"><h2 id="tvGammaFallbackTitle">Copy Gamma Levels for all manually</h2><p>Clipboard access was unavailable. Select and copy the complete TVG2 packet below.</p><textarea readonly rows="14" data-tv-gamma-fallback>${esc(ui.tradingViewGammaFallback)}</textarea><button type="button" data-action="close-tv-gamma-fallback">Close</button></div></div>`:"";
  return `<section class="panel tv-gamma-export"><div><strong>TradingView gamma export</strong>${feedback}</div><button type="button" class="tv-gamma-copy" data-action="copy-tradingview-gamma">Copy Gamma Levels for all</button></section>${fallback}`;
}

function ageGrid(row){
  const ages=row?.source_ages&&typeof row.source_ages==="object"?row.source_ages:{};
  const labels={es_state_age_seconds:"ES state",footprint_age_seconds:"Footprint",spx_market_age_seconds:"SPX",spx_options_age_seconds:"Options",spx_gamma_age_seconds:"Gamma"};
  const entries=Object.entries(labels).map(([key,label])=>{
    const value=num(ages[key]);
    return `<div><small>${label}</small><strong>${value===null?"N/A":value<90?`${Math.round(value)}s`:`${fixed(value/60,1)}m`}</strong></div>`;
  });
  return `<div class="ai-source-ages">${entries.join("")}</div>`;
}

function contract(row){
  if(row?.decision!=="TRADE")return `<div class="ai-no-contract"><strong>No contract selected</strong><span>A contract is selected only after a valid directional setup.</span></div>`;
  return `<div class="ai-contract"><div><small>Contract</small><strong>${esc(row.option_type||"—")} · ${esc(row.expiration||"—")} · ${fixed(row.strike,0)}</strong></div><div><small>Premium</small><strong>${fixed(row.premium_reference??((num(row.bid)!==null&&num(row.ask)!==null)?(Number(row.bid)+Number(row.ask))/2:null))}</strong></div><div><small>Bid / Ask</small><strong>${fixed(row.bid)} / ${fixed(row.ask)}</strong></div><div><small>Delta</small><strong>${fixed(row.delta,3)}</strong></div><div><small>Gamma</small><strong>${fixed(row.gamma,4)}</strong></div><div><small>IV</small><strong>${fixed(row.iv,3)}</strong></div></div>`;
}

function analysisArticle(row,latest=false){
  const decision=row?.decision||"NO_TRADE",decisionLabel=decision==="NO_TRADE"?"NO TRADE":decision;
  const warnings=list(row?.warnings);
  const detailed=row?.full_analysis||row?.analysis_markdown||"Detailed analysis is not available for this record.";
  return `<article class="ai-analysis-card ${decision==="TRADE"?"trade":"no-trade"}"><header><div><span class="eyebrow">${latest?"LATEST ANALYSIS":"ANALYSIS HISTORY"}</span><h2>${esc(decisionLabel)}${row?.market_state?` — ${esc(row.market_state)}`:""}</h2><p>${esc(row?.concise_summary||row?.analysis_summary||"Awaiting the next configured analysis run.")}</p></div><div class="ai-analysis-meta"><strong>${time(row?.analysis_at||row?.analysis_slot_at||row?.generated_at)}</strong><span>${esc(row?.bias||row?.direction||"NEUTRAL")}</span><span>Confidence ${num(row?.confidence)===null?"N/A":fixed(Number(row.confidence)*100,0)+"%"}</span></div></header>${contract(row)}<div class="ai-plan"><div><small>Entry condition</small><p>${esc(row?.entry_condition||"No entry condition")}</p></div><div><small>Target</small><p>${esc(row?.target||"No target")}</p></div><div><small>Invalidation</small><p>${esc(row?.invalidation||"No invalidation")}</p></div></div>${ageGrid(row)}${warnings.length?`<div class="ai-warnings"><strong>Data warnings</strong><ul>${warnings.map(item=>`<li>${esc(item)}</li>`).join("")}</ul></div>`:""}<details class="ai-details"><summary>Detailed reasoning and source context</summary><p>${esc(detailed)}</p><dl><div><dt>ES levels</dt><dd>${esc(JSON.stringify(row?.es_key_levels||{}))}</dd></div><div><dt>SPX levels</dt><dd>${esc(JSON.stringify(row?.spx_key_levels||{}))}</dd></div><div><dt>Gamma</dt><dd>${esc(JSON.stringify(row?.gamma_context||{}))}</dd></div><div><dt>Version</dt><dd>${esc(row?.analysis_version||row?.model_label||"—")}</dd></div></dl></details></article>`;
}

function aiHome(model,ui){
  const current=(model.aiCurrent||[])[0]||(model.aiHistory||[])[0];
  const history=(model.aiHistory||[]).filter(row=>!current||row.analysis_id!==current.analysis_id&&row.input_hash!==current.input_hash);
  return `<div class="ai-workspace-home">${tradingViewExport(ui)}<section class="ai-workspace-heading"><div><span class="eyebrow">SPX OPTIONS DECISION SUPPORT</span><h1>AI Analysis</h1><p>ES regime and footprint, SPX structure, InsiderFinance gamma, and current Webull SPX options. Stale sources are disclosed and never silently suppress a scheduled decision.</p></div><span class="status-pill">READ ONLY</span></section>${current?analysisArticle(current,true):`<section class="panel ai-empty"><h2>Awaiting first SPX / ES analysis</h2><p>The data infrastructure is ready. The 15-minute AI scheduler remains intentionally unactivated until the owner chooses the approved execution platform.</p></section>`}<section class="panel ai-history"><header><div><span class="eyebrow">PREVIOUS ANALYSES</span><h2>Analysis history</h2></div><span>${history.length} retained</span></header><div class="ai-history-list">${history.map(row=>analysisArticle(row,false)).join("")||"<p class=\"muted\">No prior SPX analysis records are available.</p>"}</div></section></div>`;
}

export function renderPage(model,ui){
  if(ui.page==="options-analysis")return renderOptionsAnalysis(model.gamma||[],ui.optionsSymbol,Date.now(),model.gammaState||"READY",ui);
  return aiHome(model,ui);
}
