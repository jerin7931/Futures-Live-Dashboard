const SYMBOLS=["SPX","SPY","QQQ","IWM"];
const esc=value=>String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[char]));
const number=value=>value!==null&&value!==undefined&&Number.isFinite(Number(value))?Number(value):null;
const fixed=(value,places=2)=>number(value)===null?"—":Number(value).toLocaleString("en-US",{minimumFractionDigits:places,maximumFractionDigits:places});
const compact=value=>{if(number(value)===null)return "—";const n=Math.abs(value),unit=n>=1e9?"B":n>=1e6?"M":n>=1e3?"K":"",scale=unit==="B"?1e9:unit==="M"?1e6:unit==="K"?1e3:1;return `${value<0?"−":""}$${fixed(n/scale,n/scale>=100?0:1)}${unit}`;};
const time=value=>Number.isFinite(Date.parse(value||""))?new Date(value).toLocaleString("en-US",{dateStyle:"short",timeStyle:"short",timeZone:"America/Chicago"}):"—";
const gammaCopy=value=>String(value??"").replace(/OI[- ]gamma proxy/gi,"gamma exposure").replace(/OI[- ]based structural proxy/gi,"gamma structure").replace(/OI[- ]based exposure proxy/gi,"gamma exposure").replace(/OI proxy/gi,"gamma exposure").replace(/OI[- ]gamma/gi,"gamma");

export function optionsFreshness(row,now=Date.now()){
  if(!row)return "UNAVAILABLE";
  if(["OFF_SESSION","NO_0DTE_DATA","SOURCE_STALE"].includes(row.status))return row.status;
  if(row.payload?.source_is_stale)return "SOURCE_STALE";
  const age=(now-Date.parse(row.source_as_of||""))/1000;
  if(!Number.isFinite(age)||age<0)return "STALE";
  return age<=150?"CURRENT":age<=300?"AGED":"STALE";
}

const profile=payload=>(payload?.strike_profile||[]).filter(row=>number(row.strike)!==null&&number(row.net_gex)!==null).sort((a,b)=>a.strike-b.strike);
export const ZOOM_STEPS=Object.freeze({TIGHT:10,NEAR:20,WIDE:40});
export function chartWindow(payload,zoom="NEAR"){
  const rows=profile(payload);if(!rows.length)return null;
  const spot=number(payload.spot)??rows[Math.floor(rows.length/2)].strike;
  const nearby=[...rows].sort((a,b)=>Math.abs(a.strike-spot)-Math.abs(b.strike-spot)).slice(0,31).sort((a,b)=>a.strike-b.strike);
  const gaps=nearby.slice(1).map((row,i)=>row.strike-nearby[i].strike).filter(gap=>gap>0).sort((a,b)=>a-b);
  const step=gaps.length?gaps[Math.floor(gaps.length/2)]:Math.max(spot*.005,1);
  const nearest=Math.min(...rows.map(row=>Math.abs(row.strike-spot)));
  const half=zoom==="ALL"?Math.max(...rows.map(row=>Math.abs(row.strike-spot)))*1.05:Math.max(spot*.005,step*(ZOOM_STEPS[zoom]||ZOOM_STEPS.NEAR),nearest*1.05);
  const radius=Math.max(half,step/2,1e-6);
  return {spot,low:spot-radius,high:spot+radius,rows:rows.filter(row=>Math.abs(row.strike-spot)<=radius),zoom:zoom in ZOOM_STEPS||zoom==="ALL"?zoom:"NEAR"};
}

export function defaultGammaViewport(payload,mode="NEAR"){
  const window=chartWindow(payload,mode);if(!window)return null;
  const extent=Math.max(1,...window.rows.map(row=>Math.abs(row.net_gex)));
  return {xMin:window.low,xMax:window.high,yMin:-extent,yMax:extent};
}

function gammaChart(payload,marketLevels,mode,chartId){
  const view=defaultGammaViewport(payload,mode);
  if(!view)return `<p class="empty">No qualified 0DTE strike profile.</p>`;
  const rows=chartWindow(payload,mode).rows,width=900,height=340,left=68,right=24,top=30,bottom=48,usable=width-left-right,plotHeight=height-top-bottom;
  const x=value=>left+(value-view.xMin)/(view.xMax-view.xMin)*usable,y=value=>top+(view.yMax-value)/(view.yMax-view.yMin)*plotHeight;
  const visible=rows,bar=Math.max(2,Math.min(16,usable/(Math.max(visible.length,1)*1.7))),summary=payload.summary||{};
  const wall=(strike,level)=>number(level)!==null&&Math.abs(strike-level)<1e-8;
  const bars=visible.map((row,index)=>{const px=x(row.strike),py=y(row.net_gex),zero=y(0),h=Math.max(1,Math.abs(zero-py)),yy=Math.min(py,zero),walls=[wall(row.strike,summary.call_wall)?"Call wall":null,wall(row.strike,summary.put_wall)?"Put wall":null].filter(Boolean),relationship=row.strike<payload.spot?"below spot":row.strike>payload.spot?"above spot":"at spot",label=`Strike ${fixed(row.strike,row.strike<1000?1:0)} · Net gamma ${compact(row.net_gex)} · ${relationship}${walls.length?` · ${walls.join(" + ")}`:""}`;return `<rect data-chart-point data-point-id="${index}" data-px="${px.toFixed(2)}" data-py="${py.toFixed(2)}" data-tooltip="${esc(label)}" x="${(px-bar/2).toFixed(2)}" y="${yy.toFixed(2)}" width="${bar.toFixed(2)}" height="${h.toFixed(2)}" fill="${row.net_gex>=0?"#26c983":"#f24567"}"${walls.length?' class="gamma-wall-outline" stroke="#f5f7fb" stroke-width="4"':""}><title>${esc(label)}</title></rect>`;}).join("");
  const yTicks=Array.from({length:5},(_,i)=>view.yMax-(view.yMax-view.yMin)*i/4),xTicks=Array.from({length:7},(_,i)=>view.xMin+(view.xMax-view.xMin)*i/6);
  const defs=[["S",marketLevels.dynamic_support,""],["R",marketLevels.dynamic_resistance,""],["PDH",marketLevels.pdh,"6 4"],["PDL",marketLevels.pdl,"6 4"],["PWH",marketLevels.pwh,"2 4"],["PWL",marketLevels.pwl,"2 4"]];
  const overlays=defs.filter(([,value])=>number(value)!==null&&value>=view.xMin&&value<=view.xMax).map(([label,value,dash],index)=>`<g><line x1="${x(value).toFixed(2)}" x2="${x(value).toFixed(2)}" y1="${top}" y2="${height-bottom}" stroke="#f6c85f"${dash?` stroke-dasharray="${dash}"`:""}/><text x="${(x(value)+3).toFixed(2)}" y="${top+12+(index%3)*12}" fill="#f6c85f" font-size="9">${label}</text></g>`).join("");
  const spotLine=payload.spot>=view.xMin&&payload.spot<=view.xMax?`<line x1="${x(payload.spot)}" x2="${x(payload.spot)}" y1="${top}" y2="${height-bottom}" stroke="#438cff" stroke-width="2" stroke-dasharray="3 4"/>`:"";
  const clip=`clip-gamma-${String(chartId||"profile").replace(/[^a-z0-9_-]/gi,"-").toLowerCase()}`;
  return `<div class="gamma-static chart-tooltip-host" data-chart-tooltip-host><div class="gamma-chart-scroll"><svg class="gamma-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="0DTE net gamma by strike"><defs><clipPath id="${esc(clip)}"><rect x="${left}" y="${top}" width="${usable}" height="${plotHeight}"/></clipPath></defs>${yTicks.map(value=>`<g><line x1="${left}" x2="${width-right}" y1="${y(value)}" y2="${y(value)}" stroke="#434650"/><text x="${left-8}" y="${y(value)+4}" text-anchor="end" fill="#9da3b2" font-size="10">${compact(value)}</text></g>`).join("")}<g clip-path="url(#${esc(clip)})">${bars}${spotLine}${overlays}</g>${xTicks.map(value=>`<text x="${x(value)}" y="${height-18}" text-anchor="middle" fill="currentColor" font-size="10">${fixed(value,value<1000?1:0)}</text>`).join("")}</svg></div><div class="chart-tooltip" role="status" aria-live="polite" hidden></div><div class="gamma-legend"><span class="gamma-call">● Positive net gamma</span><span class="gamma-put">● Negative net gamma</span><span>Dashed: spot</span></div></div>`;
}

export function renderCompactGamma(row,marketLevels={},ui,symbol=row?.symbol||"UNKNOWN"){
  const payload=row?.payload,summary=payload?.summary||{};if(!payload)return `<div class="gamma-compact-empty">No current gamma snapshot.</div>`;
  return `<div class="gamma-compact-meta"><span>Spot <strong>${fixed(payload.spot)}</strong></span><span>Net <strong class="${number(summary.net_gex)<0?"negative":"positive"}">${compact(summary.net_gex)}</strong></span><span>${esc(summary.gamma_regime||"UNAVAILABLE")}</span><span>Flip ${summary.zero_gamma_status==="CURRENT"?fixed(summary.zero_gamma):"—"}</span></div>${gammaChart(payload,marketLevels,"TIGHT",`home-${symbol}`)}`;
}

function analysis(payload){const a=payload.analysis||{},s=payload.summary||{},signals=(payload.signals||[]).map(item=>`<article><div><strong>${esc(item.type?.replaceAll("_"," "))}</strong><span>${esc(item.strength)}</span></div><p>${esc(gammaCopy(item.description))}</p></article>`).join("");return `<aside class="panel gamma-analysis"><h2>Signals</h2><div class="gamma-signals">${signals||"—"}</div><h2>Setup</h2><strong>${esc(a.setup_state||"Unavailable")}</strong><h3>Key levels</h3><div class="gamma-levels">${[["Current Price",payload.spot],["Gamma Flip",s.zero_gamma_status==="CURRENT"?s.zero_gamma:null],["Call Wall",s.call_wall],["Put Wall",s.put_wall],["Gamma Magnet",s.gamma_magnet]].map(([name,value])=>`<div><span>${name}</span><strong>${fixed(value)}</strong></div>`).join("")}</div><h3>Setup analysis</h3><ul>${(a.setup_analysis||[]).map(v=>`<li>${esc(gammaCopy(v))}</li>`).join("")}</ul><h3>Trading implication</h3><p>${esc(gammaCopy(a.trading_implication||"—"))}</p></aside>`;}

export function renderOptionsAnalysis(rows=[],selected="SPX",now=Date.now(),state="READY",ui){
  ui=ui||{optionsZoom:"NEAR"};
  const bySymbol=new Map(rows.map(row=>[row.symbol,row])),chosen=SYMBOLS.includes(selected)?selected:"SPX";
  const tabs=SYMBOLS.map(symbol=>{const row=bySymbol.get(symbol),s=row?.payload?.summary||{};return `<button type="button" class="gamma-symbol ${chosen===symbol?"active":""}" data-action="select-options-symbol" data-symbol="${symbol}" aria-pressed="${chosen===symbol}"><strong>${symbol}</strong><small>${esc(s.gamma_regime||"UNAVAILABLE")}</small><span>${fixed(row?.spot)}</span><small>Net ${compact(s.net_gex)} · Flip ${fixed(s.zero_gamma_status==="CURRENT"?s.zero_gamma:null)}</small><em>${esc(optionsFreshness(row,now))}</em></button>`;}).join("");
  const row=bySymbol.get(chosen),p=row?.payload,s=p?.summary||{},metrics=[["Spot Price",fixed(p?.spot),"spot"],["Net GEX",compact(s.net_gex),number(s.net_gex)<0?"negative":"positive"],["Call GEX",compact(s.call_gex),"positive"],["Put GEX",compact(s.put_gex),"negative"],["Gross GEX",compact(s.gross_gex),"blue"],["Gamma Flip",s.zero_gamma_status==="CURRENT"?fixed(s.zero_gamma):esc(s.zero_gamma_status||"—"),"neutral"],["Call Wall",fixed(s.call_wall),"positive"],["Put Wall",fixed(s.put_wall),"negative"],["Gamma Magnet",fixed(s.gamma_magnet),"blue"]].map(([name,value,tone])=>`<div class="gamma-metric gamma-metric-${tone}"><small>${name}</small><strong>${value}</strong></div>`).join("");
  const zoom=ui.optionsZoom in ZOOM_STEPS||ui.optionsZoom==="ALL"?ui.optionsZoom:"NEAR";
  const zoomButtons=["TIGHT","NEAR","WIDE","ALL"].map(value=>`<button type="button" data-action="gamma-zoom" data-zoom="${value}" aria-pressed="${zoom===value}" class="${zoom===value?"active":""}">${value[0]+value.slice(1).toLowerCase()}</button>`).join("");
  return `<div class="options-analysis-page"><header class="panel gamma-head"><div><span class="eyebrow">0DTE GAMMA STRUCTURE</span><h2>Options Analysis</h2><p>Gamma exposure · not verified dealer positioning or a trade signal.</p></div><div><strong>${esc(optionsFreshness(row,now))}</strong><small>Gamma source updated ${time(row?.source_as_of)}</small></div></header><div class="gamma-symbols">${tabs}</div>${state!=="READY"?`<p class="capacity-warning">Options Analysis storage unavailable; retained values are not current.</p>`:""}${p?`<section class="panel gamma-metrics">${metrics}</section><div class="gamma-layout"><section class="panel gamma-chart-panel"><div class="panel-title"><h2>${chosen} · Net Gamma Strike Profile</h2><div class="gamma-chart-toolbar"><span>${p.coverage?.distinct_strike_count??0} strikes · ${p.coverage?.contract_count??0} contracts</span><div class="gamma-zoom" role="group" aria-label="Chart zoom">${zoomButtons}</div></div></div>${gammaChart(p,{},zoom,`analysis-${chosen}`)}</section>${analysis(p)}</div>`:`<section class="panel empty-state"><strong>No current ${chosen} analysis is published.</strong></section>`}</div>`;
}
