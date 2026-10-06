import {renderOptionsAnalysis} from "./options-analysis-view.js?v=6.4.0";
import {renderReversalHome} from "./option-reversal-view.js?v=6.5.2";

const esc=value=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
const time=value=>Number.isFinite(Date.parse(value||""))?new Date(value).toLocaleString("en-US",{dateStyle:"short",timeStyle:"short",timeZone:"America/Chicago"}):"—";

export function renderPage(model,ui){
  if(ui.page==="options-analysis")return renderOptionsAnalysis(model.gamma||[],ui.optionsSymbol,Date.now(),model.gammaState||"READY",ui);
  return renderReversalHome(model.reversal||[]);
}
