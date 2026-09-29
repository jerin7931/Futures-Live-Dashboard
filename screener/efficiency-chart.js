export const EFFICIENCY_BOUNDS=Object.freeze({min:-1,max:1});
export const FRESHNESS_SECONDS=Object.freeze({M1:120,M5:360});
export const MOVE_BOUNDS=Object.freeze({min:0,max:100});

const finite=value=>value!==null&&value!==undefined&&Number.isFinite(Number(value))?Number(value):null;
const esc=value=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
const stamp=value=>Number.isFinite(Date.parse(value||""))?Date.parse(value):null;
const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"America/Chicago",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false});
const clock=value=>stamp(value)===null?"—":new Date(value).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",timeZone:"America/Chicago"});
const dayOf=value=>{const parts=Object.fromEntries(formatter.formatToParts(new Date(value)).filter(x=>x.type!=="literal").map(x=>[x.type,x.value]));return `${parts.year}-${parts.month}-${parts.day}`;};
const minuteOf=value=>{const parts=Object.fromEntries(formatter.formatToParts(new Date(value)).filter(x=>x.type!=="literal").map(x=>[x.type,x.value]));return Number(parts.hour)%24*60+Number(parts.minute);};
const fixed=(value,places=2)=>finite(value)===null?"—":finite(value).toLocaleString("en-US",{minimumFractionDigits:places,maximumFractionDigits:places});
const signed=value=>finite(value)===null?"—":`${finite(value)>=0?"+":""}${finite(value).toFixed(3)}`;

export function zonedEpoch(day,hour,minute){
  const desired=Date.parse(`${day}T${String(hour).padStart(2,"0")}:${String(minute).padStart(2,"0")}:00Z`);let guess=desired;
  for(let index=0;index<3;index++){const parts=Object.fromEntries(formatter.formatToParts(new Date(guess)).filter(x=>x.type!=="literal").map(x=>[x.type,x.value]));const observed=Date.parse(`${parts.year}-${parts.month}-${parts.day}T${String(Number(parts.hour)%24).padStart(2,"0")}:${parts.minute}:00Z`);guess+=desired-observed;}
  return guess;
}

export function defaultEfficiencyViewport(sessionDate){return {xMin:zonedEpoch(sessionDate,8,30),xMax:zonedEpoch(sessionDate,15,0),yMin:-1,yMax:1};}
export function efficiencyFreshness(timeframe,newestCompleted,now=Date.now()){const observed=stamp(newestCompleted),limit=FRESHNESS_SECONDS[timeframe];if(observed===null||!limit)return "UNAVAILABLE";const age=(now-observed)/1000;return age>=0&&age<=limit?"CURRENT":"STALE";}
export function efficiencySplit(value){const efficiency=Math.max(-1,Math.min(1,finite(value)??0)),bullish=(efficiency+1)/2;return {bullish,bearish:1-bullish};}

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

function tooltip(row){
  const efficiency=finite(row.efficiency),move=finite(row.move_percentile),split=efficiencySplit(efficiency);
  return `${clock(row.observation_at)} CT\nOpen          ${fixed(row.open)}\nHigh          ${fixed(row.high)}\nLow           ${fixed(row.low)}\nClose         ${fixed(row.close)}\nEfficiency      ${signed(efficiency)}\nBullish           ${(split.bullish*100).toFixed(1)}%\nBearish           ${(split.bearish*100).toFixed(1)}%\nMove              ${move===null?"—":(move*100).toFixed(1)+"%"}`;
}

function levelRows(levels={}){return [["S",levels.dynamic_support,"support"],["R",levels.dynamic_resistance,"resistance"],["PDH",levels.pdh,"daily"],["PDL",levels.pdl,"daily"],["PWH",levels.pwh,"weekly"],["PWL",levels.pwl,"weekly"],["FLIP",levels.gamma_flip,"flip"]].filter(([,value])=>finite(value)!==null);}

export function renderEfficiencyChart({symbol,timeframe,points=[],freshness={},levels={},expanded=false,currentPrice=null,now=Date.now()}){
  const series=[...points].filter(row=>row.completed!==false&&stamp(row.observation_at)!==null).sort((a,b)=>stamp(a.observation_at)-stamp(b.observation_at));
  const sessionDate=series.length?dayOf(stamp(series.at(-1).observation_at)):dayOf(now),view=defaultEfficiencyViewport(sessionDate);
  const visible=series.filter(row=>dayOf(stamp(row.observation_at))===sessionDate&&minuteOf(stamp(row.observation_at))>=8*60+30&&minuteOf(stamp(row.observation_at))<=15*60);
  const width=760,height=420,left=62,right=18,priceTop=24,priceBottom=274,moveTop=304,moveBottom=382,plotWidth=width-left-right;
  const xValue=value=>left+(stamp(value)-view.xMin)/(view.xMax-view.xMin)*plotWidth;
  const candleRows=visible.filter(row=>[row.open,row.high,row.low,row.close].every(value=>finite(value)!==null));
  const prices=candleRows.flatMap(row=>[finite(row.high),finite(row.low)]),minimum=Math.min(...prices),maximum=Math.max(...prices),span=Number.isFinite(maximum-minimum)&&maximum>minimum?maximum-minimum:1,pad=span*.08;
  const yMin=Number.isFinite(minimum)?minimum-pad:0,yMax=Number.isFinite(maximum)?maximum+pad:1,yValue=value=>priceTop+(yMax-value)/(yMax-yMin)*(priceBottom-priceTop);
  const candleWidth=timeframe==="M5"?Math.max(3,plotWidth/78*.72):Math.max(1.1,plotWidth/390*.76);
  const candles=candleRows.map(row=>{const x=xValue(row.observation_at),geometry=candleGeometry(row,yValue),split=efficiencySplit(row.efficiency);if(!geometry)return "";const redHeight=geometry.bodyHeight*split.bearish,greenHeight=geometry.bodyHeight-redHeight;return `<g class="price-eff-candle" data-timeframe="${timeframe}"><line class="candle-wick" x1="${x.toFixed(2)}" x2="${x.toFixed(2)}" y1="${geometry.wickTop.toFixed(2)}" y2="${geometry.wickBottom.toFixed(2)}"/><rect class="candle-bear" x="${(x-candleWidth/2).toFixed(2)}" y="${geometry.bodyTop.toFixed(2)}" width="${candleWidth.toFixed(2)}" height="${redHeight.toFixed(2)}"/><rect class="candle-bull" x="${(x-candleWidth/2).toFixed(2)}" y="${(geometry.bodyTop+redHeight).toFixed(2)}" width="${candleWidth.toFixed(2)}" height="${greenHeight.toFixed(2)}"/><rect class="candle-outline candle-${geometry.direction}" data-open="${geometry.open}" data-high="${geometry.high}" data-low="${geometry.low}" data-close="${geometry.close}" x="${(x-candleWidth/2).toFixed(2)}" y="${geometry.bodyTop.toFixed(2)}" width="${candleWidth.toFixed(2)}" height="${geometry.bodyHeight.toFixed(2)}"/></g>`;}).join("");
  const moveBars=visible.map(row=>{const value=finite(row.move_percentile);if(value===null)return "";const percent=Math.max(0,Math.min(100,value*100)),x=xValue(row.observation_at),y=moveBottom-percent/100*(moveBottom-moveTop),tone=percent>=90?"move-bright":percent>=80?"move-normal":"move-muted";return `<rect class="move-bar ${tone}" data-move-percent="${percent.toFixed(12)}" x="${(x-candleWidth/2).toFixed(2)}" y="${y.toFixed(2)}" width="${candleWidth.toFixed(2)}" height="${(moveBottom-y).toFixed(2)}"/>`;}).join("");
  const levelsMarkup=levelRows(levels).map(([label,value,tone],index)=>{const raw=yValue(finite(value)),off=raw<priceTop?"top":raw>priceBottom?"bottom":"",lineY=Math.max(priceTop,Math.min(priceBottom,raw)),labelY=Math.max(priceTop+9,Math.min(priceBottom-2,lineY+((index%3)-1)*10));return `<g class="price-level level-${tone}${off?" level-offrange":""}" data-level="${label}" data-level-price="${finite(value)}"><line x1="${left}" x2="${width-right}" y1="${lineY.toFixed(2)}" y2="${lineY.toFixed(2)}"/><text text-anchor="end" x="${width-right-3}" y="${labelY.toFixed(2)}">${label} ${fixed(value,1)}${off?off==="top"?" ↑":" ↓":""}</text></g>`;}).join("");
  const newest=freshness.newest_completed_at||visible.at(-1)?.observation_at||series.at(-1)?.observation_at,status=efficiencyFreshness(timeframe,newest,now),latest=visible.at(-1)||{},split=efficiencySplit(latest.efficiency),move=finite(latest.move_percentile),current=finite(currentPrice)??finite(latest.close),ticks=[[8,30],[9,0],[10,0],[11,0],[12,0],[13,0],[14,0],[15,0]].map(([hour,minute])=>new Date(zonedEpoch(sessionDate,hour,minute)));
  const hitWidth=Math.max(2,candleWidth*1.5),hits=visible.map((row,index)=>`<rect data-chart-point data-point-id="${index}" data-px="${xValue(row.observation_at).toFixed(2)}" data-py="${priceTop}" data-tooltip="${esc(tooltip(row))}" aria-label="${esc(tooltip(row))}" x="${(xValue(row.observation_at)-hitWidth/2).toFixed(2)}" y="${priceTop}" width="${hitWidth.toFixed(2)}" height="${moveBottom-priceTop}" class="chart-hit-point"><title>${esc(tooltip(row))}</title></rect>`).join("");
  return `<div class="price-efficiency-chart chart-tooltip-host${expanded?" is-expanded":""}" data-chart-tooltip-host data-price-efficiency-symbol="${esc(symbol)}">
    <div class="price-efficiency-header"><div><strong>PRICE EFFICIENCY</strong><span>${esc(symbol)} ${fixed(current,symbol==="SPX"?1:2)}</span><small>EFF ${signed(latest.efficiency)} · MOVE ${move===null?"—":(move*100).toFixed(1)+"%"}</small><small>BULL ${(split.bullish*100).toFixed(1)}% · BEAR ${(split.bearish*100).toFixed(1)}%</small></div><div class="price-efficiency-controls"><span class="freshness-${status.toLowerCase()}">${status} · ${esc(clock(newest))} CT</span><span class="segmented"><button type="button" data-action="eff-timeframe" data-symbol="${esc(symbol)}" data-value="M1" aria-pressed="${timeframe==="M1"}">1M</button><button type="button" data-action="eff-timeframe" data-symbol="${esc(symbol)}" data-value="M5" aria-pressed="${timeframe==="M5"}">5M</button></span><button type="button" data-action="toggle-price-efficiency" data-symbol="${esc(symbol)}" aria-label="${expanded?"Exit expanded":"Expand"} Price Efficiency chart">${expanded?"×":"⛶"}</button></div></div>
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(symbol)} ${esc(timeframe)} Price Efficiency candles and Move percentile bars"><title>${esc(symbol)} ${esc(timeframe)} Price Efficiency</title><desc>Exact available OHLC geometry with signed-efficiency body composition and a separate zero-to-one-hundred Move percentile pane. Missing authoritative values remain blank.</desc>
      <rect x="${left}" y="${priceTop}" width="${plotWidth}" height="${priceBottom-priceTop}" class="price-frame"/><rect x="${left}" y="${moveTop}" width="${plotWidth}" height="${moveBottom-moveTop}" class="move-frame"/>
      ${[100,50,0].map(value=>{const y=moveBottom-value/100*(moveBottom-moveTop);return `<g class="move-tick"><line x1="${left}" x2="${width-right}" y1="${y}" y2="${y}"/><text x="${left-7}" y="${y+4}" text-anchor="end">${value}%</text></g>`;}).join("")}
      <g class="price-levels">${levelsMarkup}</g><g class="price-candles">${candles}</g><g class="move-bars">${moveBars}</g><g class="chart-hit-layer">${hits}</g>
      <text class="axis-title" x="18" y="${(priceTop+priceBottom)/2}" transform="rotate(-90 18 ${(priceTop+priceBottom)/2})">Price</text><text class="axis-title" x="18" y="${(moveTop+moveBottom)/2}" transform="rotate(-90 18 ${(moveTop+moveBottom)/2})">Move</text>
      ${ticks.map((value,index)=>`<text class="eff-x-label" text-anchor="${index===0?"start":index===ticks.length-1?"end":"middle"}" x="${xValue(value).toFixed(2)}" y="${height-13}">${esc(clock(value))}</text>`).join("")}
    </svg><div class="chart-tooltip" role="status" aria-live="polite" hidden></div><div class="eff-legend"><span class="legend-positive">Body green = bullish efficiency share</span><span class="legend-negative">Body red = bearish efficiency share</span><span>Outline = actual candle direction</span><span>White bars = Move percentile</span></div>
  </div>`;
}
