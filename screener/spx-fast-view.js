const esc=value=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
const num=value=>value===null||value===undefined||!Number.isFinite(Number(value))?null:Number(value);
const fixed=(value,places=2)=>num(value)===null?"—":Number(value).toLocaleString("en-US",{minimumFractionDigits:places,maximumFractionDigits:places});
const time=value=>Number.isFinite(Date.parse(value||""))?new Date(value).toLocaleString("en-US",{dateStyle:"short",timeStyle:"short",timeZone:"America/Chicago"}):"—";
const age=value=>num(value?.seconds)===null?"N/A":Number(value.seconds)<90?`${Math.round(Number(value.seconds))}s`:`${fixed(Number(value.seconds)/60,1)}m`;
const text=value=>value===null||value===undefined||value===""?"—":esc(value);
const zone=value=>Array.isArray(value)&&value.some(item=>num(item)!==null)?value.map(item=>fixed(item)).join(" – "):"—";
const metric=(label,value,cls="")=>`<div><small>${esc(label)}</small><strong class="${cls}">${value}</strong></div>`;

function baseline(ai={}){
  const contract=ai.option_type?`${text(ai.option_type)} · ${text(ai.expiration)} · ${fixed(ai.strike,0)}`:"No contract";
  return `<section class="panel fast-baseline"><header><div><span class="eyebrow">LAST CHATGPT ANALYSIS · AUTHORITATIVE 15-MINUTE SYSTEM</span><h2>${text(ai.decision||"AWAITING")}</h2></div><strong>${time(ai.analysis_at)}</strong></header><p>${text(ai.concise_summary||"No SPX_AI baseline is available.")}</p><div class="fast-metrics">${metric("Bias",text(ai.bias))}${metric("Market state",text(ai.market_state))}${metric("Confidence",num(ai.confidence)===null?"—":`${fixed(Number(ai.confidence)*100,0)}%`)}${metric("Contract",contract)}${metric("Target",text(ai.target))}${metric("Invalidation",text(ai.invalidation))}</div><div class="fast-plan"><small>Entry condition</small><strong>${text(ai.entry_condition)}</strong></div></section>`;
}

function currentEs(es={}){
  return `<section class="panel"><div class="panel-title"><div><span class="eyebrow">CURRENT ES</span><h2>${fixed(es.price)} · ${text(es.primary_state)}</h2></div><span>${time(es.bar_close_at)}</span></div><div class="fast-metrics">${metric("Phase",text(es.phase))}${metric("Context",text(es.context))}${metric("DI control",`${text(es.di_control_direction)} · ${fixed(es.di_dominance,1)}`)}${metric("ADX",fixed(es.adx,1))}${metric("CHOP",fixed(es.chop,1))}${metric("EMA9 / EMA21",`${fixed(es.ema9)} / ${fixed(es.ema21)}`)}${metric("Control trend",text(es.control_trend))}${metric("Votes",`${fixed(es.strengthening_votes,0)} strengthening / ${fixed(es.deterioration_votes,0)} deterioration`)}</div></section>`;
}

function structure(data={}){
  const native=data.native_chartprime||{},converted=data.converted_spx_chartprime||{};
  const flags={ES_support_break:native.support_break,ES_resistance_break:native.resistance_break,ES_support_hold:native.support_hold,ES_resistance_hold:native.resistance_hold,SPX_support_break:converted.support_break,SPX_resistance_break:converted.resistance_break,SPX_support_hold:converted.support_hold,SPX_resistance_hold:converted.resistance_hold,SPX_support_role_flip:converted.sup_is_res,SPX_resistance_role_flip:converted.res_is_sup};
  const active=Object.entries(flags).filter(([,value])=>value===true).map(([name])=>`<span class="badge amber">${esc(name.replaceAll("_"," "))}</span>`).join("")||'<span class="muted">No active structure event</span>';
  return `<section class="panel"><div class="panel-title"><div><span class="eyebrow">STRUCTURE</span><h2>${text(data.conversion_mode||"UNKNOWN")} conversion</h2></div></div><div class="fast-metrics">${metric("ES support",zone(data.es_support_zone))}${metric("ES resistance",zone(data.es_resistance_zone))}${metric("Converted SPX support",zone(data.spx_support_zone))}${metric("Converted SPX resistance",zone(data.spx_resistance_zone))}</div><div class="fast-flags">${active}</div></section>`;
}

function spx(data={}){
  const rows=(data.recent_bars||[]).map(row=>`<tr><td>${time(row.bar_time)}</td><td>${fixed(row.open)}</td><td>${fixed(row.high)}</td><td>${fixed(row.low)}</td><td>${fixed(row.close)}</td></tr>`).join("");
  return `<section class="panel"><div class="panel-title"><div><span class="eyebrow">DIRECT SPX</span><h2>${data.direct_spx_available?fixed(data.price):"N/A"}</h2></div><span class="badge ${data.direct_spx_available?"live":"unavailable"}">${data.direct_spx_available?"DIRECT":"DIRECT UNAVAILABLE"}</span></div><p class="muted">${text(data.source)} · ${text(data.source_status)} · ${time(data.source_timestamp)}</p><div class="fast-table-wrap"><table class="fast-table"><thead><tr><th>Completed</th><th>Open</th><th>High</th><th>Low</th><th>Close</th></tr></thead><tbody>${rows||'<tr><td colspan="5">No direct TradingView SPX bars available. SPY proxy is not substituted.</td></tr>'}</tbody></table></div></section>`;
}

function gamma(data={}){
  return `<section class="panel"><div class="panel-title"><div><span class="eyebrow">SPX GAMMA · INSIDERFINANCE</span><h2>${text(data.gamma_regime)}</h2></div><span class="badge ${data.status==="CURRENT"?"live":"stale"}">${text(data.status)}</span></div><div class="fast-metrics">${metric("Spot",fixed(data.spot))}${metric("Flip",fixed(data.gamma_flip))}${metric("Call wall",fixed(data.call_wall))}${metric("Put wall",fixed(data.put_wall))}${metric("Magnet",fixed(data.gamma_magnet))}${metric("Net GEX",fixed(data.net_gex,0))}${metric("Age",num(data.age_minutes)===null?"N/A":`${fixed(data.age_minutes,1)}m`)}</div></section>`;
}

function footprint(data={}){
  const rows=(data.recent||[]).map(row=>`<tr><td>${time(row.bar_close_at)}</td><td>${fixed(row.close)}</td><td class="${num(row.delta)>0?"positive":num(row.delta)<0?"negative":""}">${fixed(row.delta,0)}</td><td>${fixed(row.delta_pct,1)}%</td><td>${zone(row.poc)}</td><td>${fixed(row.vah)}</td><td>${fixed(row.val)}</td><td>${fixed(row.buy_imbalance_count,0)} / ${fixed(row.sell_imbalance_count,0)}</td><td>${fixed(row.max_buy_stack,0)} / ${fixed(row.max_sell_stack,0)}</td></tr>`).join("");
  return `<section class="panel fast-wide"><div class="panel-title"><div><span class="eyebrow">FOOTPRINT</span><h2>Last four completed ES bars</h2></div></div><div class="fast-table-wrap"><table class="fast-table"><thead><tr><th>Close time</th><th>Close</th><th>Delta</th><th>Delta %</th><th>POC</th><th>VAH</th><th>VAL</th><th>Buy / Sell imbalances</th><th>Max buy / sell stacks</th></tr></thead><tbody>${rows||'<tr><td colspan="9">No footprint summaries available.</td></tr>'}</tbody></table></div></section>`;
}

function events(data={}){
  const active=Object.entries(data).filter(([,value])=>value===true).map(([name])=>`<li>${esc(name.replaceAll("_"," "))}</li>`).join("");
  return `<section class="panel"><div class="panel-title"><div><span class="eyebrow">FAST EVENTS</span><h2>Current deterministic flags</h2></div></div><ul class="fast-event-list">${active||"<li class=\"muted\">No true event flags</li>"}</ul></section>`;
}

function options(data={}){
  const table=(label,rows=[])=>`<div><h3>${label}</h3><div class="fast-table-wrap"><table class="fast-table"><thead><tr><th>Expiry</th><th>Strike</th><th>Bid / Ask</th><th>Mark</th><th>Delta</th><th>Spread</th><th>Quote age</th></tr></thead><tbody>${rows.map(row=>`<tr><td>${text(row.expiration)}</td><td>${fixed(row.strike,0)}</td><td>${fixed(row.bid)} / ${fixed(row.ask)}</td><td>${fixed(row.mark)}</td><td>${fixed(row.delta,3)}</td><td>${fixed(row.spread)}</td><td>${num(row.source_age_seconds)===null?"N/A":`${fixed(Number(row.source_age_seconds)/60,1)}m`}</td></tr>`).join("")||'<tr><td colspan="7">No current candidates</td></tr>'}</tbody></table></div></div>`;
  return `<section class="panel fast-wide"><div class="panel-title"><div><span class="eyebrow">OPTIONS</span><h2>Bounded near-market candidate set</h2></div><span>Maximum 5 calls + 5 puts</span></div><div class="fast-options">${table("Calls",data.calls)}${table("Puts",data.puts)}</div></section>`;
}

function freshness(data={}){
  return `<section class="panel"><div class="panel-title"><div><span class="eyebrow">FRESHNESS</span><h2>Source ages</h2></div></div><div class="fast-metrics">${metric("Baseline AI",age(data.baseline_ai))}${metric("ES state",age(data.es_state))}${metric("Footprint",age(data.footprint))}${metric("SPX market",age(data.spx_market))}${metric("SPX options",age(data.spx_options))}${metric("SPX gamma",age(data.spx_gamma))}</div></section>`;
}

export function renderSpxFastState(state){
  if(!state)return '<section class="panel ai-empty"><h2>Fast state unavailable</h2><p>The authenticated read-only RPC has not returned a payload.</p></section>';
  return `<div class="spx-fast"><section class="fast-heading"><div><span class="eyebrow">GROK BOT · READ-ONLY MONITORING SURFACE</span><h1>FAST STATE</h1><p>Compact current-state synthesis. ChatGPT SPX_AI remains the authoritative 15-minute analysis.</p></div><strong>${time(state.generated_at)}</strong></section>${baseline(state.baseline_ai)}<div class="fast-grid">${currentEs(state.es)}${structure(state.structure)}${spx(state.spx)}${gamma(state.gamma)}${events(state.events)}${freshness(state.freshness)}</div>${footprint(state.footprint)}${options(state.options)}<section class="panel fast-json"><div class="panel-title"><div><span class="eyebrow">MACHINE-READABLE</span><h2>FAST_STATE_JSON</h2></div><span>Exact authenticated RPC response</span></div><pre>${esc(JSON.stringify(state,null,2))}</pre></section></div>`;
}
