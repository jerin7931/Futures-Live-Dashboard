import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {href,newYorkDate,route} from "../screener/cash-open-core.js";
import {dynamicAskRange,filterAndSort,strictZeroDte} from "../screener/option-chain-core.js";
import {renderOptionChain} from "../screener/option-chain-view.js";
import {renderHome} from "../screener/lppc-view.js";
import {renderCompactGamma,renderOptionsAnalysis} from "../screener/options-analysis-view.js";

const day="2026-09-28";
const chain=[
  {underlying:"SPX",session_date:day,expiration_date:day,contract_symbol:"SPX-C",option_type:"CALL",strike:7000,spot:6998,bid:2,ask:2.4,midpoint:2.2,spread_pct:18,delta:.51,gamma:.02,theta:-.3,implied_volatility:.2,volume:10,open_interest:20,freshness:"CURRENT",quote_as_of:"2026-09-28T16:00:00Z"},
  {underlying:"SPX",session_date:day,expiration_date:day,contract_symbol:"SPX-P",option_type:"PUT",strike:6995,spot:6998,bid:.5,ask:.8,midpoint:.65,spread_pct:46,delta:-.4,gamma:.01,theta:-.2,implied_volatility:.25,volume:40,open_interest:50,freshness:"AGED",quote_as_of:"2026-09-28T15:58:00Z"},
  {underlying:"SPY",session_date:day,expiration_date:"2026-09-29",contract_symbol:"NEXT",option_type:"CALL",strike:700,spot:700,ask:9}
];

test("navigation is exactly the three V2 production routes",()=>{
  for(const page of ["home","options-analysis","option-chain"])
    assert.deepEqual(route(`#/${page}`),{demo:false,page,redirect:false});
  assert.deepEqual(route("#/news"),{demo:false,page:"home",redirect:true});
  assert.deepEqual(route("#/tracking"),{demo:false,page:"home",redirect:true});
  assert.equal(href("option-chain"),"#/option-chain");
  assert.match(newYorkDate(new Date("2026-09-28T16:00:00Z")),/^2026-09-28$/);
});

test("Home order is SPX QQQ IWM SPY and excludes SMH, news and Tracking",()=>{
  const rows=["SPY","IWM","SPX","QQQ"].map(symbol=>({symbol,price:100,direction_state:"MIXED",event_state:"QUIET",source_status:"CURRENT"}));
  const html=renderHome({lppc:rows,efficiency:[],eventHistory:[],gamma:[]},{efficiencyTimeframes:{SPX:"M1",QQQ:"M1",IWM:"M1",SPY:"M1"}});
  const positions=["SPX","QQQ","IWM","SPY"].map(symbol=>html.indexOf(`data-symbol="${symbol}"`));
  assert.deepEqual([...positions].sort((a,b)=>a-b),positions);
  assert.doesNotMatch(html,/SMH|Market News|Tracking|LONG FOCUS|SHORT FOCUS/);
  assert.equal((html.match(/lppc-workstation/g)||[]).length,4);
  assert.equal((html.match(/Copy TradingView Gamma/g)||[]).length,1);
  assert.equal((html.match(/lppc-tv-summary/g)||[]).length,4);
  assert.doesNotMatch(html,/COMBINED MARKET STRUCTURE|price-efficiency-chart|class="lppc-gamma"/);
});

test("gamma chart remains intact and only adds bounded market overlays",()=>{
  const row={payload:{spot:100,summary:{net_gex:10,call_wall:101,put_wall:99,zero_gamma_status:"CURRENT",zero_gamma:100},strike_profile:[{strike:99,net_gex:-5},{strike:100,net_gex:1},{strike:101,net_gex:8}]}};
  const original=renderCompactGamma(row),overlaid=renderCompactGamma(row,{dynamic_support:99,dynamic_resistance:101,pdh:100,pdl:40,pwh:102,pwl:98});
  for(const text of ["Positive net gamma","Negative net gamma","Spot"])assert.match(original,new RegExp(text.replaceAll("/","\\/")));
  assert.match(overlaid,/>S</);assert.match(overlaid,/>R</);assert.match(overlaid,/>PDH</);
  assert.doesNotMatch(overlaid,/PDL 40/);
  assert.match(renderOptionsAnalysis([row],"SPX"),/Options Analysis/);
});

test("Option Chain is strict 0DTE, has dynamic ask bounds, filters and sorts",()=>{
  const current=strictZeroDte(chain,day);assert.equal(current.length,2);assert.deepEqual(dynamicAskRange(current),{min:.8,max:2.4,available:true});
  assert.deepEqual(filterAndSort(current,{security:"SPX",right:"PUT",sort:"ask",direction:"asc"}).map(row=>row.contract_symbol),["SPX-P"]);
  assert.deepEqual(filterAndSort(current,{askMin:1,askMax:3,sort:"near-spot",direction:"asc"}).map(row=>row.contract_symbol),["SPX-C"]);
  const html=renderOptionChain({optionChain:current,chainPointers:[{underlying:"SPX",expiration_date:day,status:"CURRENT",coverage:{inventory_count:2,quoted_count:2,full_chain_coverage:1,hot_set_coverage:.5,current:1,aged:1,stale:0,unavailable:0,newest_quote_age_seconds:5,oldest_quote_age_seconds:125,last_completed_full_sweep:"2026-09-28T15:59:00Z"}}]},{chainFilters:{security:"ALL",right:"ALL",askMin:"",askMax:"",sort:"near-spot",direction:"asc"}});
  for(const label of ["WEBULL OPENAPI · 0DTE · PER-CONTRACT FRESHNESS","All premiums","Near Spot","Open Interest","Freshness","Quote Age","Quote Time","Inventory 2 contracts","Quoted coverage 100.0%","Current freshness 50.0%","Hot-set coverage 50.0%","CURRENT 1 · AGED 1 · STALE 0 · UNAVAILABLE 0","Newest quote age","oldest quote age","Last completed full-chain sweep","QQQ: NO 0DTE DATA"])assert.match(html,new RegExp(label));
  assert.doesNotMatch(html,/100(?:\.0)?% fresh/i);
  assert.doesNotMatch(html,/best contract/i);
});

test("active browser bundle is Supabase-only and mutation-free",async()=>{
  const app=await readFile(new URL("../screener/cash-open-app.js",import.meta.url),"utf8");
  for(const table of ["fos_lppc_state_current","fos_lppc_event_history","fos_options_analysis_current","fos_option_chain_snapshot_current","fos_ai_analysis_current","fos_ai_analysis_history"])assert.ok(app.includes(table),table);
  for(const retiredChartRead of ["fos_lppc_efficiency_current","fos_lppc_participation_current","fos_lppc_observation_log"])assert.ok(!app.includes(retiredChartRead),retiredChartRead);
  for(const retired of ["fos_option_chain_generation_current","fos_option_chain_current","fos_market_news_current","#/news","newsQuery"])assert.ok(!app.includes(retired),retired);
  for(const forbidden of ["fos_cash_open_session_current","fos_cash_open_candidates_current",".upsert(",".insert(",".delete(",".rpc(","Webull","InsiderFinance","placeOrder"])assert.ok(!app.includes(forbidden),forbidden);
});

test("TradingView-first Home retains compact SPX LPPC and gamma state without a custom price chart",()=>{
  const html=renderHome({
    lppc:[{symbol:"SPX",price:7000,direction_state:"MIXED",event_state:"QUIET",source_status:"CURRENT",score_1m:.12,score_5m:.34}],
    eventHistory:[],gamma:[{symbol:"SPX",status:"CURRENT",source_as_of:"2026-09-28T14:31:00Z",payload:{summary:{gamma_regime:"SHORT GAMMA",zero_gamma:6990}}}],
  },{aiExpanded:{}});
  assert.match(html,/SPX <span>7,000\.0/);
  assert.match(html,/SHORT GAMMA/);
  assert.match(html,/6,990\.0/);
  assert.doesNotMatch(html,/data-open|participation-inner|price-efficiency-chart/);
});

test("active event displays persisted peak while quiet displays current percentile",()=>{
  const base={symbol:"SPY",price:100,direction_state:"BULLISH",source_status:"CURRENT",percentile_1m:.90,percentile_5m:.80};
  const active=renderHome({lppc:[{...base,event_state:"ACTIVE",peak_1m_percentile:.991,peak_5m_percentile:.94}],efficiency:[],eventHistory:[],gamma:[]},{efficiencyTimeframes:{SPY:"M1"}});
  assert.match(active,/MOVE 99\.1% PEAK/);
  const quiet=renderHome({lppc:[{...base,event_state:"QUIET",peak_1m_percentile:.999}],efficiency:[],eventHistory:[],gamma:[]},{efficiencyTimeframes:{SPY:"M1"}});
  assert.match(quiet,/MOVE 90\.0%/);assert.doesNotMatch(quiet,/PEAK/);
});
