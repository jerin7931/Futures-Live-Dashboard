export const CHAIN_SYMBOLS=Object.freeze(["SPX","QQQ","IWM","SPY"]);
const number=value=>value===null||value===undefined||value===""?null:Number.isFinite(Number(value))?Number(value):null;

export function strictZeroDte(rows=[],sessionDate){
  return rows.filter(row=>CHAIN_SYMBOLS.includes(row.underlying)&&row.session_date===sessionDate&&row.expiration_date===sessionDate);
}

export function dynamicAskRange(rows=[]){
  const asks=rows.map(row=>number(row.ask)).filter(value=>value!==null).sort((a,b)=>a-b);
  return asks.length?{min:asks[0],max:asks.at(-1),available:true}:{min:null,max:null,available:false};
}

const value=(row,field)=>{
  if(field==="near-spot")return Math.abs(number(row.strike)-number(row.spot));
  if(field==="distance")return Math.abs(number(row.strike)-number(row.spot));
  if(field==="absolute-delta")return Math.abs(number(row.delta));
  return number(row[field]);
};

export function filterAndSort(rows=[],filters={}){
  const security=filters.security||"ALL",right=filters.right||"ALL";
  const min=number(filters.askMin),max=number(filters.askMax),field=filters.sort||"near-spot";
  const direction=filters.direction==="desc"?-1:1;
  return rows.filter(row=>{
    if(security!=="ALL"&&row.underlying!==security)return false;
    if(right!=="ALL"&&row.option_type!==right)return false;
    const ask=number(row.ask);
    if(min!==null&&(ask===null||ask<min))return false;
    if(max!==null&&(ask===null||ask>max))return false;
    return true;
  }).sort((a,b)=>{
    const x=value(a,field),y=value(b,field);
    if(x===null||y===null)return x===y?String(a.contract_symbol).localeCompare(String(b.contract_symbol)):x===null?1:-1;
    return direction*(x-y)||Number(a.strike)-Number(b.strike)||String(a.option_type).localeCompare(String(b.option_type));
  });
}

