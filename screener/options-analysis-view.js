const SYMBOLS=["SPX","SPY","QQQ","IWM"];
const esc=value=>String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[char]));
const number=value=>typeof value==="number"&&Number.isFinite(value)?value:null;
const fixed=(value,places=2)=>number(value)===null?"—":Number(value).toLocaleString("en-US",{minimumFractionDigits:places,maximumFractionDigits:places});
const compact=value=>{if(number(value)===null)return "—";const n=Math.abs(value),unit=n>=1e9?"B":n>=1e6?"M":n>=1e3?"K":"",scale=unit==="B"?1e9:unit==="M"?1e6:unit==="K"?1e3:1;return `${value<0?"−":""}$${fixed(n/scale,n/scale>=100?0:1)}${unit}`;};
const time=value=>{const n=Date.parse(value||"");return Number.isFinite(n)?new Date(n).toLocaleString("en-US",{dateStyle:"short",timeStyle:"short"}):"—";};
export function optionsFreshness(row,now=Date.now()){
  if(!row)return "UNAVAILABLE";
  if(["OFF_SESSION","NO_0DTE_DATA","SOURCE_STALE"].includes(row.status))return row.status;
  if(row.payload?.source_is_stale)return "SOURCE_STALE";
  const age=(now-Date.parse(row.source_as_of||""))/1000;
  if(!Number.isFinite(age)||age<0)return "STALE";
  return age<=150?"CURRENT":age<=300?"AGED":"STALE";
}
function chart(payload){
  const rows=(payload.strike_profile||[]).filter(row=>number(row.strike)!==null&&number(row.call_gex)!==null&&number(row.put_gex)!==null);
  if(!rows.length)return `<p class="empty">No qualified 0DTE strike profile.</p>`;
  const width=900,height=320,left=42,right=20,top=20,bottom=48,mid=150,usable=width-left-right;
  const max=Math.max(1,...rows.flatMap(row=>[Math.abs(row.call_gex),Math.abs(row.put_gex)]));
  const bar=Math.max(2,Math.min(12,usable/rows.length*.33));
  const x=index=>left+(index+.5)*usable/rows.length;
  const bars=rows.map((row,index)=>{const px=x(index),ch=Math.abs(row.call_gex)/max*105,ph=Math.abs(row.put_gex)/max*105;
    return `<g><title>Strike ${fixed(row.strike,0)} · Call ${compact(row.call_gex)} · Put ${compact(row.put_gex)} · Net ${compact(row.net_gex)}</title><rect x="${(px-bar).toFixed(2)}" y="${(mid-ch).toFixed(2)}" width="${bar}" height="${ch.toFixed(2)}" fill="#47b78c"/><rect x="${px.toFixed(2)}" y="${mid}" width="${bar}" height="${ph.toFixed(2)}" fill="#e06273"/></g>`;}).join("");
  const low=rows[0].strike,high=rows.at(-1).strike;
  const marker=(level,label,color,dash="4 4")=>{if(number(level)===null||level<low||level>high||low===high)return "";const px=left+(level-low)/(high-low)*usable;return `<g><line x1="${px.toFixed(2)}" x2="${px.toFixed(2)}" y1="${top}" y2="${height-bottom}" stroke="${color}" stroke-width="1.5" stroke-dasharray="${dash}"/><text x="${px.toFixed(2)}" y="${top-5}" text-anchor="middle" fill="${color}" font-size="10">${esc(label)}</text></g>`;};
  const s=payload.summary||{};
  const labels=rows.filter((_,i)=>i===0||i===rows.length-1||i%Math.max(1,Math.ceil(rows.length/8))===0).map(row=>{const px=left+(row.strike-low)/(high-low)*usable;return `<text x="${px.toFixed(2)}" y="${height-18}" text-anchor="middle" fill="currentColor" font-size="10">${fixed(row.strike,0)}</text>`;}).join("");
  return `<div class="gamma-chart-scroll"><svg class="gamma-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="0DTE call and put gamma proxy by strike"><line x1="${left}" x2="${width-right}" y1="${mid}" y2="${mid}" stroke="currentColor" opacity=".5"/>${bars}${marker(payload.spot,"Spot","#5b83f7","3 3")}${marker(s.call_wall,"Call wall","#47b78c")}${marker(s.put_wall,"Put wall","#e06273")}${s.zero_gamma_status==="CURRENT"?marker(s.zero_gamma,"Gamma flip","#d2a450"):""}${marker(s.gamma_magnet,"Magnet","#9987db")}${labels}</svg></div><div class="gamma-legend"><span class="gamma-call">● Call GEX</span><span class="gamma-put">● Put GEX</span><span>Dashed lines: current spot / structural levels</span></div>`;
}
function analysis(payload){const a=payload.analysis||{},s=payload.summary||{};const signal=(payload.signals||[]).map(item=>`<article><div><strong>${esc(item.type?.replaceAll("_"," "))}</strong><span class="badge">${esc(item.strength)}</span></div><p>${esc(item.description)}</p>${number(item.level)!==null?`<small>@ ${fixed(item.level)} · ${fixed(item.distance_pct)}% from spot</small>`:""}</article>`).join("");
  const levels=[["Current Price",payload.spot],["Gamma Flip",s.zero_gamma_status==="CURRENT"?s.zero_gamma:null],["Call Wall",s.call_wall],["Put Wall",s.put_wall],["Gamma Magnet",s.gamma_magnet]].map(([name,value])=>`<div><span>${name}</span><strong>${fixed(value)}</strong></div>`).join("");
  return `<aside class="panel gamma-analysis"><h2>Signals</h2><div class="gamma-signals">${signal||"—"}</div><h2>Setup</h2><strong>${esc(a.setup_state||"Unavailable")}</strong><h3>Key levels</h3><div class="gamma-levels">${levels}</div><h3>Setup analysis</h3><ul>${(a.setup_analysis||[]).map(v=>`<li>${esc(v)}</li>`).join("")}</ul><h3>For stronger setup</h3><ul>${(a.stronger_setup_conditions||[]).map(v=>`<li>${esc(v)}</li>`).join("")}</ul><h3>Trading implication</h3><p>${esc(a.trading_implication||"—")}</p><h3>Alternate setup</h3><p>${esc(a.alternate_setup||"—")}</p></aside>`;
}
export function renderOptionsAnalysis(rows=[],selected="SPX",now=Date.now(),state="READY"){
  const bySymbol=new Map(rows.map(row=>[row.symbol,row]));const chosen=SYMBOLS.includes(selected)?selected:"SPX";
  const tabs=SYMBOLS.map(symbol=>{const row=bySymbol.get(symbol),s=row?.payload?.summary||{};return `<button type="button" class="gamma-symbol ${chosen===symbol?"active":""}" data-action="select-options-symbol" data-symbol="${symbol}" aria-pressed="${chosen===symbol}"><strong>${symbol}</strong><small>${esc(s.gamma_regime||"UNAVAILABLE")}</small><span>${fixed(row?.spot)}</span><small>Net ${compact(s.net_gex)} · Flip ${fixed(s.zero_gamma_status==="CURRENT"?s.zero_gamma:null)}</small><em>${esc(optionsFreshness(row,now))}</em></button>`;}).join("");
  const row=bySymbol.get(chosen),p=row?.payload,s=p?.summary||{};
  const metrics=[["Spot Price",fixed(p?.spot)],["Net GEX",compact(s.net_gex)],["Call GEX",compact(s.call_gex)],["Put GEX",compact(s.put_gex)],["Gross GEX",compact(s.gross_gex)],["Gamma Flip",s.zero_gamma_status==="CURRENT"?fixed(s.zero_gamma):esc(s.zero_gamma_status||"—")],["Call Wall",fixed(s.call_wall)],["Put Wall",fixed(s.put_wall)],["Gamma Magnet",fixed(s.gamma_magnet)]].map(([name,value])=>`<div><small>${name}</small><strong>${value}</strong></div>`).join("");
  return `<div class="options-analysis-page"><header class="panel gamma-head"><div><span class="eyebrow">0DTE GAMMA STRUCTURE</span><h2>Options Analysis</h2><p>OI-based exposure proxy · not verified dealer positioning or a trade signal.</p></div><div><strong>${esc(optionsFreshness(row,now))}</strong><small>Source updated ${time(row?.source_as_of)}</small></div></header><div class="gamma-symbols">${tabs}</div>${state!=="READY"?`<p class="capacity-warning">Options Analysis storage unavailable; previously loaded values, if any, must not be treated as current.</p>`:""}${p?`<section class="panel gamma-metrics">${metrics}</section><div class="gamma-layout"><section class="panel gamma-chart-panel"><div class="panel-title"><h2>${chosen} · 0DTE Strike Profile</h2><span>${p.coverage?.distinct_strike_count??0} strikes · ${p.coverage?.contract_count??0} contracts</span></div>${chart(p)}</section>${analysis(p)}</div>`:`<section class="panel empty-state"><strong>No current ${chosen} analysis is published.</strong><p>The independent source worker has not provided a usable snapshot.</p></section>`}</div>`;
}
