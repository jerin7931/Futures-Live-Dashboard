import {renderOptionsAnalysis} from "./options-analysis-view.js?v=6.4.0";

const esc=value=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
const time=value=>Number.isFinite(Date.parse(value||""))?new Date(value).toLocaleString("en-US",{dateStyle:"short",timeStyle:"short",timeZone:"America/Chicago"}):"—";

function botCard(symbol,gamma){
  const row=(gamma||[]).find(item=>item.symbol===symbol),summary=row?.payload?.summary||{};
  return `<article class="panel ai-analysis-card no-trade"><header><div><span class="eyebrow">${symbol} BOT</span><h2>DISABLED · AWAITING GROK SETUP</h2><p>Independent runtime activation remains off. Market-data ingestion may continue; no bot recommendation or execution process is active.</p></div><div class="ai-analysis-meta"><strong>${esc(row?.status||"UNAVAILABLE")}</strong><span>Gamma ${esc(summary.gamma_regime||"UNAVAILABLE")}</span><span>${time(row?.source_as_of)}</span></div></header><div class="ai-plan"><div><small>Execution universe</small><p>${symbol} 0DTE options only</p></div><div><small>Activation</small><p>Manual, one bot at a time</p></div><div><small>Order execution</small><p>Disabled</p></div></div></article>`;
}

function home(model){
  return `<div class="ai-workspace-home"><section class="ai-workspace-heading"><div><span class="eyebrow">THREE-BOT PRODUCTION ARCHITECTURE</span><h1>SPY · QQQ · IWM</h1><p>Authenticated read-only status. ES and NQ remain supporting state/order-flow inputs. SPX Fast and SPX options are decommissioned.</p></div><span class="status-pill">RUNTIMES OFF</span></section>${["SPY","QQQ","IWM"].map(symbol=>botCard(symbol,model.gamma)).join("")}</div>`;
}

export function renderPage(model,ui){
  if(ui.page==="options-analysis")return renderOptionsAnalysis(model.gamma||[],ui.optionsSymbol,Date.now(),model.gammaState||"READY",ui);
  return home(model);
}
