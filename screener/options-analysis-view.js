const SYMBOLS=["SPX","SPY","QQQ","IWM"];
const esc=value=>String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[char]));
const number=value=>typeof value==="number"&&Number.isFinite(value)?value:null;
const fixed=(value,places=2)=>number(value)===null?"—":Number(value).toLocaleString("en-US",{minimumFractionDigits:places,maximumFractionDigits:places});
const compact=value=>{if(number(value)===null)return "—";const n=Math.abs(value),unit=n>=1e9?"B":n>=1e6?"M":n>=1e3?"K":"",scale=unit==="B"?1e9:unit==="M"?1e6:unit==="K"?1e3:1;return `${value<0?"−":""}$${fixed(n/scale,n/scale>=100?0:1)}${unit}`;};
const time=value=>{const n=Date.parse(value||"");return Number.isFinite(n)?new Date(n).toLocaleString("en-US",{dateStyle:"short",timeStyle:"short"}):"—";};
// Older current-state rows can outlive a website deployment. Keep their visible copy current.
const gammaCopy=value=>String(value??"").replace(/OI[- ]gamma proxy/gi,"gamma exposure").replace(/OI[- ]based structural proxy/gi,"gamma structure").replace(/OI[- ]based exposure proxy/gi,"gamma exposure").replace(/OI proxy/gi,"gamma exposure").replace(/OI[- ]gamma/gi,"gamma");
export function optionsFreshness(row,now=Date.now()){
  if(!row)return "UNAVAILABLE";
  if(["OFF_SESSION","NO_0DTE_DATA","SOURCE_STALE"].includes(row.status))return row.status;
  if(row.payload?.source_is_stale)return "SOURCE_STALE";
  const age=(now-Date.parse(row.source_as_of||""))/1000;
  if(!Number.isFinite(age)||age<0)return "STALE";
  return age<=150?"CURRENT":age<=300?"AGED":"STALE";
}
function chart(payload){
  const rows=(payload.strike_profile||[]).filter(row=>number(row.strike)!==null&&number(row.net_gex)!==null).sort((a,b)=>a.strike-b.strike);
  if(!rows.length)return `<p class="empty">No qualified 0DTE strike profile.</p>`;
  const width=900,height=340,left=62,right=24,top=28,bottom=48,mid=170,extent=112,usable=width-left-right;
  const max=Math.max(1,...rows.map(row=>Math.abs(row.net_gex)));
  const low=rows[0].strike,high=rows.at(-1).strike,span=Math.max(1,high-low);
  const x=strike=>left+(strike-low)/span*usable;
  const bar=Math.max(2,Math.min(12,usable/(rows.length*1.7)));
  const s=payload.summary||{};
  const isWall=(strike,level)=>number(level)!==null&&Math.abs(strike-level)<1e-8;
  const bars=rows.map(row=>{const px=x(row.strike),value=row.net_gex,magnitude=Math.abs(value)/max*extent,barHeight=value===0?1:Math.max(1,magnitude),y=value>=0?mid-barHeight:mid;
    const walls=[isWall(row.strike,s.call_wall)?"Call wall":null,isWall(row.strike,s.put_wall)?"Put wall":null].filter(Boolean),outline=walls.length?` class="gamma-wall-outline" data-wall="${walls.join(" + ")}" stroke="#f5f7fb" stroke-width="3"`:"";
    return `<g><title>Strike ${fixed(row.strike,0)} · Net gamma ${compact(value)}${walls.length?` · ${walls.join(" + ")}`:""}</title><rect x="${(px-bar/2).toFixed(2)}" y="${y.toFixed(2)}" width="${bar.toFixed(2)}" height="${barHeight.toFixed(2)}" fill="${value>=0?"#26c983":"#f24567"}"${outline}/></g>`;}).join("");
  const marker=(level,label,color)=>{if(number(level)===null||level<low||level>high)return "";const px=x(level);return `<g><line x1="${px.toFixed(2)}" x2="${px.toFixed(2)}" y1="${top}" y2="${height-bottom}" stroke="${color}" stroke-width="2" stroke-dasharray="3 4"/><text x="${px.toFixed(2)}" y="${top-7}" text-anchor="middle" fill="${color}" font-size="10">${esc(label)}</text></g>`;};
  const labels=rows.filter((_,i)=>i===0||i===rows.length-1||i%Math.max(1,Math.ceil(rows.length/8))===0).map(row=>`<text x="${x(row.strike).toFixed(2)}" y="${height-18}" text-anchor="middle" fill="currentColor" font-size="10">${fixed(row.strike,0)}</text>`).join("");
  const grid=[[-1,mid+extent],[0,mid],[1,mid-extent]].map(([tick,y])=>`<g><line x1="${left}" x2="${width-right}" y1="${y}" y2="${y}" stroke="#434650" stroke-dasharray="${tick?"3 4":"none"}"/><text x="${left-9}" y="${y+4}" text-anchor="end" fill="#9da3b2" font-size="10">${tick?compact(tick*max):"0"}</text></g>`).join("");
  return `<div class="gamma-chart-scroll"><svg class="gamma-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="0DTE net gamma by strike; call and put walls outlined">${grid}${bars}${marker(payload.spot,"Spot","#438cff")}${s.zero_gamma_status==="CURRENT"?marker(s.zero_gamma,"Zero gamma","#d5ab5b"):""}${labels}</svg></div><div class="gamma-legend"><span class="gamma-call">● Positive net gamma</span><span class="gamma-put">● Negative net gamma</span><span class="gamma-wall-key">▣ Call / put wall strike</span><span>Dashed: spot / zero gamma</span></div>`;
}
function analysis(payload){const a=payload.analysis||{},s=payload.summary||{};const signal=(payload.signals||[]).map(item=>{const kind=["VOLATILITY","MAGNET","CALL_WALL","PUT_WALL","GAMMA_FLIP"].includes(item.type)?item.type.toLowerCase().replaceAll("_","-"):"other";const strength=["STRONG","MODERATE","WEAK"].includes(item.strength)?item.strength.toLowerCase():"other";return `<article class="gamma-signal gamma-signal-${kind}"><div><strong>${esc(item.type?.replaceAll("_"," "))}</strong><span class="gamma-strength gamma-strength-${strength}">${esc(item.strength)}</span></div><p>${esc(gammaCopy(item.description))}</p>${number(item.level)!==null?`<small>@ ${fixed(item.level)} · ${fixed(item.distance_pct)}% from spot</small>`:""}</article>`;}).join("");
  const levels=[["Current Price",payload.spot],["Gamma Flip",s.zero_gamma_status==="CURRENT"?s.zero_gamma:null],["Call Wall",s.call_wall],["Put Wall",s.put_wall],["Gamma Magnet",s.gamma_magnet]].map(([name,value])=>`<div><span>${name}</span><strong>${fixed(value)}</strong></div>`).join("");
  return `<aside class="panel gamma-analysis"><h2>Signals</h2><div class="gamma-signals">${signal||"—"}</div><h2>Setup</h2><strong>${esc(a.setup_state||"Unavailable")}</strong><h3>Key levels</h3><div class="gamma-levels">${levels}</div><h3>Setup analysis</h3><ul>${(a.setup_analysis||[]).map(v=>`<li>${esc(gammaCopy(v))}</li>`).join("")}</ul><h3>For stronger setup</h3><ul>${(a.stronger_setup_conditions||[]).map(v=>`<li>${esc(gammaCopy(v))}</li>`).join("")}</ul><h3>Trading implication</h3><p>${esc(gammaCopy(a.trading_implication||"—"))}</p><h3>Alternate setup</h3><p>${esc(gammaCopy(a.alternate_setup||"—"))}</p></aside>`;
}
export function renderOptionsAnalysis(rows=[],selected="SPX",now=Date.now(),state="READY"){
  const bySymbol=new Map(rows.map(row=>[row.symbol,row]));const chosen=SYMBOLS.includes(selected)?selected:"SPX";
  const tabs=SYMBOLS.map(symbol=>{const row=bySymbol.get(symbol),s=row?.payload?.summary||{};return `<button type="button" class="gamma-symbol ${chosen===symbol?"active":""}" data-action="select-options-symbol" data-symbol="${symbol}" aria-pressed="${chosen===symbol}"><strong>${symbol}</strong><small>${esc(s.gamma_regime||"UNAVAILABLE")}</small><span>${fixed(row?.spot)}</span><small>Net ${compact(s.net_gex)} · Flip ${fixed(s.zero_gamma_status==="CURRENT"?s.zero_gamma:null)}</small><em>${esc(optionsFreshness(row,now))}</em></button>`;}).join("");
  const row=bySymbol.get(chosen),p=row?.payload,s=p?.summary||{};
  const metrics=[["Spot Price",fixed(p?.spot),"spot"],["Net GEX",compact(s.net_gex),number(s.net_gex)<0?"negative":"positive"],["Call GEX",compact(s.call_gex),"positive"],["Put GEX",compact(s.put_gex),"negative"],["Gross GEX",compact(s.gross_gex),"blue"],["Gamma Flip",s.zero_gamma_status==="CURRENT"?fixed(s.zero_gamma):esc(s.zero_gamma_status||"—"),"neutral"],["Call Wall",fixed(s.call_wall),"positive"],["Put Wall",fixed(s.put_wall),"negative"],["Gamma Magnet",fixed(s.gamma_magnet),"blue"]].map(([name,value,tone])=>`<div class="gamma-metric gamma-metric-${tone}"><small>${name}</small><strong>${value}</strong></div>`).join("");
  return `<div class="options-analysis-page"><header class="panel gamma-head"><div><span class="eyebrow">0DTE GAMMA STRUCTURE</span><h2>Options Analysis</h2><p>Gamma exposure · not verified dealer positioning or a trade signal.</p></div><div><strong>${esc(optionsFreshness(row,now))}</strong><small>Source updated ${time(row?.source_as_of)}</small></div></header><div class="gamma-symbols">${tabs}</div>${state!=="READY"?`<p class="capacity-warning">Options Analysis storage unavailable; previously loaded values, if any, must not be treated as current.</p>`:""}${p?`<section class="panel gamma-metrics">${metrics}</section><div class="gamma-layout"><section class="panel gamma-chart-panel"><div class="panel-title"><h2>${chosen} · Net Gamma Strike Profile</h2><span>${p.coverage?.distinct_strike_count??0} strikes · ${p.coverage?.contract_count??0} contracts</span></div>${chart(p)}</section>${analysis(p)}</div>`:`<section class="panel empty-state"><strong>No current ${chosen} analysis is published.</strong><p>The independent source worker has not provided a usable snapshot.</p></section>`}</div>`;
}
