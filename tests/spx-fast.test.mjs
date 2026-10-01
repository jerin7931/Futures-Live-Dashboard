import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {route} from "../screener/cash-open-core.js";
import {renderSpxFastState} from "../screener/spx-fast-view.js";

const sample={
  generated_at:"2026-09-30T15:00:00Z",
  baseline_ai:{valid:true,analysis_at:"2026-09-30T14:45:00Z",decision:"NO_TRADE",bias:"NEUTRAL",market_state:"RANGE",confidence:.6,concise_summary:"Wait",entry_condition:"None",target:"None",invalidation:"None"},
  es:{price:7700,primary_state:"NEUTRAL",phase:"STABLE",context:"RANGE",di_dominance:8,adx:17,chop:62,ema9:7700,ema21:7701,control_trend:"NONE"},
  structure:{conversion_mode:"DIRECT_SPX",es_support_zone:[7680,7685],es_resistance_zone:[7720,7725],native_spx_support_zone:[7650,7655],native_spx_resistance_zone:[7690,7695],converted_spx_support_zone_es:[7683,7688],converted_spx_resistance_zone_es:[7723,7728],spx_support_is_resistance:true,spx_resistance_is_support:false,converted_spx_chartprime:{sup_is_res:true,res_is_sup:false}},
  footprint:{recent:[{bar_close_at:"2026-09-30T15:00:00Z",close:7700,delta:25,delta_pct:4,poc:[7699,7700],vah:7702,val:7698,buy_imbalance_count:1,sell_imbalance_count:0,max_buy_stack:1,max_sell_stack:0}]},
  spx:{direct_spx_available:false,source:"WEBULL",source_status:"UNAVAILABLE",recent_bars:[]},
  gamma:{gamma_regime:"LONG GAMMA",status:"STALE",spot:7670,gamma_flip:7660,call_wall:7700,put_wall:7600,gamma_magnet:7680,net_gex:100,age_minutes:20},
  options:{calls:[],puts:[]},
  events:{chop_range_now:true,ema_bull_cross:false},
  freshness:{baseline_ai:{seconds:900},es_state:{seconds:10},footprint:{seconds:10},spx_market:{seconds:30},spx_options:{seconds:40},spx_gamma:{seconds:1200}}
};

test("SPX fast route is explicit",()=>assert.equal(route("#/spx-fast").page,"spx-fast"));
test("fast view renders human state and exact compact JSON",()=>{const html=renderSpxFastState(sample);assert.match(html,/FAST_STATE_JSON/);assert.match(html,/chop range now/i);assert.match(html,/SPY proxy is not substituted/);assert.match(html,/&quot;generated_at&quot;: &quot;2026-09-30T15:00:00Z&quot;/);});
test("structure labels make native SPX and converted ES coordinates explicit",()=>{const html=renderSpxFastState(sample);assert.match(html,/Native SPX support/);assert.match(html,/Native SPX resistance/);assert.match(html,/Converted SPX support \(ES\)/);assert.match(html,/Converted SPX resistance \(ES\)/);assert.doesNotMatch(html,/Converted SPX support<\/small>/);});
test("persistent role state is not rendered as a role-flip event",()=>{const html=renderSpxFastState(sample);assert.match(html,/SPX support role state/);assert.match(html,/RESISTANCE/);assert.doesNotMatch(html,/SPX support role flip<\/span>/i);});
test("explicitly excluded test baseline is disclosed without test thesis values",()=>{const html=renderSpxFastState({...sample,baseline_ai:{valid:false,exclusion_reason:"EXPLICIT_TEST_BASELINE"}});assert.match(html,/NO VALID BASELINE/);assert.match(html,/EXPLICIT_TEST_BASELINE/);assert.doesNotMatch(html,/Market state<\/small>/);});
test("fast browser path is authenticated and read only",async()=>{const [app,page]=await Promise.all([readFile(new URL("../screener/cash-open-app.js",import.meta.url),"utf8"),readFile(new URL("../spx-fast/index.html",import.meta.url),"utf8")]);assert.match(app,/client\.rpc\("get_spx_fast_state",\{p_owner:userId\}\)/);assert.doesNotMatch(app,/\.insert\(|\.upsert\(|\.update\(|\.delete\(/);assert.match(page,/id="auth"/);assert.match(page,/id="login"/);assert.match(page,/spx-fast/);assert.doesNotMatch(page,/service[_-]?role|SUPABASE_SECRET|WEBULL_APP/i);});
test("fast browser does not query raw source or LPPC tables",async()=>{const app=await readFile(new URL("../screener/cash-open-app.js",import.meta.url),"utf8");for(const name of ["es_footprint_recent","spx_option_contracts_current","fos_lppc_"])assert.doesNotMatch(app,new RegExp(name));});
