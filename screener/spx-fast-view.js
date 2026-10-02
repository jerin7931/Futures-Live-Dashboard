const esc=value=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
const num=value=>value===null||value===undefined||!Number.isFinite(Number(value))?null:Number(value);
const fixed=(value,places=2)=>num(value)===null?"—":Number(value).toLocaleString("en-US",{minimumFractionDigits:places,maximumFractionDigits:places});
const time=value=>Number.isFinite(Date.parse(value||""))?new Date(value).toLocaleString("en-US",{dateStyle:"short",timeStyle:"short",timeZone:"America/Chicago"}):"—";
const age=value=>num(value?.age_seconds)===null?"N/A":Number(value.age_seconds)<90?`${Math.round(Number(value.age_seconds))}s`:`${fixed(Number(value.age_seconds)/60,1)}m`;
const text=value=>value===null||value===undefined||value===""?"—":esc(value);
const zone=value=>value&&[value.lower,value.upper].some(item=>num(item)!==null)?`${fixed(value.lower)} – ${fixed(value.upper)} ${text(value.coordinate_space)}`:"—";
const metric=(label,value,cls="")=>`<div><small>${esc(label)}</small><strong class="${cls}">${value}</strong></div>`;

function warningPanel(warnings=[]){
  if(!warnings.length)return "";
  return `<section class="panel fast-warning"><div class="panel-title"><div><span class="eyebrow">SOURCE WARNINGS</span><h2>Degraded inputs remain visible</h2></div></div><div class="fast-flags">${warnings.map(item=>`<span class="badge stale">${text(item)}</span>`).join("")}</div></section>`;
}

function currentEs(es={}){
  const row=es.latest||{};
  return `<section class="panel"><div class="panel-title"><div><span class="eyebrow">CURRENT ES · 5-MINUTE</span><h2>${fixed(row.close)} · ${text(row.primary_state)}</h2></div><span>${time(row.time)}</span></div><div class="fast-metrics">${metric("Phase",text(row.phase))}${metric("Context",text(row.context))}${metric("DI control",`${text(row.di_control_direction)} · ${fixed(row.di_dominance,1)}`)}${metric("ADX",fixed(row.adx,1))}${metric("CHOP",fixed(row.chop,1))}${metric("EMA9 / EMA21",`${fixed(row.ema9)} / ${fixed(row.ema21)}`)}${metric("Control trend",text(row.control_trend))}${metric("Votes",`${fixed(row.strengthening_votes,0)} strengthening / ${fixed(row.deterioration_votes,0)} deterioration`)}</div></section>`;
}

function currentEs15m(es={}){
  const row=es.latest||{};
  return `<section class="panel"><div class="panel-title"><div><span class="eyebrow">CURRENT ES · 15-MINUTE CONTEXT</span><h2>${fixed(row.close)} · ${text(row.primary_state)}</h2></div><span>${time(row.time)}</span></div><div class="fast-metrics">${metric("Phase",text(row.phase))}${metric("Context",text(row.context))}${metric("DI control",`${text(row.di_control_direction)} · ${fixed(row.di_dominance,1)}`)}${metric("ADX",fixed(row.adx,1))}${metric("CHOP",fixed(row.chop,1))}${metric("EMA9 / EMA21",`${fixed(row.ema9)} / ${fixed(row.ema21)}`)}${metric("Control trend",text(row.control_trend))}${metric("Votes",`${fixed(row.strengthening_votes,0)} strengthening / ${fixed(row.deterioration_votes,0)} deterioration`)}</div></section>`;
}

function structure(data={}){
  const transitions=data.transition_events||{},roles=data.persistent_role_state||{},conversion=data.conversion||{};
  const active=Object.entries(transitions).filter(([,value])=>value===true).map(([name])=>`<span class="badge amber">${esc(name.replaceAll("_"," "))}</span>`).join("")||'<span class="muted">No current transition event</span>';
  return `<section class="panel"><div class="panel-title"><div><span class="eyebrow">STRUCTURE · EXPLICIT COORDINATES</span><h2>${text(conversion.conversion_mode||"UNKNOWN")} conversion</h2></div></div><div class="fast-metrics">${metric("Native ES support",zone(data.native_es_support_zone))}${metric("Native ES resistance",zone(data.native_es_resistance_zone))}${metric("Native SPX support",zone(data.native_spx_support_zone))}${metric("Native SPX resistance",zone(data.native_spx_resistance_zone))}${metric("Converted SPX support (ES)",zone(data.converted_spx_support_zone_es))}${metric("Converted SPX resistance (ES)",zone(data.converted_spx_resistance_zone_es))}${metric("SPX support role state",roles.spx_support_is_resistance?"RESISTANCE":"SUPPORT")}${metric("SPX resistance role state",roles.spx_resistance_is_support?"SUPPORT":"RESISTANCE")}</div><div class="fast-flags">${active}</div></section>`;
}

function structure15m(data={}){
  const transitions=data.transition_events||{},roles=data.persistent_role_state||{};
  const active=Object.entries(transitions).filter(([,value])=>value===true).map(([name])=>`<span class="badge amber">${esc(name.replaceAll("_"," "))}</span>`).join("")||'<span class="muted">No current 15m transition event</span>';
  return `<section class="panel"><div class="panel-title"><div><span class="eyebrow">NATIVE ES CHARTPRIME · 15-MINUTE</span><h2>Higher-timeframe structure</h2></div><span>ES coordinates only</span></div><div class="fast-metrics">${metric("15m ES support",zone(data.native_es_support_zone))}${metric("15m ES resistance",zone(data.native_es_resistance_zone))}${metric("Support role",roles.support_is_resistance?"RESISTANCE":"SUPPORT")}${metric("Resistance role",roles.resistance_is_support?"SUPPORT":"RESISTANCE")}</div><div class="fast-flags">${active}</div></section>`;
}

function spx(data={}){
  const rows=(data.recent_completed_5m_bars||[]).map(row=>`<tr><td>${time(row.time)}</td><td>${fixed(row.open)}</td><td>${fixed(row.high)}</td><td>${fixed(row.low)}</td><td>${fixed(row.close)}</td></tr>`).join("");
  return `<section class="panel fast-wide"><div class="panel-title"><div><span class="eyebrow">DIRECT SPX · TRADINGVIEW</span><h2>${data.direct_spx_available?fixed(data.current_reference):"N/A"}</h2></div><span class="badge ${data.direct_spx_available?"live":"unavailable"}">${data.direct_spx_available?"DIRECT":"DIRECT UNAVAILABLE"}</span></div><p class="muted">${text(data.source)} · ${text(data.source_status)} · ${time(data.timestamp)}</p><div class="fast-table-wrap"><table class="fast-table"><thead><tr><th>Completed</th><th>Open</th><th>High</th><th>Low</th><th>Close</th></tr></thead><tbody>${rows||'<tr><td colspan="5">No direct TradingView SPX bars available. SPY proxy is not substituted.</td></tr>'}</tbody></table></div></section>`;
}

function gamma(data={}){
  return `<section class="panel"><div class="panel-title"><div><span class="eyebrow">SPX GAMMA · INSIDERFINANCE</span><h2>${text(data.gamma_regime)}</h2></div><span class="badge ${data.status==="CURRENT"?"live":"stale"}">${text(data.status)}</span></div><div class="fast-metrics">${metric("Spot",fixed(data.spot))}${metric("Flip",fixed(data.gamma_flip))}${metric("Call wall",fixed(data.call_wall))}${metric("Put wall",fixed(data.put_wall))}${metric("Magnet",fixed(data.gamma_magnet))}${metric("Net / Gross GEX",`${fixed(data.net_gex,0)} / ${fixed(data.gross_gex,0)}`)}${metric("Nearby strikes",fixed(data.nearby_strikes?.length,0))}${metric("Age",num(data.age_seconds)===null?"N/A":`${fixed(Number(data.age_seconds)/60,1)}m`)}</div></section>`;
}

function footprint(data={}){
  const rows=(data.recent_completed_5m||[]).map(row=>`<tr><td>${time(row.time)}</td><td>${fixed(row.close)}</td><td class="${num(row.delta)>0?"positive":num(row.delta)<0?"negative":""}">${fixed(row.delta,0)}</td><td>${fixed(row.delta_pct,1)}%</td><td>${fixed(row.poc_low)} – ${fixed(row.poc_high)}</td><td>${fixed(row.vah)}</td><td>${fixed(row.val)}</td><td>${fixed(row.buy_imbalance_count,0)} / ${fixed(row.sell_imbalance_count,0)}</td><td>${row.buy_stack_present?"BUY ":""}${row.sell_stack_present?"SELL":""}${!row.buy_stack_present&&!row.sell_stack_present?"—":""}</td></tr>`).join("");
  return `<section class="panel fast-wide"><div class="panel-title"><div><span class="eyebrow">ES FOOTPRINT SEQUENCE</span><h2>Last ${data.recent_completed_5m?.length||0} completed bars</h2></div><span>Stack threshold ${fixed(data.stacked_levels,0)}</span></div><div class="fast-table-wrap"><table class="fast-table"><thead><tr><th>Close time</th><th>Close</th><th>Delta</th><th>Delta %</th><th>POC</th><th>VAH</th><th>VAL</th><th>Buy / Sell imbalances</th><th>Qualified stack</th></tr></thead><tbody>${rows||'<tr><td colspan="9">No footprint summaries available.</td></tr>'}</tbody></table></div></section>`;
}

function events(data={}){
  const active=Object.entries(data).filter(([,value])=>value===true).map(([name])=>`<li>${esc(name.replaceAll("_"," "))}</li>`).join("");
  return `<section class="panel"><div class="panel-title"><div><span class="eyebrow">DETERMINISTIC EVENTS</span><h2>Current state changes</h2></div></div><ul class="fast-event-list">${active||'<li class="muted">No true event flags</li>'}</ul></section>`;
}

function options(data={}){
  const table=(label,rows=[])=>`<div><h3>${label} · ${rows.length}</h3><div class="fast-table-wrap"><table class="fast-table"><thead><tr><th>Expiry</th><th>Symbol / Strike</th><th>Bid / Ask</th><th>Premium</th><th>Delta</th><th>Spread %</th><th>Quote age</th></tr></thead><tbody>${rows.map(row=>`<tr><td>${text(row.expiration)}</td><td>${text(row.option_symbol)} · ${fixed(row.strike,0)}</td><td>${fixed(row.bid)} / ${fixed(row.ask)}</td><td>${fixed(row.premium_reference)}</td><td>${fixed(row.delta,3)}</td><td>${num(row.spread_pct)===null?"—":`${fixed(Number(row.spread_pct)*100,1)}%`}</td><td class="${row.quote_stale?"negative":""}">${num(row.quote_age_seconds)===null?"N/A":`${fixed(Number(row.quote_age_seconds)/60,1)}m`}</td></tr>`).join("")||'<tr><td colspan="7">No usable candidates strictly below $4.00</td></tr>'}</tbody></table></div></div>`;
  return `<section class="panel fast-wide"><div class="panel-title"><div><span class="eyebrow">SPX OPTIONS · COMPARISON INPUT</span><h2>Premium strictly below $4.00</h2></div><span>Maximum ${fixed(data.candidate_cap_per_side,0)} per side · newest ${time(data.latest_quote_timestamp)}</span></div><div class="fast-options">${table("Calls",data.calls)}${table("Puts",data.puts)}</div></section>`;
}

function freshness(data={}){
  return `<section class="panel"><div class="panel-title"><div><span class="eyebrow">FRESHNESS</span><h2>Source ages</h2></div></div><div class="fast-metrics">${metric("ES state · 5m",age(data.es_state))}${metric("ES state · 15m",age(data.es_state_15m))}${metric("Footprint",age(data.footprint))}${metric("SPX market",age(data.spx_market))}${metric("SPX options",age(data.spx_options))}${metric("SPX gamma",age(data.spx_gamma))}</div></section>`;
}

export function renderSpxFastState(state){
  if(!state)return '<section class="panel ai-empty"><h2>Fast state unavailable</h2><p>The authenticated read-only RPC has not returned a payload.</p></section>';
  return `<div class="spx-fast"><section class="fast-heading"><div><span class="eyebrow">GROK · 5-MINUTE EXECUTION + 15-MINUTE CONTEXT</span><h1>FAST STATE</h1><p>Authenticated, owner-scoped market data. Grok forms the market thesis independently: 15m state provides higher-timeframe regime and native ES ChartPrime structure; 5m state and footprint provide execution context.</p></div><strong>${time(state.generated_at)} · ${text(state.session_phase)}</strong></section>${warningPanel(state.warnings)}<div class="fast-grid">${currentEs15m(state.es_15m)}${structure15m(state.structure_15m)}${currentEs(state.es)}${structure(state.structure_5m||state.structure)}${gamma(state.gamma)}${events(state.events)}${freshness(state.freshness)}</div>${spx(state.spx)}${footprint(state.footprint)}${options(state.options)}<section class="panel fast-json"><div class="panel-title"><div><span class="eyebrow">MACHINE-READABLE</span><h2>FAST_STATE_JSON</h2></div><span>${text(state.schema_version)} · exact authenticated RPC response</span></div><pre>${esc(JSON.stringify(state,null,2))}</pre></section></div>`;
}
