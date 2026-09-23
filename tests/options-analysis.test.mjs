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
test("four symbols, signed net bars, outlined wall strikes, and gamma copy render safely",()=>{
  const html=renderOptionsAnalysis([row],"SPX",Date.parse("2026-09-23T19:01:00Z"));
  for(const symbol of ["SPX","SPY","QQQ","IWM"])assert.match(html,new RegExp(`data-symbol="${symbol}"`));
  assert.match(html,/Gamma Flip/);assert.match(html,/data-wall="Call wall"/);assert.match(html,/data-wall="Put wall"/);
  assert.match(html,/aria-label="0DTE net gamma by strike/);
  assert.equal((html.match(/<rect /g)||[]).length,2,"one net bar per strike");
  assert.match(html,/fill="#26c983"/);assert.match(html,/fill="#f24567"/);assert.match(html,/stroke="#f5f7fb" stroke-width="3"/);
  assert.match(html,/Positive net gamma/);assert.match(html,/Negative net gamma/);assert.match(html,/Spot/);
  assert.doesNotMatch(html,/OI[- ](?:gamma|based|proxy)/i);
  assert.match(html,/&lt;img src=x&gt;/);assert.doesNotMatch(html,/<img src=x>/);
  assert.match(renderOptionsAnalysis([row],"SPY"),/No current SPY analysis/);
});
test("legacy gamma wording is replaced in every visible analysis field",()=>{
  const legacy=structuredClone(row);
  legacy.payload.signals[0].description="OI proxy is net negative.";
  legacy.payload.analysis.setup_analysis=["Current 0DTE OI-gamma proxy is net negative."];
  legacy.payload.analysis.stronger_setup_conditions=["Reassess the OI-gamma balance."];
  legacy.payload.analysis.trading_implication="Descriptive OI-based structural proxy, not a signal.";
  const html=renderOptionsAnalysis([legacy]);
  assert.doesNotMatch(html,/OI[- ](?:gamma|based|proxy)/i);
  assert.match(html,/gamma exposure is net negative/i);
  assert.match(html,/gamma structure, not a signal/i);
  assert.match(html,/gamma-strength-strong/);
});
test("gamma desk uses the reference dark palette without changing other routes",()=>{
  const css=readFileSync(new URL("../screener/styles.css",import.meta.url),"utf8");
  assert.match(css,/body:has\(\.options-analysis-page\)/);
  assert.match(css,/#26c983|#31d28a/);
  assert.match(css,/#f24567|#ff4d6b/);
  assert.match(css,/\.gamma-strength-moderate/);
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
