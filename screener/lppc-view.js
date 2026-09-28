import {renderCompactGamma,renderOptionsAnalysis} from "./options-analysis-view.js?v=5.2.0";
import {renderOptionChain} from "./option-chain-view.js?v=5.2.0";
import {renderEfficiencyChart} from "./efficiency-chart.js?v=5.2.0";
const ORDER=["SPX","QQQ","IWM","SPY"];
const esc=value=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
const num=value=>value===null||value===undefined||!Number.isFinite(Number(value))?null:Number(value);
const fixed=(value,places=2)=>num(value)===null?"—":Number(value).toLocaleString("en-US",{minimumFractionDigits:places,maximumFractionDigits:places});
const time=value=>Number.isFinite(Date.parse(value||""))?new Date(value).toLocaleString("en-US",{dateStyle:"short",timeStyle:"short",timeZone:"America/Chicago"}):"—";

function efficiencyChart(symbol,points,timeframe,state){
  const rows=points.filter(row=>row.symbol===symbol&&row.timeframe===timeframe);
  const details=state?.details||{},timeline=details.efficiency_direction_timeline?.[timeframe]||[],freshness=details.efficiency_freshness?.[timeframe]||{};
  return `<div class="lppc-efficiency"><div class="lppc-chart-tools"><strong>Efficiency</strong><div class="segmented"><button type="button" data-action="eff-timeframe" data-symbol="${symbol}" data-value="M1" aria-pressed="${timeframe==="M1"}">1M</button><button type="button" data-action="eff-timeframe" data-symbol="${symbol}" data-value="M5" aria-pressed="${timeframe==="M5"}">5M</button></div></div>${renderEfficiencyChart({symbol,timeframe,points:rows,directionTimeline:timeline,freshness})}</div>`;
}

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

function details(row,history=[]){
  const pct=value=>num(value)===null?null:num(value)*100;
  const pairs=[["Raw LPPC 1M",row.score_1m],["1M percentile",pct(row.percentile_1m)],["1M threshold",row.threshold_1m],["Raw LPPC 5M",row.score_5m],["5M percentile",pct(row.percentile_5m)],["5M threshold",row.threshold_5m],["ATR trail",row.atr_trail],["Trend extreme",row.trend_extreme],["PB/EXT raw",row.pullback_value],["1M efficiency",row.efficiency_1m],["5M efficiency",row.efficiency_5m],["Support",row.dynamic_support],["Resistance",row.dynamic_resistance],["PDH",row.pdh],["PDL",row.pdl],["PWH",row.pwh],["PWL",row.pwl]];
  return `<details class="lppc-details"><summary>Details &amp; audit</summary><div class="lppc-detail-grid">${pairs.map(([label,value])=>`<div><small>${label}</small><strong>${fixed(value,3)}</strong></div>`).join("")}</div><p>Event ${esc(row.event_id||"—")} · start ${time(row.event_started_at)} · last qualifying ${time(row.last_qualifying_at)}</p><p>1M ${time(row.lppc_as_of_1m)} · 5M ${time(row.lppc_as_of_5m)} · levels ${time(row.levels_as_of)} · gamma ${time(row.gamma_source_as_of)}</p><p>Fib ${esc(JSON.stringify(row.fib_levels||{}))}</p><ul>${history.slice(-8).map(item=>`<li>${time(item.recorded_at)} · ${esc(item.transition)} · ${esc(item.telegram_delivery_status||"NOT_APPLICABLE")}</li>`).join("")||"<li>No event history.</li>"}</ul></details>`;
}

export function renderHome(model,ui){
  const byState=new Map((model.lppc||[]).map(row=>[row.symbol,row])),gamma=new Map((model.gamma||[]).map(row=>[row.symbol,row]));
  return `<div class="lppc-home">${ORDER.map(symbol=>{const row=byState.get(symbol)||{symbol,source_status:"UNAVAILABLE",event_state:"QUIET"};const frame=ui.efficiencyTimeframes[symbol]||"M1";const levels={dynamic_support:row.dynamic_support,dynamic_resistance:row.dynamic_resistance,pdh:row.pdh,pdl:row.pdl,pwh:row.pwh,pwl:row.pwl};return `<section class="panel lppc-workstation" data-symbol="${symbol}">${stateTop(row)}<div class="lppc-main-grid">${efficiencyChart(symbol,model.efficiency||[],frame,row)}<div class="lppc-gamma"><strong>Gamma + market levels</strong>${renderCompactGamma(gamma.get(symbol),levels)}</div></div>${details(row,(model.eventHistory||[]).filter(item=>item.symbol===symbol))}</section>`;}).join("")}</div>`;
}

export function renderPage(model,ui){
  if(ui.page==="home")return renderHome(model,ui);
  if(ui.page==="options-analysis")return renderOptionsAnalysis(model.gamma||[],ui.optionsSymbol,Date.now(),model.gammaState||"READY",ui.optionsZoom);
  return renderOptionChain(model,ui);
}
