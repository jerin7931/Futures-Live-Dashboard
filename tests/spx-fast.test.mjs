import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {route} from "../screener/cash-open-core.js";
import {renderSpxFastState} from "../screener/spx-fast-view.js";

const sample={
  schema_version:"SPX_FAST_GROK_V2",
  generated_at:"2026-09-30T15:00:00Z",
  session_phase:"RTH",warnings:["NO_PUTS_UNDER_4"],
  es:{latest:{time:"2026-09-30T15:00:00Z",close:7700,primary_state:"NEUTRAL",phase:"STABLE",context:"RANGE",di_dominance:8,adx:17,chop:62,ema9:7700,ema21:7701,control_trend:"NONE"},recent_completed_5m_state:[]},
  structure:{conversion:{conversion_mode:"DIRECT_SPX"},native_es_support_zone:{lower:7680,upper:7685,coordinate_space:"ES"},native_es_resistance_zone:{lower:7720,upper:7725,coordinate_space:"ES"},native_spx_support_zone:{lower:7650,upper:7655,coordinate_space:"SPX"},native_spx_resistance_zone:{lower:7690,upper:7695,coordinate_space:"SPX"},converted_spx_support_zone_es:{lower:7683,upper:7688,coordinate_space:"ES",source_coordinate_space:"SPX"},converted_spx_resistance_zone_es:{lower:7723,upper:7728,coordinate_space:"ES",source_coordinate_space:"SPX"},persistent_role_state:{spx_support_is_resistance:true,spx_resistance_is_support:false},transition_events:{spx_support_role_flip_this_bar:false}},
  footprint:{stacked_levels:3,recent_completed_5m:[{time:"2026-09-30T15:00:00Z",close:7700,delta:25,delta_pct:4,poc_low:7699,poc_high:7700,vah:7702,val:7698,buy_imbalance_count:1,sell_imbalance_count:0,buy_stack_present:false,sell_stack_present:false}],latest_detail:[]},
  spx:{direct_spx_available:false,source:"TRADINGVIEW_SPCFD_SPX",source_status:"UNAVAILABLE",recent_completed_5m_bars:[]},
  gamma:{gamma_regime:"LONG GAMMA",status:"STALE",spot:7670,gamma_flip:7660,call_wall:7700,put_wall:7600,gamma_magnet:7680,net_gex:100,gross_gex:300,age_seconds:1200,nearby_strikes:[]},
  options:{calls:[],puts:[]},
  events:{chop_range_now:true,ema_bull_cross:false},
  freshness:{es_state:{age_seconds:10},footprint:{age_seconds:10},spx_market:{age_seconds:30},spx_options:{age_seconds:40},spx_gamma:{age_seconds:1200}}
};

test("SPX fast route is explicit",()=>assert.equal(route("#/spx-fast").page,"spx-fast"));
test("fast view renders human state and exact compact JSON",()=>{const html=renderSpxFastState(sample);assert.match(html,/FAST_STATE_JSON/);assert.match(html,/chop range now/i);assert.match(html,/SPY proxy is not substituted/);assert.match(html,/&quot;generated_at&quot;: &quot;2026-09-30T15:00:00Z&quot;/);});
test("structure labels make native SPX and converted ES coordinates explicit",()=>{const html=renderSpxFastState(sample);assert.match(html,/Native SPX support/);assert.match(html,/Native SPX resistance/);assert.match(html,/Converted SPX support \(ES\)/);assert.match(html,/Converted SPX resistance \(ES\)/);assert.doesNotMatch(html,/Converted SPX support<\/small>/);});
test("persistent role state is not rendered as a role-flip event",()=>{const html=renderSpxFastState(sample);assert.match(html,/SPX support role state/);assert.match(html,/RESISTANCE/);assert.doesNotMatch(html,/SPX support role flip<\/span>/i);});
test("Grok view is independent of SPX_AI baseline",()=>{const html=renderSpxFastState(sample);assert.match(html,/forms the market thesis/i);assert.doesNotMatch(html,/LAST CHATGPT ANALYSIS|NO VALID BASELINE|changed since baseline/i);});
test("hard premium wording and both candidate sides remain explicit",()=>{const html=renderSpxFastState(sample);assert.match(html,/Premium strictly below \$4\.00/);assert.match(html,/Calls · 0/);assert.match(html,/Puts · 0/);});
test("fast browser path is authenticated and read only",async()=>{const [app,page]=await Promise.all([readFile(new URL("../screener/cash-open-app.js",import.meta.url),"utf8"),readFile(new URL("../spx-fast/index.html",import.meta.url),"utf8")]);assert.match(app,/client\.rpc\("get_spx_fast_state",\{p_owner:userId\}\)/);assert.doesNotMatch(app,/\.insert\(|\.upsert\(|\.update\(|\.delete\(/);assert.match(page,/id="auth"/);assert.match(page,/id="login"/);assert.match(page,/spx-fast/);assert.doesNotMatch(page,/service[_-]?role|SUPABASE_SECRET|WEBULL_APP/i);});
test("fast browser does not query raw source or LPPC tables",async()=>{const app=await readFile(new URL("../screener/cash-open-app.js",import.meta.url),"utf8");for(const name of ["es_footprint_recent","spx_option_contracts_current","fos_lppc_"])assert.doesNotMatch(app,new RegExp(name));});
