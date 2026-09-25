const iso=()=>new Date().toISOString();
const focus=(symbol,direction,laneRank,gate,exchange="NASDAQ")=>({
  symbol,exchange_code:exchange,company:`${symbol} · simulated`,direction,lane:direction,
  selected_0900:true,gate_0845:gate,standard_0900:true,lane_rank:laneRank,gate_rank:laneRank,
  option_quality_at_lock:laneRank===3?"FAIR":"GOOD",option_quality_current:laneRank===3?"FAIR":"GOOD",
  data_status:"CURRENT",gate_0845_evidence:{opening_volume_ratio:2.1+laneRank/10,opening_efficiency:.72,
    open_to_anchor_atr:1.1,volume_state:"ACCELERATING",relative_to_spy_pct:.6,room_to_level_atr:.8},
  standard_0900_evidence:{opening_volume_ratio:2.4+laneRank/10,opening_efficiency:.75,
    open_to_anchor_atr:1.3,volume_state:"ACCELERATING",relative_to_spy_pct:.8,room_to_level_atr:.9},
  current_context:{price:100+laneRank*8,current_efficiency:.68,m5_atr:{atr:1.2,trail:98+laneRank*8,trend:direction==="LONG"?1:-1,extreme:103+laneRank*8},source_as_of:iso()},
  option_evidence:{quality:laneRank===3?"FAIR":"GOOD",fresh:true},
});
const gate=(symbol,direction,rank,exchange="NYSE")=>({
  symbol,exchange_code:exchange,company:`${symbol} · simulated`,direction,
  selected_0900:false,gate_0845:true,standard_0900:false,gate_rank:rank,
  option_quality_current:"UNAVAILABLE",data_status:"CURRENT",
  gate_0845_evidence:{opening_volume_ratio:1.3+rank/10,opening_efficiency:.58,
    open_to_anchor_atr:.65,volume_state:"STABLE",relative_to_spy_pct:.2,room_to_level_atr:.5},
  current_context:{price:80+rank*6,current_efficiency:.53,source_as_of:iso()},
});

export function cashOpenDemo(){
  const day=new Date().toLocaleDateString("en-CA",{timeZone:"America/New_York"});
  const candidates=[focus("NVDA","LONG",1,true),focus("AMD","LONG",2,true),
    focus("MCD","SHORT",1,true,"NYSE"),focus("CRM","SHORT",2,false,"NYSE"),
    focus("UPS","SHORT",3,true,"NYSE"),gate("CAT","LONG",1),gate("MSFT","LONG",2,"NASDAQ"),
    gate("META","SHORT",3,"NASDAQ")];
  const gamma=["SPX","SPY","QQQ","IWM"].map((symbol,index)=>{
    const spot=[5800,580,510,220][index],step=spot>1000?10:spot>500?2:1;
    const strike_profile=Array.from({length:25},(_,i)=>({strike:spot+(i-12)*step,
      net_gex:(i-12)*1e7*(i%3===0?-.5:1)}));
    return {symbol,spot,source_as_of:iso(),status:"SIMULATED",payload:{symbol,spot,source_as_of:iso(),
      strike_profile,summary:{net_gex:-1.2e9,call_gex:4e9,put_gex:-5.2e9,
        gross_gex:9.2e9,call_wall:spot+5*step,put_wall:spot-5*step,
        gamma_regime:"SIMULATED",zero_gamma:null,zero_gamma_status:"UNAVAILABLE"},
      signals:[],analysis:{setup_state:"SIMULATED",setup_analysis:[],stronger_setup_conditions:[]},
      coverage:{distinct_strike_count:25,contract_count:50}}};
  });
  const news={articles:[{article_id:"demo-one",title:"Simulated market headline for layout testing",
    url:"https://example.invalid/demo",source:"Demo Feed",first_seen_at:iso(),symbols:["SPY"],
    content_scope:"HEADLINE_ONLY"}],source_as_of:iso(),status:"SIMULATED"};
  return {session:{session_date:day,phase:"FOCUS_0900",status:"SIMULATED",spy_open_return:.24,
    gate_0845_count:7,long_selected_count:2,short_selected_count:3,
    focus_locked_at:iso(),source_as_of:iso(),payload:{policy_version:"cash-open-focus-v1-2026-09-24"}},
    candidates,gamma,news};
}
