export const EFFICIENCY_BOUNDS=Object.freeze({min:-1,max:1});
export const STABLE_EMA_LENGTH=20;

const finite=value=>value!==null&&value!==undefined&&Number.isFinite(Number(value))?Number(value):null;
const esc=value=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
const clamp=value=>Math.max(EFFICIENCY_BOUNDS.min,Math.min(EFFICIENCY_BOUNDS.max,value));
const stamp=value=>Number.isFinite(Date.parse(value||""))?Date.parse(value):null;
const clock=value=>stamp(value)===null?"—":new Date(value).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",timeZone:"America/Chicago"});

export function stableEfficiency(points=[],directionTimeline=[],length=STABLE_EMA_LENGTH){
  const directions=new Map(directionTimeline.map(row=>[String(row.observation_at),String(row.direction_state||"MIXED").toUpperCase()]));
  const alpha=2/(length+1);let ema=null;
  return [...points].filter(row=>row.completed!==false&&finite(row.efficiency)!==null&&stamp(row.observation_at)!==null)
    .sort((a,b)=>stamp(a.observation_at)-stamp(b.observation_at)).map(row=>{
      const efficiency=clamp(finite(row.efficiency)),direction=directions.get(String(row.observation_at))||"MIXED";
      const sign=direction==="BULLISH"?1:direction==="BEARISH"?-1:null;
      const adjusted=sign===null?null:efficiency*sign;
      if(adjusted!==null)ema=ema===null?adjusted:alpha*adjusted+(1-alpha)*ema;
      return {...row,efficiency,direction_state:direction,direction_adjusted_efficiency:adjusted,stable_efficiency:ema};
    });
}

export function visibleEfficiencyRange(points=[]){
  const values=[0];
  for(const row of points)for(const value of [finite(row.efficiency),finite(row.stable_efficiency)])if(value!==null)values.push(clamp(value));
  const observedMin=Math.min(...values),observedMax=Math.max(...values),span=observedMax-observedMin;
  const padding=Math.max(.05,span*.12);
  let min=clamp(observedMin-padding),max=clamp(observedMax+padding);
  if(max-min<.2){const center=(min+max)/2;min=clamp(center-.1);max=clamp(center+.1);}
  min=Math.min(min,0);max=Math.max(max,0);
  return {min,max,zoomed:min>EFFICIENCY_BOUNDS.min||max<EFFICIENCY_BOUNDS.max,observedMin,observedMax};
}

export function signedSegments(points=[]){
  const rows=[...points].filter(row=>finite(row.efficiency)!==null);
  const result=[];
  for(let index=1;index<rows.length;index++){
    const a=rows[index-1],b=rows[index],av=finite(a.efficiency),bv=finite(b.efficiency);
    if(av===null||bv===null)continue;
    if((av<0&&bv>0)||(av>0&&bv<0)){
      const ratio=Math.abs(av)/(Math.abs(av)+Math.abs(bv));
      const crossing={observation_at:new Date(stamp(a.observation_at)+(stamp(b.observation_at)-stamp(a.observation_at))*ratio).toISOString(),efficiency:0};
      result.push({sign:av>0?"positive":"negative",from:a,to:crossing});
      result.push({sign:bv>0?"positive":"negative",from:crossing,to:b});
    }else result.push({sign:av===0&&bv===0?"neutral":Math.max(av,bv)>0?"positive":"negative",from:a,to:b});
  }
  return result;
}

export function renderEfficiencyChart({symbol,timeframe,points=[],directionTimeline=[],freshness={}}){
  const series=stableEfficiency(points,directionTimeline),range=visibleEfficiencyRange(series),segments=signedSegments(series);
  if(!series.length)return `<div class="lppc-efficiency"><p class="empty">${esc(symbol)} ${esc(timeframe)} efficiency UNAVAILABLE.</p></div>`;
  const width=640,height=240,left=74,right=18,top=18,bottom=36,plotWidth=width-left-right,plotHeight=height-top-bottom;
  const first=stamp(series[0].observation_at),last=stamp(series.at(-1).observation_at),span=Math.max(last-first,1);
  const x=row=>left+(stamp(row.observation_at)-first)/span*plotWidth;
  const yValue=value=>top+(range.max-value)/(range.max-range.min)*plotHeight;
  const line=segment=>`<line x1="${x(segment.from).toFixed(2)}" y1="${yValue(finite(segment.from.efficiency)).toFixed(2)}" x2="${x(segment.to).toFixed(2)}" y2="${yValue(finite(segment.to.efficiency)).toFixed(2)}" class="eff-raw eff-${segment.sign}"/>`;
  const stable=series.filter(row=>finite(row.stable_efficiency)!==null).map((row,index)=>`${index?"L":"M"}${x(row).toFixed(2)},${yValue(finite(row.stable_efficiency)).toFixed(2)}`).join(" ");
  const ticks=[range.max,(range.max+range.min)/2,0,range.min].filter((value,index,array)=>array.findIndex(other=>Math.abs(other-value)<1e-6)===index).sort((a,b)=>b-a);
  const status=String(freshness.status||series.at(-1).source_status||"UNAVAILABLE").toUpperCase();
  const fullLabels=[[1,"+1"],[.5,"+0.5"],[0,"0"],[-.5,"−0.5"],[-1,"−1"]];
  return `<div class="lppc-efficiency-chart-v21" data-symbol="${esc(symbol)}" data-timeframe="${esc(timeframe)}" data-source-status="${esc(status)}">
    <div class="efficiency-meta"><strong>Signed Efficiency</strong><span class="freshness-${status.toLowerCase()}">${esc(status)}</span><small>Source ${esc(clock(freshness.newest_completed_at||series.at(-1).observation_at))}</small></div>
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(symbol)} ${esc(timeframe)} signed efficiency over time; vertical axis efficiency, horizontal axis time">
      <title>${esc(symbol)} ${esc(timeframe)} signed efficiency</title><desc>Green is positive signed efficiency, red is negative signed efficiency, and the thin white line is causal direction-adjusted stable efficiency.</desc>
      <g class="eff-full-domain-axis" aria-label="Full semantic efficiency domain">${fullLabels.map(([value,label])=>`<text x="2" y="${(top+(1-value)/2*plotHeight+4).toFixed(2)}">${label}</text>`).join("")}<line x1="42" x2="42" y1="${top}" y2="${top+plotHeight}"/></g>
      <rect x="${left}" y="${top}" width="${plotWidth}" height="${plotHeight}" class="eff-frame"/>
      ${ticks.map(value=>`<g class="eff-y-tick"><line x1="${left}" x2="${width-right}" y1="${yValue(value).toFixed(2)}" y2="${yValue(value).toFixed(2)}"/><text x="${left-7}" y="${(yValue(value)+4).toFixed(2)}">${value>0?"+":""}${value.toFixed(2)}</text></g>`).join("")}
      <line x1="${left}" x2="${width-right}" y1="${yValue(0).toFixed(2)}" y2="${yValue(0).toFixed(2)}" class="eff-zero"/>
      <g class="eff-raw-series">${segments.map(line).join("")}</g>${stable?`<path d="${stable}" class="eff-stable"/>`:""}
      <text class="axis-title" data-axis="y" x="12" y="${height/2}" transform="rotate(-90 12 ${height/2})">Signed efficiency</text>
      <text class="axis-title" data-axis="x" x="${left+plotWidth/2}" y="${height-5}">Time (CT)</text>
      <text class="eff-x-label" x="${left}" y="${height-20}">${esc(clock(series[0].observation_at))}</text><text class="eff-x-label" text-anchor="end" x="${width-right}" y="${height-20}">${esc(clock(series.at(-1).observation_at))}</text>
    </svg>
    <div class="eff-range">Visible Y range ${range.min.toFixed(2)} to ${range.max.toFixed(2)}${range.zoomed?" · zoomed within true −1 to +1 domain":""}</div>
    <div class="eff-legend"><span class="legend-positive">Green: Positive signed efficiency</span><span class="legend-negative">Red: Negative signed efficiency</span><span class="legend-stable">White: Direction-Adjusted Stable Efficiency</span><span>Zero line: Neutral efficiency</span></div>
  </div>`;
}
