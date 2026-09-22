export const ROUTES=Object.freeze(["home","opportunities","tracking","market","sectors","news","watchlist"]);
export const STATES=Object.freeze(["NO_TREND","EMERGING","CONFIRMING","CONFIRMED","DEGRADING","REVERSED"]);
export const SORTS=Object.freeze({
  newest:"Newest",changed:"Most Recently Changed",change1d:"1D Change",absolute1d:"Absolute 1D Move",
  move1:"1m Move",move5:"5m Move",move15:"15m Move",volume:"Live Volume",rvol:"Finviz RVOL",
  efficiency:"Efficiency",persistence:"Persistence",marketRelative:"Relative Strength vs Market",
  sectorRelative:"Relative Strength vs Sector",rankVelocity:"Finviz Rank Acceleration",
  catalyst:"Catalyst Freshness",symbol:"Symbol",efficiencyHigh:"Efficiency high–low",
  efficiencyLow:"Efficiency low–high",optionQuality:"Option quality best–worst",
  optionQualityReverse:"Option quality worst–best",optionSpread:"Option spread low–high",
  optionVolume:"Option volume high–low",optionOpenInterest:"Option OI high–low",
});

export function parseRoute(hash=""){
  const parts=String(hash).replace(/^#\/?/,"").split("/").filter(Boolean);
  const demo=parts[0]==="demo";
  const page=(demo?parts[1]:parts[0])||"home";
  return {demo,page:ROUTES.includes(page)?page:"home"};
}

export function routeHref(page,demo=false){return `#/${demo?"demo/":""}${ROUTES.includes(page)?page:"home"}`;}

export function defaultFilters(){return {query:"",directions:[],states:[],asset:"ALL",includeETFs:false,sector:"ALL",industry:"ALL",catalyst:"ALL",sensor:"ALL",efficiency:"ALL",optionQuality:"ALL",tracker:"ALL",watchlistOnly:false,freshOnly:false,sort:"newest",page:1,pageSize:15};}

const finite=value=>typeof value==="number"&&Number.isFinite(value);
const numeric=value=>value===null||value===undefined||value===""?null:Number.isFinite(Number(value))?Number(value):null;
const time=value=>{const n=Date.parse(value||"");return Number.isFinite(n)?n:0;};
const hasFreshNews=row=>(row.news||[]).some(news=>news.first_seen_at&&Date.now()-time(news.first_seen_at)<=60*60*1000);
const qualityOrder=Object.freeze({EXCELLENT:6,GOOD:5,FAIR:4,THIN:3,POOR:2,READY:2,LOADING_QUOTES:1,
  LOADING_CONTRACTS:1,QUEUED:1,RETRY_PENDING:1,CAPACITY_DEFERRED:1,ERROR_RETRYABLE:0,UNAVAILABLE:0,NOT_REQUIRED:-1});
export function optionSortReference(row){
  const contracts=row.option_execution_quality?.contracts||[];
  return contracts.find(value=>value.dte===1)||contracts.find(value=>value.dte===0)||[...contracts].sort((a,b)=>(a.dte??999)-(b.dte??999))[0]||null;
}
const valueForSort=(row,key)=>({
  newest:time(row.first_nominated_at),changed:time(row.state_changed_at),change1d:row.change_1d_pct,
  absolute1d:finite(row.change_1d_pct)?Math.abs(row.change_1d_pct):null,move1:row.move_1m_pct,
  move5:row.move_5m_pct,move15:row.move_15m_pct,volume:row.session_volume,rvol:row.finviz_rvol,
  efficiency:row.efficiency,persistence:row.persistence,marketRelative:row.market_relative,
  sectorRelative:row.sector_relative,rankVelocity:row.rank_velocity,
  catalyst:Math.max(0,...(row.news||[]).map(item=>time(item.first_seen_at))),symbol:row.symbol,
  efficiencyHigh:row.efficiency,efficiencyLow:row.efficiency,
  optionQuality:qualityOrder[row.option_quality],optionQualityReverse:qualityOrder[row.option_quality],
  optionSpread:numeric(optionSortReference(row)?.spread_pct),optionVolume:numeric(optionSortReference(row)?.volume),
  optionOpenInterest:numeric(optionSortReference(row)?.open_interest),
}[key]);

export function filterOpportunities(rows,filters,watchlist=new Set()){
  const f={...defaultFilters(),...(filters||{})};
  const query=String(f.query||"").trim().toLowerCase();
  const filtered=(rows||[]).filter(row=>{
    if(query&&!`${row.symbol||""} ${row.company_name||""}`.toLowerCase().includes(query))return false;
    if(f.directions.length&&!f.directions.includes(row.v1_direction))return false;
    if(f.states.length&&!f.states.includes(row.v1_state))return false;
    if(f.asset!=="ALL"&&String(row.asset_type||"").toUpperCase()!==f.asset)return false;
    if(!f.includeETFs&&f.asset!=="ETF"&&String(row.asset_type||"").toUpperCase()==="ETF")return false;
    if(f.sector!=="ALL"&&row.sector!==f.sector)return false;
    if(f.industry!=="ALL"&&row.industry!==f.industry)return false;
    if(f.catalyst==="FRESH"&&!hasFreshNews(row))return false;
    if(f.catalyst==="NONE"&&(row.news||[]).length)return false;
    if(f.catalyst==="ANY"&&!(row.news||[]).length)return false;
    if(f.sensor!=="ALL"&&!(row.finviz_sensors||[]).some(value=>value.sensor===f.sensor))return false;
    if(f.efficiency!=="ALL"&&(row.efficiency===null||row.efficiency===undefined||Number(row.efficiency)<Number(f.efficiency)))return false;
    if(f.tracker!=="ALL"&&row.tracker_state!==f.tracker)return false;
    if(f.optionQuality!=="ALL"){
      const quality=row.option_quality||row.option_status||"NOT_REQUIRED";
      if(f.optionQuality.endsWith("+")){
        const floor=qualityOrder[f.optionQuality.slice(0,-1)];if((qualityOrder[quality]??-1)<floor)return false;
      }else if(quality!==f.optionQuality)return false;
    }
    if(f.watchlistOnly&&!watchlist.has(row.symbol))return false;
    if(f.freshOnly&&!([row.freshness?.quote,row.freshness?.bar,row.freshness?.finviz].every(value=>value?.state==="LIVE")))return false;
    return true;
  });
  return stableSort(filtered,f.sort);
}

export function stableSort(rows,key="newest"){
  return rows.map((row,index)=>({row,index})).sort((a,b)=>{
    const av=valueForSort(a.row,key),bv=valueForSort(b.row,key);
    if(key==="symbol")return String(av||"").localeCompare(String(bv||""))||a.index-b.index;
    const aMissing=av===null||av===undefined||av==="",bMissing=bv===null||bv===undefined||bv==="";
    if(aMissing!==bMissing)return aMissing?1:-1;
    if(aMissing&&bMissing)return String(a.row.symbol).localeCompare(String(b.row.symbol))||a.index-b.index;
    const an=finite(av)?av:Number(av),bn=finite(bv)?bv:Number(bv);
    const ascending=new Set(["efficiencyLow","optionQualityReverse","optionSpread"]);
    return (ascending.has(key)?an-bn:bn-an)||String(a.row.symbol).localeCompare(String(b.row.symbol))||a.index-b.index;
  }).map(value=>value.row);
}

export function paginate(rows,page=1,pageSize=15){
  const pages=Math.max(1,Math.ceil((rows||[]).length/pageSize));const current=Math.min(Math.max(1,Number(page)||1),pages);
  return {rows:(rows||[]).slice((current-1)*pageSize,current*pageSize),page:current,pages,total:(rows||[]).length,pageSize};
}

export function availableIndustries(rows,sector="ALL"){
  return [...new Set((rows||[]).filter(row=>sector==="ALL"||row.sector===sector).map(row=>row.industry).filter(Boolean))].sort();
}

export function dashboardStatus(model,now=Date.now()){
  if(!model)return {state:"UNAVAILABLE",message:"Waiting for the normalized dashboard projection."};
  const at=time(model.as_of);if(!at)return {state:"UNAVAILABLE",message:"Snapshot timestamp unavailable."};
  const age=Math.max(0,(now-at)/1000);
  return age<=30?{state:"LIVE",age}:{state:age<=150?"DELAYED":"STALE",age,message:"Snapshot is older than the expected live cadence."};
}

export function normalizedLive(payload,symbolRows=[]){
  const model=payload?.dashboard;
  if(!model||!["FOS_LIVE_DASHBOARD_1","FOS_LIVE_DASHBOARD_2"].includes(model.schema_version))return null;
  const details=new Map((symbolRows||[]).map(row=>[row.symbol,row.payload?.opportunity]).filter(([,value])=>value));
  const current=Date.now();let changed=false;
  const opportunities=(model.opportunities||[]).map(summary=>{
    const row=details.get(summary.symbol)?{...summary,...details.get(summary.symbol)}:summary;
    const context=row.option_execution_quality,expires=time(context?.valid_until);
    if(!context||!expires||expires>current)return row;
    changed=true;
    return {...row,option_quality:null,option_status:"RETRY_PENDING",option_reason_code:"BROWSER_EXPIRED_OPTION_CONTEXT",
      option_execution_quality:{...context,state:"RETRY_PENDING",option_status:"RETRY_PENDING",contracts:[],
      reason_codes:[...(context.reason_codes||[]),"BROWSER_EXPIRED_OPTION_CONTEXT"]}};
  });
  return changed||details.size?{...model,opportunities}:model;
}

export function filterNews(rows,{scope="ALL",category="ALL",symbol="",sector="ALL",range="ALL",sort="firstSeen"}={}){
  const ticker=String(symbol||"").trim().toUpperCase();const now=Date.now();
  const filtered=(rows||[]).filter(row=>{
    if(scope!=="ALL"&&row.scope!==scope)return false;
    if(category!=="ALL"&&row.category!==category)return false;
    if(ticker&&!(row.symbols||[]).some(value=>value.includes(ticker)))return false;
    if(sector!=="ALL"&&!(row.sector||[]).includes(sector))return false;
    if(range!=="ALL"){
      const hours=Number(range);if(!Number.isFinite(hours)||now-time(row.first_seen_at)>hours*3600000)return false;
    }
    return true;
  });
  const field=sort==="published"?"publication_at":"first_seen_at";
  return filtered.map((row,index)=>({row,index})).sort((a,b)=>time(b.row[field])-time(a.row[field])||a.index-b.index).map(value=>value.row);
}

export function selectOpportunity(model,symbol){return (model?.opportunities||[]).find(row=>row.symbol===symbol)||null;}
