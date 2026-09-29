const finite=value=>value!==null&&value!==undefined&&Number.isFinite(Number(value))?Number(value):null;

export function dynamicSupportResistance(bars){
  const valid=(bars||[]).map(bar=>({high:finite(bar.high),low:finite(bar.low),close:finite(bar.close)})).filter(bar=>bar.high!==null&&bar.low!==null&&bar.close!==null);
  if(!valid.length)return {support:null,resistance:null,pivotHighs:[],pivotLows:[]};
  const highs=valid.map(bar=>bar.high),lows=valid.map(bar=>bar.low),currentClose=valid.at(-1).close,pivotHighs=[],pivotLows=[];
  for(let index=2;index<valid.length-2;index+=1){
    const highWindow=highs.slice(index-2,index+3),lowWindow=lows.slice(index-2,index+3);
    if(highs[index]===Math.max(...highWindow))pivotHighs.push(highs[index]);
    if(lows[index]===Math.min(...lowWindow))pivotLows.push(lows[index]);
  }
  const supports=pivotLows.filter(value=>value<=currentClose),resistances=pivotHighs.filter(value=>value>=currentClose);
  return {
    support:supports.length?Math.max(...supports):Math.min(...lows),
    resistance:resistances.length?Math.min(...resistances):Math.max(...highs),
    pivotHighs,
    pivotLows,
  };
}

export function previousRegularSessionHighLow(sessions){
  const complete=(sessions||[]).filter(session=>session.complete&&finite(session.high)!==null&&finite(session.low)!==null);
  return complete.length?{pdh:Number(complete.at(-1).high),pdl:Number(complete.at(-1).low)}:{pdh:null,pdl:null};
}

export function premarketHighLow(bars,isCashIndex=false){
  if(isCashIndex)return {pmh:null,pml:null};
  const valid=(bars||[]).filter(bar=>finite(bar.high)!==null&&finite(bar.low)!==null);
  return valid.length?{pmh:Math.max(...valid.map(bar=>Number(bar.high))),pml:Math.min(...valid.map(bar=>Number(bar.low)))}:{pmh:null,pml:null};
}

export function rthVwap(bars,isCashIndex=false){
  if(isCashIndex)return null;
  let numerator=0,denominator=0;
  for(const bar of bars||[]){
    const high=finite(bar.high),low=finite(bar.low),close=finite(bar.close),volume=finite(bar.volume);
    if(high===null||low===null||close===null||volume===null||volume<=0)continue;
    numerator+=((high+low+close)/3)*volume;
    denominator+=volume;
  }
  return denominator>0?numerator/denominator:null;
}
