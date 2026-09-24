export const TRACKER_TERMINAL=new Set(["INVALIDATED","SESSION_EXPIRED"]);
export const TRACKER_SORTS=Object.freeze({
  newest:"Newest confirmed",oldest:"Oldest confirmed",aligned:"Newest first alignment",
  invalidated:"Newest invalidated",
  confirmationEfficiencyHigh:"Confirmation Efficiency — High to Low",
  confirmationEfficiencyLow:"Confirmation Efficiency — Low to High",
  currentEfficiencyHigh:"Current Efficiency — High to Low",
  currentEfficiencyLow:"Current Efficiency — Low to High",
  atrFibShallow:"5m ATR Pullback — Shallow to Deep",
  atrFibDeep:"5m ATR Pullback — Deep to Shallow",
  atrPercent:"ATR % high–low",
  atrDollars:"ATR $ high–low",movement:"Movement quality",optionQuality:"Option quality best–worst",
  optionSpread:"Option spread low–high",optionVolume:"Option volume high–low",
  optionOI:"Option OI high–low",volume:"Volume high–low",rvol:"RVOL high–low",
  change1d:"1D change",move5:"5m move",symbol:"Symbol A–Z",sector:"Sector",
  status:"Tracker status",v1:"Current V1 state",
});
const quality={EXCELLENT:5,GOOD:4,FAIR:3,THIN:2,POOR:1,UNAVAILABLE:0};
const observedQualities=new Set(["EXCELLENT","GOOD","FAIR","THIN","POOR"]);
const movement={HIGH:4,GOOD:3,ACCEPTABLE:2,DOLLAR_MOVER:1,INELIGIBLE:0};
export const TRACKER_FIELDS=Object.freeze({
  direction:{label:"Direction",values:["LONG","SHORT"]},
  status:{label:"Tracker Status",values:["TRACKING","WEAKENING","RECOVERING","INVALIDATION_PENDING","INVALIDATED","SESSION_EXPIRED"]},
  alignment:{label:"Alignment / Section",values:["ALIGNED","COUNTERTREND","UNKNOWN"]},
  v1:{label:"Current V1 State",values:["NO_TREND","EMERGING","CONFIRMING","CONFIRMED","DEGRADING","REVERSED"]},
  movement:{label:"Movement Quality",values:["HIGH","GOOD","ACCEPTABLE","DOLLAR_MOVER","INELIGIBLE"]},
  atrPercent:{label:"ATR %",numeric:true},confirmationEfficiency:{label:"Efficiency @ Confirmation",numeric:true},
  efficiency:{label:"Current Efficiency",numeric:true},atrFibPullback:{label:"5m ATR Pullback %",numeric:true},
  atrFibZone:{label:"5m ATR Pullback Zone",values:["EXTENSION","0_TO_50","50_TO_61_8","61_8_TO_78_6","78_6_TO_88_6","88_6_TO_TRAIL","BEYOND_TRAIL"]},
  optionQuality:{label:"Option Quality",values:["EXCELLENT","GOOD","FAIR","THIN","POOR","UNAVAILABLE"],ordered:true},
  sector:{label:"Sector",values:[]},industry:{label:"Industry",values:[]},
  data:{label:"Data Status",values:["FRESH","STALE","DELAYED","UNAVAILABLE"]},
  nonterminalOnly:{label:"Nonterminal Only",boolean:true},
});
export const HIGH_QUALITY_RULES=Object.freeze([
  {field:"alignment",operator:"is",value:"ALIGNED"},
  {field:"confirmationEfficiency",operator:">=",value:0.8},
  {field:"optionQuality",operator:">=",value:"GOOD"},
]);
export function highQualityTrackerFilters(){return {...defaultTrackerFilters(),rules:HIGH_QUALITY_RULES.map(rule=>({...rule}))};}
export function validTrackerRules(rules){return (Array.isArray(rules)?rules:[]).filter(rule=>{
  const field=TRACKER_FIELDS[rule?.field];
  if(!field)return false;
  if(field.numeric)return [">",">=","<","<=","=","between"].includes(rule.operator)&&Number.isFinite(Number(rule.value))&&(rule.operator!=="between"||Number.isFinite(Number(rule.value2)));
  if(field.boolean)return typeof rule.value==="boolean";
  return ["is","is not","is one of",...(field.ordered?[">=","<="]:[])].includes(rule.operator)&&typeof rule.value==="string";
});}
function ruleValue(row,field){return ({direction:row.direction,status:row.tracker_state,alignment:row.alignment,
  v1:row.v1_state,movement:row.movement_quality,atrPercent:row.atr_percent,
  confirmationEfficiency:row.efficiency_at_confirmation,efficiency:row.current_efficiency,
  atrFibPullback:row.atr_fib?.status==="CURRENT"?row.atr_fib.pullback_pct_raw:null,
  atrFibZone:row.atr_fib?.zone,optionQuality:row.option_quality,sector:row.sector,
  industry:row.industry,data:row.data_status,nonterminalOnly:!TRACKER_TERMINAL.has(row.tracker_state)})[field];}
export function matchesTrackerRule(row,rule){
  const field=TRACKER_FIELDS[rule.field];if(!field)return false;
  const actual=ruleValue(row,rule.field);
  if(field.boolean)return actual===rule.value;
  if(field.numeric){const value=num(actual),bound=num(rule.value),upper=num(rule.value2);if(value===null||bound===null)return false;
    return ({">":()=>value>bound,">=":()=>value>=bound,"<":()=>value<bound,"<=":()=>value<=bound,"=":()=>value===bound,
      between:()=>upper!==null&&value>=Math.min(bound,upper)&&value<=Math.max(bound,upper)})[rule.operator]?.()??false;}
  if(field.ordered&&[">=","<="].includes(rule.operator)){
    const a=quality[String(actual||"UNAVAILABLE")],b=quality[rule.value];
    return a!==undefined&&b!==undefined&&(rule.operator===">="?a>=b:a<=b);
  }
  if(rule.operator==="is one of")return String(rule.value).split(",").map(v=>v.trim()).includes(String(actual));
  return rule.operator==="is"?actual===rule.value:rule.operator==="is not"?actual!==rule.value:false;
}
const num=value=>value===null||value===undefined||value===""?null:Number.isFinite(Number(value))?Number(value):null;
const at=value=>Number.isFinite(Date.parse(value||""))?Date.parse(value):null;
const reference=row=>row.option_execution_quality?.contracts?.find(value=>value.dte===1)
  ||row.option_execution_quality?.contracts?.[0]||null;

export function defaultTrackerFilters(){return {
  query:"",direction:"ALL",status:"ALL",v1:"ALL",movement:"ALL",atrPercent:"ALL",
  efficiency:"ALL",confirmationEfficiency:"ALL",atrFibZone:"ALL",optionQuality:"ALL",sector:"ALL",industry:"ALL",data:"ALL",
  nonterminalOnly:false,sort:"default",rules:[],
};}

// A failed or incomplete paged read must not erase a previously complete
// owner/session snapshot. A successful empty read is authoritative.
export function resolveTrackerHistory(previous,read,{ownerId,day}){
  const sameScope=previous?.ownerId===ownerId&&previous?.day===day;
  if(read.state==="READY"){
    const rows=read.rows||[];
    return {cache:{ownerId,day,rows},rows,state:"READY"};
  }
  return {cache:sameScope?previous:null,
    rows:sameScope?previous.rows:(read.rows||[]),state:read.state};
}

// Remember only the most recent observed classification, never quotes or
// contracts. This is a historical filter value, not current option evidence.
export function rememberTrackerOptionQuality(previous,model,{ownerId,day}){
  const sameScope=previous?.ownerId===ownerId&&previous?.day===day;
  const values=sameScope?{...previous.values}:{};
  const opportunities=new Map((model?.opportunities||[]).map(row=>[row.symbol,row]));
  for(const tracker of model?.tracked_lifecycles||[]){
    if(!tracker?.id||!tracker?.symbol)continue;
    const current=opportunities.get(tracker.symbol);
    const live=current?.confirmed_tracker?.id===tracker.id?current.option_execution_quality:null;
    const retained=tracker.last_option_context?.tracker_id===tracker.id?tracker.last_option_context:null;
    const context=live||retained;
    const observedAt=context?.updated_at||context?.last_option_refresh;
    if(!observedQualities.has(context?.overall_quality)||!at(observedAt))continue;
    if(!values[tracker.id]||at(observedAt)>=at(values[tracker.id].observed_at)){
      values[tracker.id]={quality:context.overall_quality,observed_at:observedAt};
    }
  }
  return {ownerId,day,values};
}

export function hydrateTrackerRows(model,now=Date.now()){
  const opportunities=new Map((model?.opportunities||[]).map(row=>[row.symbol,row]));
  return (model?.tracked_lifecycles||[]).filter(row=>row?.id&&row?.symbol).map(row=>{
    const current=TRACKER_TERMINAL.has(row.tracker_state)?null:opportunities.get(row.symbol);
    const option=current?.confirmed_tracker?.id===row.id?current.option_execution_quality:row.last_option_context||null;
    const remembered=model?.tracker_option_quality_memory?.[row.id];
    const observedQuality=remembered?.quality||option?.overall_quality||"UNAVAILABLE";
    const optionCurrent=!TRACKER_TERMINAL.has(row.tracker_state)
      &&option?.tracker_id===row.id&&observedQualities.has(option?.overall_quality)
      &&["AVAILABLE","PARTIAL"].includes(option?.state)
      &&at(option?.valid_until)>Date.now();
    const fib=(model?.tracker_levels_by_tracker_id||{})[row.id]?.levels?.atr_5m_fib||null;
    const structureAge=now-at(fib?.structure_as_of),priceAge=now-at(fib?.price_as_of);
    const fibCurrent=fib?.status==="CURRENT"&&structureAge>=0&&structureAge<=480000&&priceAge>=0&&priceAge<=65000;
    return {...row,company_name:row.company_name||current?.company_name||"",
      exchange_code:current?.exchange_code||row.exchange_code||null,
      sector:row.sector||current?.sector||null,industry:row.industry||current?.industry||null,
      efficiency_at_confirmation:num(row.efficiency_at_confirmation??row.confirmation_efficiency),
      current_efficiency:num(row.current_efficiency??row.confirmation_efficiency),
      atr_fib:TRACKER_TERMINAL.has(row.tracker_state)?fib:fibCurrent?fib:{status:"UNAVAILABLE",reason:fib?.reason||"SOURCE_EXPIRED"},
      atr_dollars:num(row.atr_dollars),atr_percent:num(row.atr_percent),
      option_execution_quality:option,option_quality:observedQuality,
      option_quality_current:optionCurrent,option_quality_observed_at:remembered?.observed_at||option?.updated_at||null,
      session_volume:current?.session_volume??null,finviz_rvol:current?.finviz_rvol??null,
      change_1d_pct:current?.change_1d_pct??null,move_5m_pct:current?.move_5m_pct??null,
      ai_analysis:(model?.ai_analysis_by_tracker_id||{})[row.id]||null,
      v1_state:row.v1_state||row.last_v1_state||"UNKNOWN"};
  });
}

const qualityAtLeast=(value,required)=>quality[value]>=quality[required];
export function filterTracked(rows,filters){
  const f={...defaultTrackerFilters(),...(filters||{})};const query=f.query.trim().toLowerCase();
  const rules=validTrackerRules(f.rules);
  const result=(rows||[]).filter(row=>{
    if(!rules.every(rule=>matchesTrackerRule(row,rule)))return false;
    if(query&&!`${row.symbol} ${row.company_name}`.toLowerCase().includes(query))return false;
    if(f.direction!=="ALL"&&row.direction!==f.direction)return false;
    if(f.status!=="ALL"){
      if(f.status==="ACTIVE"&&TRACKER_TERMINAL.has(row.tracker_state))return false;
      else if(f.status!=="ACTIVE"&&row.tracker_state!==f.status)return false;
    }
    if(f.v1!=="ALL"&&row.v1_state!==f.v1)return false;
    if(f.movement!=="ALL"){
      const allowed={HIGH:["HIGH"],"GOOD+":["HIGH","GOOD"],
        "ACCEPTABLE+":["HIGH","GOOD","ACCEPTABLE"],DOLLAR_MOVER:["DOLLAR_MOVER"]};
      if(!(allowed[f.movement]||[]).includes(row.movement_quality))return false;
    }
    if(f.atrPercent!=="ALL"&&(num(row.atr_percent)??-1)<Number(f.atrPercent))return false;
    if(f.efficiency!=="ALL"&&(num(row.current_efficiency)??-1)<Number(f.efficiency))return false;
    if(f.confirmationEfficiency!=="ALL"&&(num(row.efficiency_at_confirmation)??-1)<Number(f.confirmationEfficiency))return false;
    if(f.atrFibZone!=="ALL"&&row.atr_fib?.zone!==f.atrFibZone)return false;
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

const TRADINGVIEW_DEFAULT_SYMBOLS=["SPCFD:SPX","AMEX:SPY","NASDAQ:QQQ","AMEX:IWM"];

// Pin the four benchmark symbols, then use exchange evidence already carried by filtered tracker rows.
export function tradingViewSymbols(rows){
  const exchanges={XNAS:"NASDAQ",XNYS:"NYSE",XASE:"AMEX",NSQ:"NASDAQ",NMS:"NASDAQ",NAS:"NASDAQ",ASE:"AMEX",NASDAQ:"NASDAQ",NYSE:"NYSE",AMEX:"AMEX"};
  const symbols=[...TRADINGVIEW_DEFAULT_SYMBOLS],seen=new Set(symbols);let unmapped=0;
  for(const row of rows||[]){
    const ticker=String(row?.symbol||"").trim().toUpperCase();
    if(["SPX","SPY","QQQ","IWM"].includes(ticker))continue;
    const direct=String(row?.tradingview_symbol||"").trim().toUpperCase();
    const venue=String(row?.exchange_code||row?.listing_exchange||row?.exchange||"").trim().toUpperCase();
    const mapped=exchanges[venue]||(venue==="PSE"&&["SPY","IWM"].includes(ticker)?"AMEX":null);
    const qualified=/^(NASDAQ|NYSE|AMEX):[A-Z0-9][A-Z0-9.-]*$/.test(direct)&&direct.split(":")[1]===ticker
      ?direct:mapped&&/^[A-Z0-9][A-Z0-9.-]*$/.test(ticker)?`${mapped}:${ticker}`:null;
    if(!qualified){unmapped++;continue;}
    if(!seen.has(qualified)){seen.add(qualified);symbols.push(qualified);}
  }
  return {symbols,text:symbols.join(","),unmapped};
}

export function tradingViewFilename(date=new Date()){
  const pad=value=>String(value).padStart(2,"0");
  return `FOS_TradingView_${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}.txt`;
}

const sortValue=(row,key)=>({newest:at(row.first_confirmed_at),oldest:at(row.first_confirmed_at),
  aligned:at(row.first_alignment_at),invalidated:at(row.invalidated_at),
  confirmationEfficiencyHigh:num(row.efficiency_at_confirmation),
  confirmationEfficiencyLow:num(row.efficiency_at_confirmation),
  currentEfficiencyHigh:num(row.current_efficiency),currentEfficiencyLow:num(row.current_efficiency),
  atrFibShallow:num(row.atr_fib?.pullback_pct_raw),atrFibDeep:num(row.atr_fib?.pullback_pct_raw),
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
    const delta=(key==="oldest"||key==="confirmationEfficiencyLow"||key==="currentEfficiencyLow"||key==="atrFibShallow"||key==="optionSpread")?(av-bv):(bv-av);
    return delta||a.id.localeCompare(b.id);
  });
}
