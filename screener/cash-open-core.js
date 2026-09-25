import {tradingViewSymbols,tradingViewFilename} from "./tracking-core.js?v=4.0.0";

export const PAGES=new Set(["home","tracking","options-analysis","news"]);
export const QUALITY={EXCELLENT:5,GOOD:4,FAIR:3,THIN:2,POOR:1,UNAVAILABLE:0};
export const DEFAULT_FILTERS=Object.freeze({query:"",direction:"ALL",stage:"ALL",option:"ALL",sort:"opening-rank"});

export function route(hash=""){
  const parts=String(hash).replace(/^#\/?/,"").split("/").filter(Boolean);
  const demo=parts[0]==="demo",requested=demo?parts[1]:parts[0];
  return {demo,page:PAGES.has(requested)?requested:"home",redirect:Boolean(requested&&!PAGES.has(requested))};
}
export const href=(page,demo=false)=>`#/${demo?"demo/":""}${PAGES.has(page)?page:"home"}`;

export function newYorkDate(date=new Date()){
  const parts=new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(date);
  const get=type=>parts.find(part=>part.type===type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function normalizeCandidates(rows=[]){
  return rows.map(row=>({...row.payload,...row,
    symbol:row.symbol||row.payload?.symbol,
    company:row.payload?.name||row.payload?.company||row.symbol,
    gate_0845:Boolean(row.gate_0845),standard_0900:Boolean(row.standard_0900),
    selected_0900:Boolean(row.selected_0900)}));
}

const n=value=>value===null||value===undefined||value===""?null:Number.isFinite(Number(value))?Number(value):null;
const gateKey=row=>{
  const evidence=row.gate_0845_evidence||{};
  return [-(n(evidence.opening_volume_ratio)??-1),-(n(evidence.open_to_anchor_atr)??-1),
          -(n(evidence.opening_efficiency)??-1),row.symbol];
};
const compareKey=(a,b)=>{for(let i=0;i<Math.max(a.length,b.length);i++){
  const x=a[i],y=b[i],delta=typeof x==="number"&&typeof y==="number"?x-y:String(x).localeCompare(String(y));
  if(delta)return delta;
}return 0;};
export function focusRows(rows,direction){
  return rows.filter(row=>row.selected_0900&&row.lane===direction)
    .sort((a,b)=>(a.lane_rank??999)-(b.lane_rank??999)||a.symbol.localeCompare(b.symbol));
}
export function gateRows(rows){
  return rows.filter(row=>row.gate_0845&&!row.selected_0900)
    .sort((a,b)=>(a.gate_rank??999)-(b.gate_rank??999)||compareKey(gateKey(a),gateKey(b)));
}
export function trackingPopulation(rows){return rows.filter(row=>row.gate_0845||row.selected_0900);}
export function filterTracking(rows,filters=DEFAULT_FILTERS){
  const f={...DEFAULT_FILTERS,...filters},query=f.query.trim().toUpperCase();
  const filtered=trackingPopulation(rows).filter(row=>{
    if(query&&!`${row.symbol} ${row.company||""}`.toUpperCase().includes(query))return false;
    if(f.direction!=="ALL"&&row.direction!==f.direction)return false;
    if(f.stage==="FOCUS"&&!row.selected_0900)return false;
    if(f.stage==="GATE"&&(!row.gate_0845||row.selected_0900))return false;
    const quality=row.option_quality_current||row.option_quality_at_lock||"UNAVAILABLE";
    if(f.option==="FAIR+"&&(QUALITY[quality]??0)<QUALITY.FAIR)return false;
    if(f.option==="GOOD+"&&(QUALITY[quality]??0)<QUALITY.GOOD)return false;
    if(f.option!=="ALL"&&!f.option.endsWith("+")&&quality!==f.option)return false;
    return true;
  });
  const selectedLong=focusRows(filtered,"LONG"),selectedShort=focusRows(filtered,"SHORT");
  const gate=gateRows(filtered);
  if(f.sort!=="opening-rank")gate.sort((a,b)=>{
    const field=f.sort==="current-efficiency"?"current_efficiency":
      f.sort==="opening-efficiency"?"opening_efficiency":
      f.sort==="opening-volume"?"opening_volume_ratio":null;
    if(f.sort==="symbol")return a.symbol.localeCompare(b.symbol);
    const get=row=>n(field==="current_efficiency"?row.current_context?.[field]:
      (row.gate_0845_evidence||row.standard_0900_evidence||{})[field]);
    const x=get(a),y=get(b);
    if(x===null||y===null)return x===null&&y===null?a.symbol.localeCompare(b.symbol):x===null?1:-1;
    return y-x||a.symbol.localeCompare(b.symbol);
  });
  return {selectedLong,selectedShort,gate,count:filtered.length};
}

export function tradingViewExport(rows){
  // Export is intentionally independent of temporary Tracking filters.
  const ordered=[...focusRows(rows,"LONG"),...focusRows(rows,"SHORT"),...gateRows(rows)];
  return tradingViewSymbols(ordered);
}
export {tradingViewFilename};
