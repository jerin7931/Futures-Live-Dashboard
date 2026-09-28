export const EFFICIENCY_BOUNDS=Object.freeze({min:-1,max:1});
export const STABLE_SMA_LENGTH=5;
export const FRESHNESS_SECONDS=Object.freeze({M1:120,M5:360});

const finite=value=>value!==null&&value!==undefined&&Number.isFinite(Number(value))?Number(value):null;
const esc=value=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
const clamp=value=>Math.max(EFFICIENCY_BOUNDS.min,Math.min(EFFICIENCY_BOUNDS.max,value));
const stamp=value=>Number.isFinite(Date.parse(value||""))?Date.parse(value):null;
const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"America/Chicago",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false});
const clock=value=>stamp(value)===null?"—":new Date(value).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",timeZone:"America/Chicago"});
const dayOf=value=>{const parts=Object.fromEntries(formatter.formatToParts(new Date(value)).filter(x=>x.type!=="literal").map(x=>[x.type,x.value]));return `${parts.year}-${parts.month}-${parts.day}`;};
const minuteOf=value=>{const parts=Object.fromEntries(formatter.formatToParts(new Date(value)).filter(x=>x.type!=="literal").map(x=>[x.type,x.value]));return Number(parts.hour)%24*60+Number(parts.minute);};

export function zonedEpoch(day,hour,minute){
  const desired=Date.parse(`${day}T${String(hour).padStart(2,"0")}:${String(minute).padStart(2,"0")}:00Z`);
  let guess=desired;
  for(let index=0;index<3;index++){
    const parts=Object.fromEntries(formatter.formatToParts(new Date(guess)).filter(x=>x.type!=="literal").map(x=>[x.type,x.value]));
    const observed=Date.parse(`${parts.year}-${parts.month}-${parts.day}T${String(Number(parts.hour)%24).padStart(2,"0")}:${parts.minute}:00Z`);
    guess+=desired-observed;
  }
  return guess;
}

export function defaultEfficiencyViewport(sessionDate){
  return {xMin:zonedEpoch(sessionDate,8,30),xMax:zonedEpoch(sessionDate,15,0),yMin:-1,yMax:1};
}

export function efficiencyFreshness(timeframe,newestCompleted,now=Date.now()){
  const observed=stamp(newestCompleted),limit=FRESHNESS_SECONDS[timeframe];
  if(observed===null||!limit)return "UNAVAILABLE";
  const age=(now-observed)/1000;
  return age>=0&&age<=limit?"CURRENT":"STALE";
}

export function stableSignedEfficiency(points=[],length=STABLE_SMA_LENGTH){
  const rows=[...points].filter(row=>row.completed!==false&&finite(row.efficiency)!==null&&stamp(row.observation_at)!==null)
    .sort((a,b)=>stamp(a.observation_at)-stamp(b.observation_at));
  return rows.map((row,index)=>{
    const day=dayOf(stamp(row.observation_at));
    const window=rows.slice(0,index+1).filter(item=>dayOf(stamp(item.observation_at))===day).slice(-length);
    return {...row,efficiency:clamp(finite(row.efficiency)),stable_efficiency:window.reduce((sum,item)=>sum+clamp(finite(item.efficiency)),0)/window.length};
  });
}

export function signedSegments(points=[]){
  const rows=[...points].filter(row=>finite(row.efficiency)!==null);
  const result=[];
  for(let index=1;index<rows.length;index++){
    const a=rows[index-1],b=rows[index],av=finite(a.efficiency),bv=finite(b.efficiency);
    if((av<0&&bv>0)||(av>0&&bv<0)){
      const ratio=Math.abs(av)/(Math.abs(av)+Math.abs(bv));
      const crossing={observation_at:new Date(stamp(a.observation_at)+(stamp(b.observation_at)-stamp(a.observation_at))*ratio).toISOString(),efficiency:0};
      result.push({sign:av>0?"positive":"negative",from:a,to:crossing});
      result.push({sign:bv>0?"positive":"negative",from:crossing,to:b});
    }else result.push({sign:av===0&&bv===0?"neutral":Math.max(av,bv)>0?"positive":"negative",from:a,to:b});
  }
  return result;
}

const ticks=(min,max,count=5)=>Array.from({length:count},(_,index)=>max-(max-min)*index/(count-1));

export function renderEfficiencyChart({symbol,timeframe,points=[],freshness={},viewport=null,chartId=null,now=Date.now()}){
  const series=stableSignedEfficiency(points),fallbackDay=dayOf(now),sessionDate=series.length?dayOf(stamp(series.at(-1).observation_at)):fallbackDay;
  const defaults=defaultEfficiencyViewport(sessionDate),view=viewport||{...defaults,isUserModified:false};
  const visibleSeries=series.filter(row=>dayOf(stamp(row.observation_at))===sessionDate&&minuteOf(stamp(row.observation_at))>=8*60+35&&minuteOf(stamp(row.observation_at))<=15*60);
  const segments=signedSegments(visibleSeries),id=chartId||`efficiency:${symbol}:${timeframe}`;
  const width=700,height=270,left=72,right=18,top=20,bottom=46,plotWidth=width-left-right,plotHeight=height-top-bottom;
  const xValue=value=>left+(stamp(value)-view.xMin)/(view.xMax-view.xMin)*plotWidth;
  const yValue=value=>top+(view.yMax-value)/(view.yMax-view.yMin)*plotHeight;
  const rawLines=segments.map(segment=>`<line x1="${xValue(segment.from.observation_at).toFixed(2)}" y1="${yValue(finite(segment.from.efficiency)).toFixed(2)}" x2="${xValue(segment.to.observation_at).toFixed(2)}" y2="${yValue(finite(segment.to.efficiency)).toFixed(2)}" class="eff-raw eff-${segment.sign}"/>`).join("");
  const stablePath=visibleSeries.map((row,index)=>`${index?"L":"M"}${xValue(row.observation_at).toFixed(2)},${yValue(finite(row.stable_efficiency)).toFixed(2)}`).join(" ");
  const yTicks=view.isUserModified?ticks(view.yMin,view.yMax):[1,.5,0,-.5,-1];
  const defaultTimes=[[8,30],[9,0],[10,0],[11,0],[12,0],[13,0],[14,0],[15,0]];
  const xTicks=view.isUserModified?ticks(view.xMin,view.xMax).reverse().map(value=>new Date(value)):defaultTimes.map(([hour,minute])=>new Date(zonedEpoch(sessionDate,hour,minute)));
  const newest=freshness.newest_completed_at||visibleSeries.at(-1)?.observation_at||series.at(-1)?.observation_at;
  const status=efficiencyFreshness(timeframe,newest,now);
  const pointsMarkup=visibleSeries.filter(row=>stamp(row.observation_at)>=view.xMin&&stamp(row.observation_at)<=view.xMax&&finite(row.efficiency)>=view.yMin&&finite(row.efficiency)<=view.yMax).map((row,index)=>{
    const raw=finite(row.efficiency),stable=finite(row.stable_efficiency),label=`${clock(row.observation_at)} CT · Raw Efficiency: ${raw.toFixed(3)} · Stable Efficiency: ${stable.toFixed(3)}`;
    return `<circle data-chart-point data-point-id="${index}" data-px="${xValue(row.observation_at).toFixed(2)}" data-py="${yValue(raw).toFixed(2)}" data-tooltip="${esc(label)}" cx="${xValue(row.observation_at).toFixed(2)}" cy="${yValue(raw).toFixed(2)}" r="5" class="chart-hit-point"><title>${esc(label)}</title></circle>`;
  }).join("");
  const clipId=`clip-${id.replaceAll(":","-")}`;
  return `<div class="lppc-efficiency-chart-v22 interactive-chart-shell" data-interactive-chart data-chart-id="${esc(id)}" data-x-min="${view.xMin}" data-x-max="${view.xMax}" data-y-min="${view.yMin}" data-y-max="${view.yMax}" data-default-x-min="${defaults.xMin}" data-default-x-max="${defaults.xMax}" data-default-y-min="-1" data-default-y-max="1">
    <div class="efficiency-meta"><strong>Signed Efficiency</strong><span class="freshness-${status.toLowerCase()}">${status}</span><small>Source ${esc(clock(newest))}</small><button type="button" data-action="chart-reset" data-chart-id="${esc(id)}">Reset</button></div>
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(symbol)} ${esc(timeframe)} signed efficiency; time on X and efficiency on Y">
      <title>${esc(symbol)} ${esc(timeframe)} signed efficiency</title><desc>Raw positive efficiency is green, raw negative efficiency is red, Stable Signed Efficiency SMA-5 is blue, and zero is neutral.</desc>
      <defs><clipPath id="${esc(clipId)}"><rect x="${left}" y="${top}" width="${plotWidth}" height="${plotHeight}"/></clipPath></defs>
      <rect x="${left}" y="${top}" width="${plotWidth}" height="${plotHeight}" class="eff-frame"/>
      ${yTicks.map(value=>`<g class="eff-y-tick"><line x1="${left}" x2="${width-right}" y1="${yValue(value).toFixed(2)}" y2="${yValue(value).toFixed(2)}"/><text x="${left-7}" y="${(yValue(value)+4).toFixed(2)}">${value>0?"+":""}${value.toFixed(2)}</text></g>`).join("")}
      <line x1="${left}" x2="${width-right}" y1="${yValue(0).toFixed(2)}" y2="${yValue(0).toFixed(2)}" class="eff-zero"/>
      <g clip-path="url(#${esc(clipId)})"><g class="eff-raw-series">${rawLines}</g>${stablePath?`<path d="${stablePath}" class="eff-stable"/>`:""}${pointsMarkup}</g>
      <text class="axis-title" data-axis="y" x="12" y="${height/2}" transform="rotate(-90 12 ${height/2})">Signed efficiency</text>
      <text class="axis-title" data-axis="x" x="${left+plotWidth/2}" y="${height-4}">Time (America/Chicago)</text>
      ${xTicks.map((value,index)=>`<text class="eff-x-label" text-anchor="${index===0?"start":index===xTicks.length-1?"end":"middle"}" x="${xValue(value).toFixed(2)}" y="${height-25}">${esc(clock(value))}</text>`).join("")}
    </svg>
    <div class="chart-tooltip" role="status" aria-live="polite" hidden></div>
    <div class="eff-legend"><span class="legend-positive">Green = Positive Raw Signed Efficiency</span><span class="legend-negative">Red = Negative Raw Signed Efficiency</span><span class="legend-stable">Blue = Stable Signed Efficiency</span><span>Zero = Neutral</span></div>
  </div>`;
}
