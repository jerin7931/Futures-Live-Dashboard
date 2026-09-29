export const TVG2_SYMBOLS=Object.freeze(["SPX","QQQ","IWM","SPY"]);
export const TVG2_VERSION="TVG2";
export const TVG2_MAX_CHARACTERS=40_000;
export const TVG2_SOFT_CHARACTER_LIMIT=38_000;
export const TVG2_MATERIALITY_STEPS=Object.freeze([0,0.0001,0.001,0.01,0.1]);

const finite=value=>value===null||value===undefined||value===""||!Number.isFinite(Number(value))?null:Number(value);
const clean=value=>String(value??"").replace(/[|\r\n,:]/g," ").replace(/\s+/g," ").trim();
const compact=(value,places)=>{
  const number=finite(value);
  if(number===null)return "";
  const rounded=number.toFixed(places);
  return rounded.replace(/\.0+$/,"").replace(/(\.\d*?)0+$/,"$1");
};
const strikeText=(symbol,value)=>compact(value,symbol==="SPX"?1:2);
const levelText=value=>compact(value,4);
const gexMillionsText=value=>compact(Number(value)/1_000_000,4);

function normalizeProfile(symbol,row,materialityMillions){
  const profile=Array.isArray(row?.payload?.strike_profile)?row.payload.strike_profile:[];
  return profile.map(item=>({strike:finite(item?.strike),netGex:finite(item?.net_gex)}))
    .filter(item=>item.strike!==null&&item.netGex!==null&&Math.abs(item.netGex/1_000_000)>materialityMillions)
    .sort((a,b)=>a.strike-b.strike)
    .map(item=>`${strikeText(symbol,item.strike)}:${gexMillionsText(item.netGex)}`);
}

function rowFor(symbol,rows,materialityMillions){
  const row=(rows||[]).find(item=>item?.symbol===symbol);
  if(!row)throw new Error(`TVG2_MISSING_${symbol}`);
  const epoch=Date.parse(row.source_as_of||"");
  if(!Number.isFinite(epoch))throw new Error(`TVG2_INVALID_SOURCE_AS_OF_${symbol}`);
  const summary=row.payload?.summary||{};
  const profile=normalizeProfile(symbol,row,materialityMillions);
  return {
    epoch,
    profile,
    text:[
      symbol,
      String(epoch),
      clean(row.status||"UNAVAILABLE"),
      clean(summary.gamma_regime||"UNAVAILABLE"),
      levelText(summary.zero_gamma),
      levelText(summary.call_wall),
      levelText(summary.put_wall),
      levelText(summary.gamma_magnet),
      profile.join(","),
    ].join("|"),
  };
}

function packetAt(rows,materialityMillions){
  const records=TVG2_SYMBOLS.map(symbol=>[symbol,rowFor(symbol,rows,materialityMillions)]);
  const text=[TVG2_VERSION,...records.map(([,record])=>record.text)].join("\n");
  return {
    text,
    characterCount:text.length,
    strikeCounts:Object.fromEntries(records.map(([symbol,record])=>[symbol,record.profile.length])),
    oldestEpoch:Math.min(...records.map(([,record])=>record.epoch)),
  };
}

export function buildTVG2(rows,now=Date.now(),options={}){
  const maxCharacters=options.maxCharacters??TVG2_MAX_CHARACTERS;
  const softLimit=options.softLimit??Math.min(TVG2_SOFT_CHARACTER_LIMIT,maxCharacters);
  let result,materialityThresholdMillions=0;
  for(const threshold of TVG2_MATERIALITY_STEPS){
    result=packetAt(rows,threshold);
    materialityThresholdMillions=threshold;
    if(result.characterCount<=softLimit)break;
  }
  if(result.characterCount>maxCharacters)throw new Error(`TVG2_PACKET_TOO_LARGE_${result.characterCount}`);
  return {
    ...result,
    materialityThresholdMillions,
    omittedByMateriality:materialityThresholdMillions>0,
    oldestGammaAgeMinutes:Number.isFinite(now)?Math.max(0,(now-result.oldestEpoch)/60_000):null,
  };
}

export function parseTVG2(text,symbol){
  const lines=String(text??"").replace(/\r/g,"").split("\n").filter(Boolean);
  if(lines[0]!==TVG2_VERSION)throw new Error("TVG2_BAD_VERSION");
  if(lines.length!==5)throw new Error("TVG2_RECORD_COUNT");
  const records=new Map();
  for(const line of lines.slice(1)){
    const fields=line.split("|");
    if(fields.length!==9)throw new Error("TVG2_BAD_RECORD");
    const [recordSymbol,epoch,status,regime,flip,callWall,putWall,magnet,profileText]=fields;
    if(records.has(recordSymbol)||!TVG2_SYMBOLS.includes(recordSymbol))throw new Error("TVG2_BAD_SYMBOL_SET");
    const profile=profileText?profileText.split(",").map(item=>{
      const [strike,gex,...extra]=item.split(":");
      if(extra.length||finite(strike)===null||finite(gex)===null)throw new Error("TVG2_BAD_PROFILE");
      return {strike:Number(strike),netGexMillions:Number(gex)};
    }):[];
    records.set(recordSymbol,{symbol:recordSymbol,epoch:Number(epoch),status,regime,flip:finite(flip),callWall:finite(callWall),putWall:finite(putWall),magnet:finite(magnet),profile});
  }
  if(TVG2_SYMBOLS.some(item=>!records.has(item)))throw new Error("TVG2_MISSING_SYMBOL");
  const selected=String(symbol||"").toUpperCase();
  if(!records.has(selected))throw new Error("TVG2_SYMBOL_NOT_FOUND");
  return records.get(selected);
}

export function tradingViewGammaFeedback(result){
  const counts=TVG2_SYMBOLS.map(symbol=>`${symbol}: ${result.strikeCounts[symbol]} strikes`).join("\n");
  const age=Number.isFinite(result.oldestGammaAgeMinutes)?result.oldestGammaAgeMinutes.toFixed(1):"—";
  const materiality=result.omittedByMateriality?`\nMateriality: omitted |GEX| ≤ ${result.materialityThresholdMillions}M`:"";
  return `TradingView gamma copied\n${counts}\nOldest gamma age: ${age}m\nPacket: ${result.characterCount} characters${materiality}`;
}
