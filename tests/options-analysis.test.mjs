import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {ROUTES} from "../screener/dashboard-core.js";
import {renderOptionsAnalysis,optionsFreshness} from "../screener/options-analysis-view.js";

const row={symbol:"SPX",spot:100,source_as_of:"2026-09-23T19:00:00Z",status:"CURRENT",payload:{spot:100,
  summary:{gamma_regime:"SHORT GAMMA",net_gex:-100,call_gex:100,put_gex:-200,gross_gex:300,
    call_wall:101,put_wall:99,zero_gamma:100.5,zero_gamma_status:"CURRENT",gamma_magnet:99},
  coverage:{contract_count:4,distinct_strike_count:2},
  strike_profile:[{strike:99,call_gex:0,put_gex:-200,net_gex:-200},{strike:101,call_gex:100,put_gex:0,net_gex:100}],
  signals:[{type:"VOLATILITY",strength:"STRONG",description:"Proxy",level:null}],
  analysis:{setup_state:"VOLATILITY EXPANSION RISK",setup_analysis:["<img src=x>"],stronger_setup_conditions:["Newer snapshot"],trading_implication:"Context only",alternate_setup:"Regime may change"}}};

test("isolated route replaces retired navigation without removing dormant route code",()=>{
  assert.ok(ROUTES.includes("options-analysis"));
  const nav=readFileSync(new URL("../index.html",import.meta.url),"utf8");
  assert.match(nav,/data-route="options-analysis"/);
  assert.doesNotMatch(nav,/data-route="market"|data-route="sectors"/);
});
test("four symbols, positive and negative strike bars, spot and levels render safely",()=>{
  const html=renderOptionsAnalysis([row],"SPX",Date.parse("2026-09-23T19:01:00Z"));
  for(const symbol of ["SPX","SPY","QQQ","IWM"])assert.match(html,new RegExp(`data-symbol="${symbol}"`));
  assert.match(html,/Gamma Flip/);assert.match(html,/Call wall/);assert.match(html,/Put wall/);
  assert.match(html,/#47b78c/);assert.match(html,/#e06273/);assert.match(html,/Spot/);
  assert.match(html,/&lt;img src=x&gt;/);assert.doesNotMatch(html,/<img src=x>/);
  assert.match(renderOptionsAnalysis([row],"SPY"),/No current SPY analysis/);
});
test("missing symbol and expiration states fail closed",()=>{
  assert.match(renderOptionsAnalysis([],"IWM"),/No current IWM analysis/);
  assert.equal(optionsFreshness(row,Date.parse("2026-09-23T19:01:00Z")),"CURRENT");
  assert.equal(optionsFreshness(row,Date.parse("2026-09-23T19:04:00Z")),"AGED");
  assert.equal(optionsFreshness(row,Date.parse("2026-09-23T19:06:00Z")),"STALE");
  assert.equal(optionsFreshness({...row,status:"OFF_SESSION"}),"OFF_SESSION");
  assert.equal(optionsFreshness({...row,status:"SOURCE_STALE"}),"SOURCE_STALE");
});
test("route-scoped read has no provider or model call",()=>{
  const app=readFileSync(new URL("../screener/app.js",import.meta.url),"utf8");
  const lane=app.slice(app.indexOf("async function loadOptionsAnalysis"),app.indexOf("async function refresh"));
  assert.match(lane,/fos_options_analysis_current/);assert.match(lane,/15000/);
  assert.doesNotMatch(lane,/webull|finviz|openai|fetch\(/i);
});
