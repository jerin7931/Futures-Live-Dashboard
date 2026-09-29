export const EFFICIENCY_BOUNDS=Object.freeze({min:-1,max:1});
export const FRESHNESS_SECONDS=Object.freeze({M1:120,M5:360});
export const MOVE_BOUNDS=Object.freeze({min:0,max:100});
export const RECENT_WINDOWS=Object.freeze({M1:60,M5:30});

const finite=value=>value!==null&&value!==undefined&&Number.isFinite(Number(value))?Number(value):null;
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const esc=value=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
const stamp=value=>Number.isFinite(Date.parse(value||""))?Date.parse(value):null;
const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"America/Chicago",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false});
const clock=value=>stamp(value)===null?"—":new Date(value).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",timeZone:"America/Chicago"});
const dayOf=value=>{const parts=Object.fromEntries(formatter.formatToParts(new Date(value)).filter(x=>x.type!=="literal").map(x=>[x.type,x.value]));return `${parts.year}-${parts.month}-${parts.day}`;};
const minuteOf=value=>{const parts=Object.fromEntries(formatter.formatToParts(new Date(value)).filter(x=>x.type!=="literal").map(x=>[x.type,x.value]));return Number(parts.hour)%24*60+Number(parts.minute);};
const fixed=(value,places=2)=>finite(value)===null?"—":finite(value).toLocaleString("en-US",{minimumFractionDigits:places,maximumFractionDigits:places});
const signed=value=>finite(value)===null?"—":`${finite(value)>=0?"+":""}${finite(value).toFixed(3)}`;
const compact=value=>{const number=finite(value);if(number===null)return "—";const absolute=Math.abs(number);return absolute>=1e9?`${(number/1e9).toFixed(2)}B`:absolute>=1e6?`${(number/1e6).toFixed(2)}M`:absolute>=1e3?`${(number/1e3).toFixed(1)}K`:number.toFixed(2);};

export function zonedEpoch(day,hour,minute){
  const desired=Date.parse(`${day}T${String(hour).padStart(2,"0")}:${String(minute).padStart(2,"0")}:00Z`);let guess=desired;
  for(let index=0;index<3;index++){const parts=Object.fromEntries(formatter.formatToParts(new Date(guess)).filter(x=>x.type!=="literal").map(x=>[x.type,x.value]));const observed=Date.parse(`${parts.year}-${parts.month}-${parts.day}T${String(Number(parts.hour)%24).padStart(2,"0")}:${parts.minute}:00Z`);guess+=desired-observed;}
  return guess;
}

export function defaultEfficiencyViewport(sessionDate){return {xMin:zonedEpoch(sessionDate,8,30),xMax:zonedEpoch(sessionDate,15,0),yMin:-1,yMax:1};}
export function efficiencyFreshness(timeframe,newestCompleted,now=Date.now()){const observed=stamp(newestCompleted),limit=FRESHNESS_SECONDS[timeframe];if(observed===null||!limit)return "UNAVAILABLE";const age=(now-observed)/1000;return age>=0&&age<=limit?"CURRENT":"STALE";}
export function efficiencySplit(value){const efficiency=clamp(finite(value)??0,-1,1),bullish=(efficiency+1)/2;return {bullish,bearish:1-bullish};}
export function withLocalEfficiency(points=[]){
  const rows=[...points].filter(row=>row.completed!==false&&stamp(row.observation_at)!==null).sort((a,b)=>stamp(a.observation_at)-stamp(b.observation_at)).map(row=>({...row,local_efficiency:null}));
  for(let index=5;index<rows.length;index+=1){
    const closes=rows.slice(index-5,index+1).map(row=>finite(row.close));
    if(closes.some(value=>value===null))continue;
    const path=closes.slice(1).reduce((total,value,offset)=>total+Math.abs(value-closes[offset]),0);
    rows[index].local_efficiency=path===0?0:clamp((closes.at(-1)-closes[0])/path,-1,1);
  }
  return rows;
}
export function recentWindowSize(timeframe){return RECENT_WINDOWS[timeframe]||RECENT_WINDOWS.M1;}
export function clampRecentOffset(total,timeframe,offset=0){return clamp(Math.round(finite(offset)??0),0,Math.max(0,total-recentWindowSize(timeframe)));}
export function visibleEfficiencyRows(points=[],timeframe="M1",mode="RECENT",offset=0){
  const rows=[...points].filter(row=>row.completed!==false&&stamp(row.observation_at)!==null).sort((a,b)=>stamp(a.observation_at)-stamp(b.observation_at));
  if(mode==="FULL")return {rows,offset:0,start:0,total:rows.length};
  const bounded=clampRecentOffset(rows.length,timeframe,offset),end=rows.length-bounded,start=Math.max(0,end-recentWindowSize(timeframe));
  return {rows:rows.slice(start,end),offset:bounded,start,total:rows.length};
}
export function scoreBarHeight(score,maximum,plotHeight){const value=finite(score),top=finite(maximum);return value===null||value<0||top===null||top<=0?0:clamp(value/top,0,1)*plotHeight*.23;}
export function gammaBarWidth(netGex,maximum,plotWidth){const value=finite(netGex),top=finite(maximum);return value===null||top===null||top<=0?0:Math.abs(value)/top*plotWidth*.20;}
export function participationDelta(row={}){
  const explicit=finite(row.normalized_participation_delta);
  if(explicit!==null)return clamp(explicit,-1,1);
  const buy=finite(row.aggressive_buy_volume),sell=finite(row.aggressive_sell_volume);
  return buy===null||sell===null||buy+sell<=0?null:clamp((buy-sell)/(buy+sell),-1,1);
}
export function participationInnerWidth(delta,candleWidth){const value=finite(delta);return value===null?0:Math.max(1,Math.abs(clamp(value,-1,1))*candleWidth*.76);}

export function candleGeometry(row,yValue){
  const open=finite(row.open),high=finite(row.high),low=finite(row.low),close=finite(row.close);
  if([open,high,low,close].some(value=>value===null)||low>Math.min(open,close)||high<Math.max(open,close))return null;
  const actualTop=Math.min(yValue(open),yValue(close)),actualBottom=Math.max(yValue(open),yValue(close)),height=Math.max(1.5,actualBottom-actualTop),middle=(actualTop+actualBottom)/2;
  return {open,high,low,close,wickTop:yValue(high),wickBottom:yValue(low),bodyTop:middle-height/2,bodyHeight:height,direction:close>open?"up":close<open?"down":"flat"};
}

export function signedSegments(points=[]){
  const rows=[...points].filter(row=>finite(row.efficiency)!==null&&stamp(row.observation_at)!==null).sort((a,b)=>stamp(a.observation_at)-stamp(b.observation_at)),result=[];
  for(let index=1;index<rows.length;index++){const a=rows[index-1],b=rows[index],av=finite(a.efficiency),bv=finite(b.efficiency);if((av<0&&bv>0)||(av>0&&bv<0)){const ratio=Math.abs(av)/(Math.abs(av)+Math.abs(bv)),crossing={observation_at:new Date(stamp(a.observation_at)+(stamp(b.observation_at)-stamp(a.observation_at))*ratio).toISOString(),efficiency:0};result.push({sign:av>0?"positive":"negative",from:a,to:crossing});result.push({sign:bv>0?"positive":"negative",from:crossing,to:b});}else result.push({sign:av===0&&bv===0?"neutral":Math.max(av,bv)>0?"positive":"negative",from:a,to:b});}
  return result;
}

function gammaProfile(gamma){return Array.isArray(gamma?.payload?.strike_profile)?gamma.payload.strike_profile:[];}
function gammaSummary(gamma){return gamma?.payload?.summary||{};}
function tooltip(row,gamma,symbol){
  const efficiency=finite(row.local_efficiency),move=finite(row.move_percentile),score=finite(row.model_score),profile=gammaProfile(gamma),close=finite(row.close),buy=finite(row.aggressive_buy_volume),sell=finite(row.aggressive_sell_volume),delta=finite(row.participation_delta)??(buy!==null&&sell!==null?buy-sell:null),normalized=participationDelta(row),source=row.participation_source_symbol||(symbol==="SPX"?"SPY":"—");
  const near=close===null?null:profile.reduce((best,item)=>finite(item.strike)===null||finite(item.net_gex)===null?best:!best||Math.abs(finite(item.strike)-close)<Math.abs(finite(best.strike)-close)?item:best,null);
  const lines=[`${clock(row.observation_at)} CT`,`Open          ${fixed(row.open,symbol==="SPX"?1:2)}`,`High          ${fixed(row.high,symbol==="SPX"?1:2)}`,`Low           ${fixed(row.low,symbol==="SPX"?1:2)}`,`Close         ${fixed(row.close,symbol==="SPX"?1:2)}`,"",`Aggressive buy   ${compact(buy)}`,`Aggressive sell  ${compact(sell)}`,`Participation Δ  ${compact(delta)}`,`Normalized Δ     ${normalized===null?"—":(normalized*100).toFixed(1)+"%"}`,`Participation src ${source==="SPY"&&symbol==="SPX"?"SPY proxy":source}`,`Classification   ${row.classification_method||"—"}`,"",`Efficiency       ${signed(efficiency)}`,`Move             ${move===null?"—":(move*100).toFixed(1)+"%"}`,`Raw score        ${score===null?"—":score.toFixed(6)}`];
  if(near&&close!==null&&Math.abs(finite(near.strike)-close)<Math.max(.5,Math.abs(close)*.003))lines.push(`Near Γ ${fixed(near.strike,symbol==="SPX"?1:2)} · ${compact(near.net_gex)}`);
  return lines.join("\n");
}

function levelRows(levels={}){return [["S",levels.dynamic_support,"support"],["R",levels.dynamic_resistance,"resistance"],["PDH",levels.pdh,"daily"],["PDL",levels.pdl,"daily"],["PWH",levels.pwh,"weekly"],["PWL",levels.pwl,"weekly"],["FLIP",levels.gamma_flip,"flip"]].filter(([,value])=>finite(value)!==null);}

export function renderEfficiencyChart({symbol,timeframe,points=[],freshness={},levels={},gamma=null,expanded=false,currentPrice=null,currentMetrics={},mode="RECENT",recentOffset=0,now=Date.now()}){
  const ordered=[...points].filter(row=>row.completed!==false&&stamp(row.observation_at)!==null).sort((a,b)=>stamp(a.observation_at)-stamp(b.observation_at));
  const sessionDate=ordered.length?dayOf(stamp(ordered.at(-1).observation_at)):dayOf(now);
  const session=withLocalEfficiency(ordered.filter(row=>dayOf(stamp(row.observation_at))===sessionDate&&minuteOf(stamp(row.observation_at))>=8*60+30&&minuteOf(stamp(row.observation_at))<=15*60));
  const window=visibleEfficiencyRows(session,timeframe,mode,recentOffset),visible=window.rows;
  const width=1200,height=560,left=54,right=68,top=14,bottom=38,plotWidth=width-left-right,plotHeight=height-top-bottom;
  const xValue=index=>left+(index+.5)/Math.max(1,visible.length)*plotWidth;
  const candleRows=visible.filter(row=>candleGeometry(row,value=>value)!==null),prices=candleRows.flatMap(row=>[finite(row.high),finite(row.low)]);
  let minimum=Math.min(...prices),maximum=Math.max(...prices),span=Number.isFinite(maximum-minimum)&&maximum>minimum?maximum-minimum:Math.max(Math.abs(maximum||1)*.001,1);
  const nearLevels=levelRows(levels).filter(([,value])=>value>=minimum-span*.2&&value<=maximum+span*.2).map(([,value])=>finite(value));
  if(nearLevels.length){minimum=Math.min(minimum,...nearLevels);maximum=Math.max(maximum,...nearLevels);span=Math.max(maximum-minimum,span);}
  const yMin=Number.isFinite(minimum)?minimum-span*.08:0,yMax=Number.isFinite(maximum)?maximum+span*.08:1,yValue=value=>top+(yMax-value)/(yMax-yMin)*plotHeight;
  const candleWidth=clamp(plotWidth/Math.max(1,visible.length)*.66,1.1,11),summary=gammaSummary(gamma),profile=gammaProfile(gamma),profileVisible=profile.filter(item=>finite(item.strike)!==null&&finite(item.net_gex)!==null&&finite(item.strike)>=yMin&&finite(item.strike)<=yMax),gammaMax=Math.max(1,...profileVisible.map(item=>Math.abs(finite(item.net_gex))));
  const gammaBars=profileVisible.map(item=>{const value=finite(item.net_gex),barWidth=gammaBarWidth(value,gammaMax,plotWidth),y=yValue(finite(item.strike));return `<rect class="gamma-profile-bar ${value>=0?"gamma-positive":"gamma-negative"}" data-gamma-strike="${finite(item.strike)}" data-gamma-value="${value}" x="${left}" y="${(y-2.6).toFixed(2)}" width="${barWidth.toFixed(2)}" height="5.2"/>`;}).join("");
  const scoreMax=Math.max(0,...visible.map(row=>finite(row.model_score)??0));
  const scoreBars=visible.map((row,index)=>{const score=finite(row.model_score),barHeight=scoreBarHeight(score,scoreMax,plotHeight);if(score===null||barHeight<=0)return "";const move=finite(row.move_percentile),tone=move===null?"score-unknown":move>=.9?"score-bright":move>=.8?"score-normal":"score-muted";return `<rect class="raw-score-bar ${tone}" data-raw-score="${score}" x="${(xValue(index)-candleWidth*.42).toFixed(2)}" y="${(top+plotHeight-barHeight).toFixed(2)}" width="${Math.max(1,candleWidth*.84).toFixed(2)}" height="${barHeight.toFixed(2)}"/>`;}).join("");
  const levelsMarkup=levelRows(levels).map(([label,value,tone],index)=>{const raw=yValue(finite(value)),off=raw<top?"top":raw>top+plotHeight?"bottom":"",lineY=clamp(raw,top,top+plotHeight),labelY=clamp(lineY-3-(index%3)*11,top+10,top+plotHeight-4);return off?`<text class="edge-level level-${tone}" x="${left+6}" y="${off==="top"?top+11:top+plotHeight-5}">${off==="top"?"↑":"↓"} ${label} ${fixed(value,symbol==="SPX"?1:2)}</text>`:`<g class="price-level level-${tone}" data-level="${label}" data-level-price="${finite(value)}"><line x1="${left}" x2="${width-right}" y1="${lineY.toFixed(2)}" y2="${lineY.toFixed(2)}"/><text text-anchor="end" x="${width-right-4}" y="${labelY.toFixed(2)}">${label} ${fixed(value,symbol==="SPX"?1:2)}</text></g>`;}).join("");
  const candles=visible.map((row,index)=>{const x=xValue(index),geometry=candleGeometry(row,yValue);if(!geometry)return "";const delta=participationDelta(row),innerWidth=participationInnerWidth(delta,candleWidth),outer=`<rect class="candle-body candle-body-${geometry.direction}" x="${(x-candleWidth/2).toFixed(2)}" y="${geometry.bodyTop.toFixed(2)}" width="${candleWidth.toFixed(2)}" height="${geometry.bodyHeight.toFixed(2)}"/>`,inner=delta===null?`<line class="participation-missing" x1="${(x-candleWidth*.28).toFixed(2)}" x2="${(x+candleWidth*.28).toFixed(2)}" y1="${(geometry.bodyTop+geometry.bodyHeight/2).toFixed(2)}" y2="${(geometry.bodyTop+geometry.bodyHeight/2).toFixed(2)}"/>`:`<rect class="participation-inner ${delta>0?"participation-buy":delta<0?"participation-sell":"participation-neutral"}" data-normalized-delta="${delta}" x="${(x-innerWidth/2).toFixed(2)}" y="${geometry.bodyTop.toFixed(2)}" width="${innerWidth.toFixed(2)}" height="${geometry.bodyHeight.toFixed(2)}"/>`;return `<g class="price-eff-candle" data-timeframe="${timeframe}"><line class="candle-wick" x1="${x.toFixed(2)}" x2="${x.toFixed(2)}" y1="${geometry.wickTop.toFixed(2)}" y2="${geometry.wickBottom.toFixed(2)}"/>${outer}${inner}<rect class="candle-outline candle-${geometry.direction}" data-open="${geometry.open}" data-high="${geometry.high}" data-low="${geometry.low}" data-close="${geometry.close}" x="${(x-candleWidth/2).toFixed(2)}" y="${geometry.bodyTop.toFixed(2)}" width="${candleWidth.toFixed(2)}" height="${geometry.bodyHeight.toFixed(2)}"/></g>`;}).join("");
  const latest=session.at(-1)||{},newest=freshness.newest_completed_at||latest.observation_at,status=efficiencyFreshness(timeframe,newest,now),metricEfficiency=finite(latest.local_efficiency),metricDelta=participationDelta(latest),buy=finite(latest.aggressive_buy_volume),sell=finite(latest.aggressive_sell_volume),move=finite(currentMetrics.move)??finite(latest.move_percentile),score=finite(currentMetrics.score)??finite(latest.model_score),current=finite(currentPrice)??finite(latest.close),currentY=current!==null?yValue(current):null;
  const currentMarkup=currentY!==null&&currentY>=top&&currentY<=top+plotHeight?`<line class="current-price-line" x1="${left}" x2="${width-right+9}" y1="${currentY.toFixed(2)}" y2="${currentY.toFixed(2)}"/><rect class="current-price-badge" x="${width-right+8}" y="${(currentY-9).toFixed(2)}" width="${right-11}" height="18" rx="3"/><text class="current-price-text" x="${width-6}" y="${(currentY+3).toFixed(2)}" text-anchor="end">${fixed(current,symbol==="SPX"?1:2)}</text>`:"";
  const tickCount=Math.min(mode==="FULL"?7:5,visible.length),ticks=tickCount>1?Array.from({length:tickCount},(_,index)=>Math.round(index*(visible.length-1)/(tickCount-1))):visible.length?[0]:[];
  const hitWidth=Math.max(2,plotWidth/Math.max(1,visible.length)),hits=visible.map((row,index)=>`<rect data-chart-point data-point-id="${index}" data-px="${xValue(index).toFixed(2)}" data-py="${top}" data-tooltip="${esc(tooltip(row,gamma,symbol))}" aria-label="${esc(tooltip(row,gamma,symbol))}" x="${(xValue(index)-hitWidth/2).toFixed(2)}" y="${top}" width="${hitWidth.toFixed(2)}" height="${plotHeight}" class="chart-hit-point"><title>${esc(tooltip(row,gamma,symbol))}</title></rect>`).join("");
  const atLatest=clampRecentOffset(session.length,timeframe,recentOffset)===0,gammaAt=gamma?.source_as_of||gamma?.updated_at,regime=summary.gamma_regime||"UNAVAILABLE",flip=summary.zero_gamma_status==="CURRENT"?summary.zero_gamma:null;
  return `<div class="price-efficiency-chart combined-market-chart chart-tooltip-host${expanded?" is-expanded":""}" data-chart-tooltip-host data-price-efficiency-symbol="${esc(symbol)}">
    <div class="price-efficiency-header"><div><strong>COMBINED MARKET STRUCTURE</strong><span>${esc(symbol)} ${fixed(current,symbol==="SPX"?1:2)}</span><small>PARTICIPATION DELTA ${metricDelta===null?"—":`${metricDelta>=0?"+":""}${(metricDelta*100).toFixed(1)}%`} · EFF ${signed(metricEfficiency)} · MOVE ${move===null?"—":(move*100).toFixed(1)+"%"} · SCORE ${score===null?"—":score.toFixed(4)}</small><small>BUY ${compact(buy)} · SELL ${compact(sell)} · SOURCE ${symbol==="SPX"?"SPY PROXY":"WEBULL TRADE/QUOTE"} · NET Γ ${compact(summary.net_gex)} · ${esc(regime)}${flip===null?"":` · FLIP ${fixed(flip,symbol==="SPX"?1:2)}`}</small></div><div class="price-efficiency-controls"><span class="freshness-${status.toLowerCase()}">${status} · ${esc(clock(newest))} CT</span><span class="segmented"><button type="button" data-action="eff-timeframe" data-symbol="${esc(symbol)}" data-value="M1" aria-pressed="${timeframe==="M1"}">1M</button><button type="button" data-action="eff-timeframe" data-symbol="${esc(symbol)}" data-value="M5" aria-pressed="${timeframe==="M5"}">5M</button></span><span class="segmented"><button type="button" data-action="eff-mode" data-symbol="${esc(symbol)}" data-value="RECENT" aria-pressed="${mode==="RECENT"}">RECENT</button><button type="button" data-action="eff-mode" data-symbol="${esc(symbol)}" data-value="FULL" aria-pressed="${mode==="FULL"}">FULL</button></span><button type="button" class="chart-latest${atLatest?" at-latest":""}" data-action="eff-latest" data-symbol="${esc(symbol)}">${atLatest?"LATEST":"RETURN LATEST"}</button><button type="button" data-action="toggle-price-efficiency" data-symbol="${esc(symbol)}" aria-label="${expanded?"Exit expanded":"Expand"} combined chart">${expanded?"×":"⛶"}</button></div></div>
    <div class="combined-snapshot"><span>Γ snapshot ${gammaAt?esc(clock(gammaAt))+" CT":"unavailable"}</span><span>${mode==="RECENT"?`${recentWindowSize(timeframe)} completed candles · drag horizontally`:"complete RTH session"}</span></div>
    <div class="price-efficiency-plot-scroll"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(symbol)} ${esc(timeframe)} price and Participation Delta chart"><title>${esc(symbol)} ${esc(timeframe)} combined market structure</title><desc>Actual OHLC outer candles with Webull trade and quote classified Participation Delta inner candles, price-aligned gamma profile, raw model-score bars, market levels and current price. Efficiency remains available as text and tooltip context. Missing participation remains blank.</desc>
      <rect x="${left}" y="${top}" width="${plotWidth}" height="${plotHeight}" class="price-frame"/>
      ${Array.from({length:5},(_,index)=>{const y=top+index*plotHeight/4,value=yMax-index*(yMax-yMin)/4;return `<g class="price-tick"><line x1="${left}" x2="${width-right}" y1="${y.toFixed(2)}" y2="${y.toFixed(2)}"/><text x="${left-8}" y="${(y+3).toFixed(2)}" text-anchor="end">${fixed(value,symbol==="SPX"?1:2)}</text></g>`;}).join("")}
      <g class="gamma-profile">${gammaBars}</g><g class="raw-score-bars">${scoreBars}</g><g class="price-levels">${levelsMarkup}</g><g class="price-candles">${candles}</g>${currentMarkup}<g class="chart-hit-layer">${hits}</g>
      <rect class="chart-drag-surface" data-chart-drag data-symbol="${esc(symbol)}" x="${left}" y="${top}" width="${plotWidth}" height="${plotHeight}"/>
      <text class="axis-title" x="${left+4}" y="${top+11}">PRICE</text><text class="axis-title raw-score-scale" x="${width-right-4}" y="${top+plotHeight-7}" text-anchor="end">RAW SCORE SCALE 0–${scoreMax?scoreMax.toFixed(4):"—"}</text>
      ${ticks.map(index=>`<text class="eff-x-label" text-anchor="middle" x="${xValue(index).toFixed(2)}" y="${height-15}">${esc(clock(visible[index].observation_at))}</text>`).join("")}
    </svg></div><div class="chart-tooltip" role="status" aria-live="polite" hidden></div><div class="eff-legend"><span class="legend-positive">■ Positive Participation Delta</span><span class="legend-negative">■ Negative Participation Delta</span><span>□ Outer candle = actual OHLC</span><span>▥ Inner width = |normalized delta|</span><span>▥ White bars = raw model score</span></div>
  </div>`;
}
