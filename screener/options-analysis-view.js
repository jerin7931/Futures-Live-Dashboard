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
const ZOOM_STEPS={TIGHT:10,NEAR:20,WIDE:40};
export function chartWindow(payload,zoom="NEAR"){
  const rows=(payload.strike_profile||[]).filter(row=>number(row.strike)!==null&&number(row.net_gex)!==null).sort((a,b)=>a.strike-b.strike);
  if(!rows.length)return null;
  const spot=number(payload.spot)??rows[Math.floor(rows.length/2)].strike;
  const nearby=[...rows].sort((a,b)=>Math.abs(a.strike-spot)-Math.abs(b.strike-spot)).slice(0,31).sort((a,b)=>a.strike-b.strike);
  const gaps=nearby.slice(1).map((row,i)=>row.strike-nearby[i].strike).filter(gap=>gap>0).sort((a,b)=>a-b);
  const step=gaps.length?gaps[Math.floor(gaps.length/2)]:Math.max(spot*.005,1);
  const nearest=Math.min(...rows.map(row=>Math.abs(row.strike-spot)));
  const half=zoom==="ALL"?Math.max(...rows.map(row=>Math.abs(row.strike-spot)))*1.05:
    Math.max(spot*.005,step*(ZOOM_STEPS[zoom]||ZOOM_STEPS.NEAR),nearest*1.05);
  const radius=Math.max(half,step/2,1e-6);
  return {spot,low:spot-radius,high:spot+radius,rows:rows.filter(row=>Math.abs(row.strike-spot)<=radius),zoom:zoom in ZOOM_STEPS||zoom==="ALL"?zoom:"NEAR"};
}
function chart(payload,zoom){
  const view=chartWindow(payload,zoom);
  if(!view)return `<p class="empty">No qualified 0DTE strike profile.</p>`;
  const {rows,spot,low,high}=view;
  const width=900,height=340,left=62,right=24,top=28,bottom=48,mid=170,extent=112,usable=width-left-right;
  const max=Math.max(1,...rows.map(row=>Math.abs(row.net_gex)));
  const x=strike=>left+(strike-low)/(high-low)*usable;
  const bar=Math.max(2,Math.min(16,usable/(rows.length*1.7)));
  const s=payload.summary||{};
  const isWall=(strike,level)=>number(level)!==null&&Math.abs(strike-level)<1e-8;
  const bars=rows.map(row=>{const px=x(row.strike),value=row.net_gex,magnitude=Math.abs(value)/max*extent,barHeight=value===0?1:Math.max(1,magnitude),y=value>=0?mid-barHeight:mid;
    const walls=[isWall(row.strike,s.call_wall)?"Call wall":null,isWall(row.strike,s.put_wall)?"Put wall":null].filter(Boolean),outline=walls.length?` class="gamma-wall-outline" data-wall="${walls.join(" + ")}" stroke="#f5f7fb" stroke-width="5"`:"";
    return `<g><title>Strike ${fixed(row.strike,0)} · Net gamma ${compact(value)}${walls.length?` · ${walls.join(" + ")}`:""}</title><rect x="${(px-bar/2).toFixed(2)}" y="${y.toFixed(2)}" width="${bar.toFixed(2)}" height="${barHeight.toFixed(2)}" fill="${value>=0?"#26c983":"#f24567"}"${outline}/></g>`;}).join("");
  const ticks=Array.from({length:7},(_,i)=>{const level=low+(high-low)*i/6;return `<text x="${x(level).toFixed(2)}" y="${height-18}" text-anchor="middle" fill="currentColor" font-size="10">${fixed(level,level<1000?1:0)}</text>`;}).join("");
  const grid=[[-1,mid+extent],[0,mid],[1,mid-extent]].map(([tick,y])=>`<g><line x1="${left}" x2="${width-right}" y1="${y}" y2="${y}" stroke="#434650" stroke-dasharray="${tick?"3 4":"none"}"/><text x="${left-9}" y="${y+4}" text-anchor="end" fill="#9da3b2" font-size="10">${tick?compact(tick*max):"0"}</text></g>`).join("");
  return `<div class="gamma-chart-scroll"><svg class="gamma-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="0DTE net gamma by strike, centered on spot; call and put walls outlined">${grid}${bars}<g><line x1="${x(spot).toFixed(2)}" x2="${x(spot).toFixed(2)}" y1="${top}" y2="${height-bottom}" stroke="#438cff" stroke-width="2" stroke-dasharray="3 4"/><text x="${x(spot).toFixed(2)}" y="${top-7}" text-anchor="middle" fill="#438cff" font-size="10">Spot</text></g>${ticks}</svg></div><div class="gamma-legend"><span class="gamma-call">● Positive net gamma</span><span class="gamma-put">● Negative net gamma</span><span class="gamma-wall-key">▣ Call / put wall strike</span><span>Dashed: spot</span></div>`;
}
function analysis(payload){const a=payload.analysis||{},s=payload.summary||{};const signal=(payload.signals||[]).map(item=>{const kind=["VOLATILITY","MAGNET","CALL_WALL","PUT_WALL","GAMMA_FLIP"].includes(item.type)?item.type.toLowerCase().replaceAll("_","-"):"other";const strength=["STRONG","MODERATE","WEAK"].includes(item.strength)?item.strength.toLowerCase():"other";return `<article class="gamma-signal gamma-signal-${kind}"><div><strong>${esc(item.type?.replaceAll("_"," "))}</strong><span class="gamma-strength gamma-strength-${strength}">${esc(item.strength)}</span></div><p>${esc(gammaCopy(item.description))}</p>${number(item.level)!==null?`<small>@ ${fixed(item.level)} · ${fixed(item.distance_pct)}% from spot</small>`:""}</article>`;}).join("");
  const levels=[["Current Price",payload.spot],["Gamma Flip",s.zero_gamma_status==="CURRENT"?s.zero_gamma:null],["Call Wall",s.call_wall],["Put Wall",s.put_wall],["Gamma Magnet",s.gamma_magnet]].map(([name,value])=>`<div><span>${name}</span><strong>${fixed(value)}</strong></div>`).join("");
  return `<aside class="panel gamma-analysis"><h2>Signals</h2><div class="gamma-signals">${signal||"—"}</div><h2>Setup</h2><strong>${esc(a.setup_state||"Unavailable")}</strong><h3>Key levels</h3><div class="gamma-levels">${levels}</div><h3>Setup analysis</h3><ul>${(a.setup_analysis||[]).map(v=>`<li>${esc(gammaCopy(v))}</li>`).join("")}</ul><h3>For stronger setup</h3><ul>${(a.stronger_setup_conditions||[]).map(v=>`<li>${esc(gammaCopy(v))}</li>`).join("")}</ul><h3>Trading implication</h3><p>${esc(gammaCopy(a.trading_implication||"—"))}</p><h3>Alternate setup</h3><p>${esc(gammaCopy(a.alternate_setup||"—"))}</p></aside>`;
}
export function renderOptionsAnalysis(rows=[],selected="SPX",now=Date.now(),state="READY",zoom="NEAR"){
  const bySymbol=new Map(rows.map(row=>[row.symbol,row]));const chosen=SYMBOLS.includes(selected)?selected:"SPX";
  const tabs=SYMBOLS.map(symbol=>{const row=bySymbol.get(symbol),s=row?.payload?.summary||{};return `<button type="button" class="gamma-symbol ${chosen===symbol?"active":""}" data-action="select-options-symbol" data-symbol="${symbol}" aria-pressed="${chosen===symbol}"><strong>${symbol}</strong><small>${esc(s.gamma_regime||"UNAVAILABLE")}</small><span>${fixed(row?.spot)}</span><small>Net ${compact(s.net_gex)} · Flip ${fixed(s.zero_gamma_status==="CURRENT"?s.zero_gamma:null)}</small><em>${esc(optionsFreshness(row,now))}</em></button>`;}).join("");
  const row=bySymbol.get(chosen),p=row?.payload,s=p?.summary||{};
  const metrics=[[p?.spot_source==="YAHOO_FINANCE"?"Yahoo Spot":"Spot Price",fixed(p?.spot),"spot"],["Net GEX",compact(s.net_gex),number(s.net_gex)<0?"negative":"positive"],["Call GEX",compact(s.call_gex),"positive"],["Put GEX",compact(s.put_gex),"negative"],["Gross GEX",compact(s.gross_gex),"blue"],["Gamma Flip",s.zero_gamma_status==="CURRENT"?fixed(s.zero_gamma):esc(s.zero_gamma_status||"—"),"neutral"],["Call Wall",fixed(s.call_wall),"positive"],["Put Wall",fixed(s.put_wall),"negative"],["Gamma Magnet",fixed(s.gamma_magnet),"blue"]].map(([name,value,tone])=>`<div class="gamma-metric gamma-metric-${tone}"><small>${name}</small><strong>${value}</strong></div>`).join("");
  const zoomButtons=["TIGHT","NEAR","WIDE","ALL"].map(value=>`<button type="button" data-action="gamma-zoom" data-zoom="${value}" aria-pressed="${zoom===value}" class="${zoom===value?"active":""}">${value[0]+value.slice(1).toLowerCase()}</button>`).join("");
  return `<div class="options-analysis-page"><header class="panel gamma-head"><div><span class="eyebrow">0DTE GAMMA STRUCTURE</span><h2>Options Analysis</h2><p>Gamma exposure · not verified dealer positioning or a trade signal.</p></div><div><strong>${esc(optionsFreshness(row,now))}</strong><small>Gamma source updated ${time(row?.source_as_of)}</small>${p?.spot_source==="YAHOO_FINANCE"?`<small>Yahoo spot ${time(p.spot_as_of)} · ${p.spot_delay_status==="NOT_REPORTED"?"delay not reported":p.spot_delay_status==="NOT_DELAYED"?"no reported delay":"delayed"}</small>`:""}</div></header><div class="gamma-symbols">${tabs}</div>${state!=="READY"?`<p class="capacity-warning">Options Analysis storage unavailable; previously loaded values, if any, must not be treated as current.</p>`:""}${p?`<section class="panel gamma-metrics">${metrics}</section><div class="gamma-layout"><section class="panel gamma-chart-panel"><div class="panel-title"><h2>${chosen} · Net Gamma Strike Profile</h2><div class="gamma-chart-toolbar"><span>${p.coverage?.distinct_strike_count??0} total strikes · ${p.coverage?.contract_count??0} contracts</span><div class="gamma-zoom" role="group" aria-label="Chart zoom">${zoomButtons}</div></div></div>${chart(p,zoom)}</section>${analysis(p)}</div>`:`<section class="panel empty-state"><strong>No current ${chosen} analysis is published.</strong><p>The independent source worker has not provided a usable snapshot.</p></section>`}</div>`;
}
