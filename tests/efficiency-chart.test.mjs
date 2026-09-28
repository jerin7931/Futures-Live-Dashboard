import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {EFFICIENCY_BOUNDS,FRESHNESS_SECONDS,STABLE_SMA_LENGTH,defaultEfficiencyViewport,efficiencyFreshness,renderEfficiencyChart,signedSegments,stableSignedEfficiency} from "../screener/efficiency-chart.js";

const at=index=>`2026-09-28T13:${String(30+index).padStart(2,"0")}:00Z`;
const points=values=>values.map((efficiency,index)=>({observation_at:at(index),efficiency,source_status:"CURRENT"}));

test("fixed signed domain and Chicago session viewport",()=>{assert.deepEqual(EFFICIENCY_BOUNDS,{min:-1,max:1});const v=defaultEfficiencyViewport("2026-09-28");assert.equal(v.yMin,-1);assert.equal(v.yMax,1);assert.equal((v.xMax-v.xMin)/60000,390);});
test("stable signed efficiency is causal current-session SMA-5",()=>{assert.equal(STABLE_SMA_LENGTH,5);const rows=stableSignedEfficiency(points([.1,.2,.3,.4,.5,.9]));assert.deepEqual(rows.map(x=>Number(x.stable_efficiency.toFixed(2))),[.1,.15,.2,.25,.3,.46]);});
test("stable calculation keeps permanent signed orientation",()=>{const rows=stableSignedEfficiency(points([-.8,-.4,.2]));assert.ok(rows[0].stable_efficiency<0);assert.equal(Number(rows[2].stable_efficiency.toFixed(6)),-.333333);});
test("explicitly incomplete observations are excluded",()=>{const rows=points([.1,.9,.2]);rows[1].completed=false;assert.deepEqual(stableSignedEfficiency(rows).map(x=>x.efficiency),[.1,.2]);});
test("SMA has prefix equivalence and no future dependency",()=>{const all=stableSignedEfficiency(points([.1,.3,-.2,.4]));assert.deepEqual(all.slice(0,2),stableSignedEfficiency(points([.1,.3])));});
test("positive raw segments are green",()=>{assert.deepEqual(signedSegments(points([.1,.2])).map(x=>x.sign),["positive"]);});
test("negative raw segments are red",()=>{assert.deepEqual(signedSegments(points([-.1,-.2])).map(x=>x.sign),["negative"]);});
test("zero crossing is interpolated exactly",()=>{const s=signedSegments(points([-.25,.75]));assert.equal(s[0].to.efficiency,0);assert.equal(s[1].from.efficiency,0);});
test("M1 freshness is 120 seconds",()=>{assert.equal(FRESHNESS_SECONDS.M1,120);assert.equal(efficiencyFreshness("M1",at(0),Date.parse(at(0))+120000),"CURRENT");assert.equal(efficiencyFreshness("M1",at(0),Date.parse(at(0))+120001),"STALE");});
test("M5 freshness is 360 seconds",()=>{assert.equal(FRESHNESS_SECONDS.M5,360);assert.equal(efficiencyFreshness("M5",at(0),Date.parse(at(0))+360000),"CURRENT");assert.equal(efficiencyFreshness("M5",at(0),Date.parse(at(0))+360001),"STALE");});
test("missing timestamp is unavailable",()=>assert.equal(efficiencyFreshness("M1",null),"UNAVAILABLE"));
test("chart names the correct axes",()=>{const h=renderEfficiencyChart({symbol:"SPY",timeframe:"M1",points:points([.1,.2])});assert.match(h,/>Signed efficiency<\/text>/);assert.match(h,/>Time \(America\/Chicago\)<\/text>/);});
test("default chart displays all five fixed Y labels",()=>{const h=renderEfficiencyChart({symbol:"SPY",timeframe:"M1",points:points([.1,.2])});for(const label of ["+1.00","+0.50","0.00","-0.50","-1.00"])assert.ok(h.includes(`>${label}<`));});
test("line begins only at 08:35 CT",()=>{const h=renderEfficiencyChart({symbol:"SPY",timeframe:"M1",points:points([.1,.2,.3,.4,.5,.6])});assert.equal((h.match(/data-chart-point/g)||[]).length,1);});
test("raw and stable lines are explicitly identified",()=>{const h=renderEfficiencyChart({symbol:"SPY",timeframe:"M1",points:points([.1,.2,.3,.4,.5,.6])});assert.match(h,/Green = Positive Raw Signed Efficiency/);assert.match(h,/Blue = Stable Signed Efficiency/);assert.match(h,/class="eff-stable"/);});
test("chart contains persistent viewport metadata and Reset",()=>{const h=renderEfficiencyChart({symbol:"SPY",timeframe:"M1",points:points([.1,.2])});assert.match(h,/data-interactive-chart/);assert.match(h,/data-default-y-min="-1"/);assert.match(h,/data-action="chart-reset"/);});
test("point tooltip contains time, raw and stable values",()=>{const h=renderEfficiencyChart({symbol:"SPY",timeframe:"M1",points:points([.1,.2,.3,.4,.5,.6])});assert.match(h,/Raw Efficiency:/);assert.match(h,/Stable Efficiency:/);});
test("stable line is blue in shared CSS",async()=>{const css=await readFile(new URL("../screener/styles.css",import.meta.url),"utf8");assert.match(css,/lppc-efficiency-chart-v22 \.eff-stable\{stroke:#4b91ff/);});
test("chart module has no direction timeline or EMA",async()=>{const src=(await readFile(new URL("../screener/efficiency-chart.js",import.meta.url),"utf8")).toLowerCase();assert.ok(!src.includes("directiontimeline"));assert.ok(!src.includes("ema"));});
test("stable display has no path into LPPC or Telegram",async()=>{for(const file of [new URL("../../FinvizOpportunityScreener/src/fos/lppc_production.py",import.meta.url),new URL("../../FinvizOpportunityScreener/scripts/lppc_production_worker_v2.py",import.meta.url),new URL("../../FinvizOpportunityScreener/scripts/validate_lppc_telegram.py",import.meta.url)]){const src=(await readFile(file,"utf8")).toLowerCase();assert.ok(!src.includes("stable_signed_efficiency"),file.pathname);}});
