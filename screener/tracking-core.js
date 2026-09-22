export const TRACKER_TERMINAL=new Set(["INVALIDATED","SESSION_EXPIRED"]);
export const TRACKER_SORTS=Object.freeze({
  newest:"Newest confirmed",oldest:"Oldest confirmed",aligned:"Newest first alignment",
  invalidated:"Newest invalidated",efficiencyHigh:"Efficiency high–low",
  efficiencyLow:"Efficiency low–high",atrPercent:"ATR % high–low",
  atrDollars:"ATR $ high–low",movement:"Movement quality",optionQuality:"Option quality best–worst",
  optionSpread:"Option spread low–high",optionVolume:"Option volume high–low",
  optionOI:"Option OI high–low",volume:"Volume high–low",rvol:"RVOL high–low",
  change1d:"1D change",move5:"5m move",symbol:"Symbol A–Z",sector:"Sector",
  status:"Tracker status",v1:"Current V1 state",
});
const quality={EXCELLENT:5,GOOD:4,FAIR:3,THIN:2,POOR:1,UNAVAILABLE:0};
const movement={HIGH:3,GOOD:2,ACCEPTABLE:1,INELIGIBLE:0};
const num=value=>value===null||value===undefined||value===""?null:Number.isFinite(Number(value))?Number(value):null;
const at=value=>Number.isFinite(Date.parse(value||""))?Date.parse(value):null;
const reference=row=>row.option_execution_quality?.contracts?.find(value=>value.dte===1)
  ||row.option_execution_quality?.contracts?.[0]||null;

export function defaultTrackerFilters(){return {
  query:"",direction:"ALL",status:"ALL",v1:"ALL",movement:"ALL",atrPercent:"ALL",
  efficiency:"ALL",optionQuality:"ALL",sector:"ALL",industry:"ALL",data:"ALL",
  nonterminalOnly:false,sort:"default",
};}

export function hydrateTrackerRows(model){
  const opportunities=new Map((model?.opportunities||[]).map(row=>[row.symbol,row]));
  return (model?.tracked_lifecycles||[]).filter(row=>row?.id&&row?.symbol).map(row=>{
    const current=TRACKER_TERMINAL.has(row.tracker_state)?null:opportunities.get(row.symbol);
    const option=current?.confirmed_tracker?.id===row.id?current.option_execution_quality:row.last_option_context||null;
    return {...row,company_name:row.company_name||current?.company_name||"",
      sector:row.sector||current?.sector||null,industry:row.industry||current?.industry||null,
      efficiency:num(row.confirmation_efficiency??current?.efficiency),
      atr_dollars:num(row.atr_dollars),atr_percent:num(row.atr_percent),
      option_execution_quality:option,option_quality:option?.overall_quality||"UNAVAILABLE",
      session_volume:current?.session_volume??null,finviz_rvol:current?.finviz_rvol??null,
      change_1d_pct:current?.change_1d_pct??null,move_5m_pct:current?.move_5m_pct??null,
      v1_state:row.v1_state||row.last_v1_state||"UNKNOWN"};
  });
}

const qualityAtLeast=(value,required)=>quality[value]>=quality[required];
export function filterTracked(rows,filters){
  const f={...defaultTrackerFilters(),...(filters||{})};const query=f.query.trim().toLowerCase();
  const result=(rows||[]).filter(row=>{
    if(query&&!`${row.symbol} ${row.company_name}`.toLowerCase().includes(query))return false;
    if(f.direction!=="ALL"&&row.direction!==f.direction)return false;
    if(f.status!=="ALL"){
      if(f.status==="ACTIVE"&&TRACKER_TERMINAL.has(row.tracker_state))return false;
      else if(f.status!=="ACTIVE"&&row.tracker_state!==f.status)return false;
    }
    if(f.v1!=="ALL"&&row.v1_state!==f.v1)return false;
    if(f.movement!=="ALL"){
      const floor=f.movement.replace("+","");
      if((movement[row.movement_quality]??-1)<(movement[floor]??99))return false;
    }
    if(f.atrPercent!=="ALL"&&(num(row.atr_percent)??-1)<Number(f.atrPercent))return false;
    if(f.efficiency!=="ALL"&&(num(row.efficiency)??-1)<Number(f.efficiency))return false;
    if(f.optionQuality!=="ALL"){
      if(f.optionQuality.endsWith("+")&&!qualityAtLeast(row.option_quality,f.optionQuality.slice(0,-1)))return false;
      if(!f.optionQuality.endsWith("+")&&row.option_quality!==f.optionQuality)return false;
    }
    if(f.sector!=="ALL"&&row.sector!==f.sector)return false;
    if(f.industry!=="ALL"&&row.industry!==f.industry)return false;
    if(f.data!=="ALL"&&row.data_status!==f.data)return false;
    if(f.nonterminalOnly&&TRACKER_TERMINAL.has(row.tracker_state))return false;
    return true;
  });
  return sortTracked(result,f.sort);
}

const sortValue=(row,key)=>({newest:at(row.first_confirmed_at),oldest:at(row.first_confirmed_at),
  aligned:at(row.first_alignment_at),invalidated:at(row.invalidated_at),
  efficiencyHigh:num(row.efficiency),efficiencyLow:num(row.efficiency),
  atrPercent:num(row.atr_percent),atrDollars:num(row.atr_dollars),movement:movement[row.movement_quality],
  optionQuality:quality[row.option_quality],optionSpread:num(reference(row)?.spread_pct),
  optionVolume:num(reference(row)?.volume),optionOI:num(reference(row)?.open_interest),
  volume:num(row.session_volume),rvol:num(row.finviz_rvol),change1d:num(row.change_1d_pct),
  move5:num(row.move_5m_pct),symbol:row.symbol,sector:row.sector,status:row.tracker_state,v1:row.v1_state}[key]);
export function sortTracked(rows,key="default"){
  const textKeys=new Set(["symbol","sector","status","v1"]);
  return [...(rows||[])].sort((a,b)=>{
    if(key==="default"){
      const terminal=Number(TRACKER_TERMINAL.has(a.tracker_state))-Number(TRACKER_TERMINAL.has(b.tracker_state));
      if(terminal)return terminal;
      const aligned=(at(b.first_alignment_at)||0)-(at(a.first_alignment_at)||0);
      if(aligned)return aligned;
      return (at(b.first_confirmed_at)||0)-(at(a.first_confirmed_at)||0)||a.id.localeCompare(b.id);
    }
    const av=sortValue(a,key),bv=sortValue(b,key);
    if(av==null||bv==null){if(av==null&&bv!=null)return 1;if(bv==null&&av!=null)return -1;}
    if(textKeys.has(key))return String(av||"").localeCompare(String(bv||""))||a.id.localeCompare(b.id);
    const delta=(key==="oldest"||key==="efficiencyLow"||key==="optionSpread")?(av-bv):(bv-av);
    return delta||a.id.localeCompare(b.id);
  });
}
