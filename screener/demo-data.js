const ITEMS=[
 ["AMD","Advanced Micro Devices","STOCK","Technology","Semiconductors"],["NVDA","NVIDIA","STOCK","Technology","Semiconductors"],
 ["ARM","Arm Holdings","STOCK","Technology","Semiconductors"],["MSFT","Microsoft","STOCK","Technology","Software"],
 ["PLTR","Palantir","STOCK","Technology","Software"],["META","Meta Platforms","STOCK","Communication Services","Internet Content"],
 ["GOOGL","Alphabet","STOCK","Communication Services","Internet Content"],["NFLX","Netflix","STOCK","Communication Services","Entertainment"],
 ["LLY","Eli Lilly","STOCK","Healthcare","Drug Manufacturers"],["MRNA","Moderna","STOCK","Healthcare","Biotechnology"],
 ["VKTX","Viking Therapeutics","STOCK","Healthcare","Biotechnology"],["JPM","JPMorgan Chase","STOCK","Financials","Banks"],
 ["BAC","Bank of America","STOCK","Financials","Banks"],["GS","Goldman Sachs","STOCK","Financials","Capital Markets"],
 ["XOM","Exxon Mobil","STOCK","Energy","Oil & Gas"],["CVX","Chevron","STOCK","Energy","Oil & Gas"],
 ["SLB","SLB","STOCK","Energy","Oil & Gas Equipment"],["UPS","United Parcel Service","STOCK","Industrials","Logistics"],
 ["FDX","FedEx","STOCK","Industrials","Logistics"],["CAT","Caterpillar","STOCK","Industrials","Farm & Heavy Machinery"],
 ["TSLA","Tesla","STOCK","Consumer Cyclical","Auto Manufacturers"],["AAPL","Apple","STOCK","Technology","Consumer Electronics"],
 ["AMZN","Amazon","STOCK","Consumer Cyclical","Internet Retail"],["NKE","Nike","STOCK","Consumer Cyclical","Footwear & Accessories"],
 ["SPY","SPDR S&P 500 ETF","ETF","Financials","Exchange Traded Fund"],["QQQ","Invesco QQQ Trust","ETF","Financials","Exchange Traded Fund"],
 ["IWM","iShares Russell 2000 ETF","ETF","Financials","Exchange Traded Fund"],["SMH","VanEck Semiconductor ETF","ETF","Technology","Exchange Traded Fund"],
 ["XLE","Energy Select Sector SPDR","ETF","Energy","Exchange Traded Fund"],["XLV","Health Care Select Sector SPDR","ETF","Healthcare","Exchange Traded Fund"],
];
const STATES=["CONFIRMED","CONFIRMING","EMERGING","DEGRADING","NO_TREND","REVERSED"];
const SENSORS=["TREND_UP_1M","TREND_DOWN_1M","TREND_UP_5M","TREND_DOWN_5M","TREND_NEW_HIGH","TREND_NEW_LOW","TREND_MOST_ACTIVE","TREND_UNUSUAL_VOLUME"];
const iso=value=>new Date(value).toISOString();
const round=(value,digits=2)=>Number(value.toFixed(digits));

function newsFor(item,index,now){
  if(index%4===3)return [];
  const [symbol,name,,sector,industry]=item;const old=index%5===0;const first=now-(old?9:0.3+index%3)*3600000;
  return [{id:`demo-news-${symbol}`,headline:index%3===0?`${name} unveils an updated product roadmap`:`${name} draws fresh analyst attention`,source:index%2?"Demo Wire":"Demo Markets",url:`https://example.invalid/demo/${symbol.toLowerCase()}`,publication_at:iso(first-18*60000),first_seen_at:iso(first),received_at:iso(first),symbols:[symbol],sector:[sector],industry:[industry],scope:"COMPANY",category:index%3===0?"PRODUCT":"ANALYST",interpretation:"UNRESOLVED",content_scope:"HEADLINE_ONLY",publication_time_basis:"SIMULATED_ORIGINAL_PUBLICATION_TIME",causal_time_field:"first_seen_at"}];
}

function tm(index){
  if(index%7===0)return {timeframes:{"5":{status:"READY",state:"BLUE"},"15":{status:"WARMING_UP",state:null},"30":{status:"WARMING_UP",state:null},"60":{status:"WARMING_UP",state:null}},agreement_pattern:"INSUFFICIENT_WARMUP",descriptive_only:true,v1_effect:"NONE"};
  const all=index%6===0?"BLUE":index%6===1?"RED":null;
  const values=all?[all,all,all,all]:index%2?["RED","RED","BLUE","BLUE"]:["BLUE","BLUE","RED","RED"];
  return {timeframes:Object.fromEntries([5,15,30,60].map((frame,i)=>[String(frame),{status:"READY",state:values[i],last_completed_state:values[i],developing_state:values[i],bars_since_flip:i+2,cci:values[i]==="BLUE"?85+i*11:-78-i*9,atr:round(.4+i*.22),magic_trend:round(100+i*1.4),price_relative:values[i]==="BLUE"?"ABOVE":"BELOW",completed_bars:120-i*22,updated_at:null,source:"SIMULATED_M1_CAUSAL_AGGREGATION"}])),agreement_pattern:all?(all==="BLUE"?"FULL_BULLISH_ALIGNMENT":"FULL_BEARISH_ALIGNMENT"):"MIXED_TIMEFRAME_CONTEXT",descriptive_only:true,v1_effect:"NONE"};
}

function groups(rows,key){
  const map=new Map();for(const row of rows){if(!map.has(row[key]))map.set(row[key],[]);map.get(row[key]).push(row);}
  return [...map].map(([name,members])=>{const changes=members.map(row=>row.change_1d_pct);const fives=members.map(row=>row.move_5m_pct);return {name,performance_1d_pct:round(changes.reduce((a,b)=>a+b,0)/changes.length),performance_5m_pct:round(fives.reduce((a,b)=>a+b,0)/fives.length),breadth:round(changes.filter(v=>v>0).length/changes.length,4),radar_member_count:members.length,leaders:[...members].sort((a,b)=>b.change_1d_pct-a.change_1d_pct).slice(0,3).map(row=>row.symbol),laggards:[...members].sort((a,b)=>a.change_1d_pct-b.change_1d_pct).slice(0,3).map(row=>row.symbol),source:"SIMULATED_DERIVED_PEER_UNIVERSE",descriptive_only:true};}).sort((a,b)=>b.performance_1d_pct-a.performance_1d_pct);
}

export function buildDemoData(now=Date.now()){
  const opportunities=ITEMS.map((item,index)=>{
    const [symbol,company_name,asset_type,sector,industry]=item;const v1_state=STATES[index%STATES.length];
    const baseDirection=(Math.floor(index/6)+index)%2?"SHORT":"LONG";const v1_direction=v1_state==="NO_TREND"?null:baseDirection;
    const change=round(((index%9)-4)*.71+(index%3)*.16);const move5=round(change*.17+(index%2?.08:-.05));
    const news=newsFor(item,index,now);const quoteState=index===11?"STALE":"LIVE";
    return {symbol,company_name,asset_type,price:round(28+index*17.43),previous_close:null,change_1d_pct:change,session_volume:1250000+index*713221,finviz_rvol:round(.62+(index%8)*.43),avg_volume:900000+index*412310,
      v1_direction,last_evidence_bias:v1_state==="NO_TREND"?baseDirection:null,v1_state,detector_state:v1_state==="REVERSED"?"CONFIRMED":v1_state,reversed_from:v1_state==="REVERSED"?(baseDirection==="LONG"?"SHORT":"LONG"):null,state_changed_at:iso(now-(index+1)*190000),
      efficiency:round(.18+(index%8)*.105,3),persistence:round(.35+(index%6)*.09,3),structure:round(.3+(index%5)*.12,3),cleanliness:round(.33+(index%7)*.08,3),favorable_displacement_pct:Math.abs(move5),adverse_excursion:round(.1+(index%5)*.13),pullback_depth:round(.12+(index%6)*.11),
      move_1m_pct:round(move5*.24),move_3m_pct:round(move5*.61),move_5m_pct:move5,move_10m_pct:round(move5*1.52),move_15m_pct:round(move5*1.91),
      structural_break:index%3?null:{direction:baseDirection,at:iso(now-(index+2)*60000),level:round(27+index*17.4),price:round(28+index*17.43)},
      finviz_sensors:[{sensor:SENSORS[index%SENSORS.length],family:"SIMULATED_DISCOVERY",direction:v1_direction,rank:index+1,previous_rank:index+3,rank_velocity:2,first_seen_at:iso(now-(index+4)*60000),last_seen_at:iso(now-20000)}],best_sensor_rank:index+1,rank_velocity:(index%5)-1,first_nominated_at:iso(now-(index+4)*60000),last_nominated_at:iso(now-20000),why_picked:[`Finviz ${index%2?"5m loser":"1m gainer"}`,index%3===0?"unusual volume":"rank acceleration"],
      sector,industry,market_relative:asset_type==="ETF"?null:round(move5-(index%2?.04:-.02)),sector_relative:round(((index%7)-3)*.09),industry_relative:round(((index%5)-2)*.11),peer_breadth:round(.32+(index%6)*.1),benchmark_symbol:asset_type==="ETF"?null:(sector==="Technology"||sector==="Communication Services"?"QQQ":"SPY"),trend_magic:tm(index),news,
      freshness:{quote:{state:quoteState,age_seconds:quoteState==="LIVE"?8:244,at:iso(now-(quoteState==="LIVE"?8:244)*1000)},bar:{state:"LIVE",age_seconds:35,at:iso(now-35000)},finviz:{state:index===14?"DELAYED":"LIVE",age_seconds:index===14?112:42,at:iso(now-(index===14?112:42)*1000)}},in_current_radar:true,lifecycle_commitment:null,
      provenance:{price:"SIMULATED_WEBULL_QUOTE",change_1d_pct:"SIMULATED_FINVIZ_EXPORT",session_volume:"SIMULATED_WEBULL_COMPLETED_M1_SUM",finviz_rvol:"SIMULATED_FINVIZ_RELATIVE_VOLUME",avg_volume:"SIMULATED_FINVIZ_AVERAGE_VOLUME",v1_state:"SIMULATED_FROZEN_V1_OUTPUT",classification:"SIMULATED_FINVIZ_CLASSIFICATION",trend_magic:"SIMULATED_M1_CAUSAL_AGGREGATION",news:"SIMULATED_FINVIZ_NEWS",relative_strength:"SIMULATED_LOCAL_CALCULATION"}};
  });
  const allNews=opportunities.flatMap(row=>row.news);
  const marketNews=[
    ["Treasury yields shift ahead of the next policy update","FED / MACRO"],["Crude oil reacts to a new supply outlook","ENERGY"],["Major indexes digest the latest economic data","FED / MACRO"],["Technology shares lead broad-market activity","UNCLASSIFIED"],
  ].map(([headline,category],index)=>({id:`demo-market-${index}`,headline,source:"Demo Macro Wire",url:`https://example.invalid/demo/market-${index}`,publication_at:iso(now-(index+2)*23*60000),first_seen_at:iso(now-(index+1)*19*60000),received_at:iso(now-(index+1)*19*60000),symbols:[],sector:[],industry:[],scope:"MARKET",category,interpretation:"UNRESOLVED",content_scope:"HEADLINE_ONLY",publication_time_basis:"SIMULATED_ORIGINAL_PUBLICATION_TIME",causal_time_field:"first_seen_at"}));
  const market=[
    ["SPY","SPY",692.41,.54],["QQQ","QQQ",624.87,.88],["IWM","IWM",247.62,-.31],["VIX","VIX",17.34,-2.12],["US10Y","10Y Yield",4.16,.03],["US2Y","2Y Yield",3.72,.02],["DXY","DXY",97.63,-.18],["WTI","WTI Crude",67.44,1.21],
  ].map(([symbol,label,value,change],index)=>({key:symbol,symbol,label,value,raw_value:value,units:index<3?"USD":index===4||index===5?"%":index===7?"USD/bbl":null,change:null,change_pct:change,change_1d_pct:change,source_symbol:symbol,instrument_id:`SIM-${symbol}`,scale_factor:1,observed_at:iso(now-8000),provider_market_time:iso(now-9000),delayed:false,available:true,move_1m_pct:round(change*.03),move_3m_pct:round(change*.07),move_5m_pct:round(change*.12),move_10m_pct:round(change*.18),move_15m_pct:round(change*.24),v1_state:index<3?STATES[index+1]:null,efficiency:index<3?.5+index*.08:null,timestamp:iso(now-9000),source:"SIMULATED_PROVIDER",freshness:{state:"LIVE",age_seconds:9}}));
  return {schema_version:"FOS_LIVE_DASHBOARD_1",as_of:iso(now),market_session:"OPEN",data_mode:"SIMULATED_WEBSITE_FUNCTION_TEST",production_activation:null,brokerage_execution:false,options_requests_enabled:false,model_calls_critical_path:0,freshness:{radar:{state:"LIVE",age_seconds:7},news:{state:"LIVE",age_seconds:18}},market,market_news:marketNews,news:[...marketNews,...allNews].sort((a,b)=>Date.parse(b.first_seen_at)-Date.parse(a.first_seen_at)),sectors:groups(opportunities,"sector"),industries:groups(opportunities,"industry"),opportunities,watchlist:[],watchlist_capacity:{monitoring_enabled:false,capacity:0,message:"Demo watchlist persists in this browser only; no provider monitoring occurs."},provenance:{normalized_from:"STATIC_DETERMINISTIC_DEMO_MODULE",v1_policy:"trend-radar-v1-shadow-2026-09-21",v1_detector_changed:false,context_effect:"DESCRIPTIVE_ONLY"}};
}
