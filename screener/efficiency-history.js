export const EFFICIENCY_PAGE_SIZE=1000;
export const EFFICIENCY_MAX_PAGES=8;
export const EFFICIENCY_OVERLAP_MINUTES=15;

export function efficiencyIdentity(row){
  return `${row.symbol}\u0000${row.timeframe}\u0000${row.observation_at}`;
}

export function compareEfficiencyRows(left,right){
  return String(left.observation_at).localeCompare(String(right.observation_at))||
    String(left.symbol).localeCompare(String(right.symbol))||
    String(left.timeframe).localeCompare(String(right.timeframe));
}

export function mergeEfficiencyRows(existing,incoming,sessionDate){
  const merged=new Map();
  for(const row of [...existing,...incoming]){
    if(String(row.session_date)!==sessionDate)continue;
    merged.set(efficiencyIdentity(row),row);
  }
  return [...merged.values()].sort(compareEfficiencyRows);
}

export function attachObservationScores(efficiencyRows,observationRows){
  const scores=new Map(observationRows.filter(row=>row.symbol!=="SPX").map(row=>[efficiencyIdentity(row),row.model_score]));
  return efficiencyRows.map(row=>row.symbol!=="SPX"&&scores.has(efficiencyIdentity(row))?{...row,model_score:scores.get(efficiencyIdentity(row))}:row);
}

export async function loadEfficiencyPages(fetchPage,{pageSize=EFFICIENCY_PAGE_SIZE,maxPages=EFFICIENCY_MAX_PAGES}={}){
  if(!Number.isInteger(pageSize)||pageSize<1||pageSize>1000)throw new Error("EFFICIENCY_PAGE_SIZE_INVALID");
  if(!Number.isInteger(maxPages)||maxPages<1)throw new Error("EFFICIENCY_PAGE_CAP_INVALID");
  const rows=[];
  const ranges=[];
  for(let page=0;page<maxPages;page+=1){
    const from=page*pageSize,to=from+pageSize-1;
    const batch=await fetchPage(from,to);
    if(!Array.isArray(batch))throw new Error("EFFICIENCY_PAGE_INVALID");
    ranges.push({from,to,returned:batch.length});
    rows.push(...batch);
    if(batch.length<pageSize)return {rows,ranges};
  }
  throw new Error("EFFICIENCY_PAGE_SAFETY_CAP_REACHED");
}

export function latestEfficiencyObservation(rows){
  return rows.reduce((latest,row)=>String(row.observation_at)>latest?String(row.observation_at):latest,"");
}

export function overlapStart(latest,minutes=EFFICIENCY_OVERLAP_MINUTES){
  const time=Date.parse(latest);
  if(!Number.isFinite(time))return null;
  return new Date(time-minutes*60000).toISOString();
}
