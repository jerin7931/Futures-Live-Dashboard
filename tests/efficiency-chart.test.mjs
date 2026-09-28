import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {EFFICIENCY_BOUNDS,FRESHNESS_SECONDS,defaultEfficiencyViewport,efficiencyFreshness,renderEfficiencyChart,signedSegments} from "../screener/efficiency-chart.js";

const at=index=>new Date(Date.parse("2026-09-28T13:30:00Z")+index*60000).toISOString();
const points=values=>values.map((efficiency,index)=>({observation_at:at(index),efficiency,source_status:"CURRENT"}));

test("efficiency has no wheel, pinch, or drag chart behavior",async()=>{const files=["../screener/efficiency-chart.js","../screener/chart-tooltip.js","../screener/cash-open-app.js"];const source=(await Promise.all(files.map(file=>readFile(new URL(file,import.meta.url),"utf8")))).join("\n");for(const token of ["addEventListener(\"wheel\"","pinchViewport","setPointerCapture","touchAction","data-interactive-chart"])assert.ok(!source.includes(token),token);});
test("efficiency has no reset button",()=>{const h=renderEfficiencyChart({symbol:"SPY",timeframe:"M1",points:points([.1,.2])});assert.doesNotMatch(h,/chart-reset|>Reset</);});
test("fixed Chicago session viewport is 8:30 through 15:00",()=>{const view=defaultEfficiencyViewport("2026-09-28");assert.equal((view.xMax-view.xMin)/60000,390);const h=renderEfficiencyChart({symbol:"SPY",timeframe:"M1",points:points([.1,.2])});assert.match(h,/8:30 AM/);assert.match(h,/3:00 PM/);});
test("fixed signed domain is minus one through plus one",()=>{assert.deepEqual(EFFICIENCY_BOUNDS,{min:-1,max:1});const view=defaultEfficiencyViewport("2026-09-28");assert.deepEqual([view.yMin,view.yMax],[-1,1]);});
test("all five fixed Y labels are visible",()=>{const h=renderEfficiencyChart({symbol:"SPY",timeframe:"M1",points:points([.1,.2])});for(const label of ["+1.00","+0.50","0.00","-0.50","-1.00"])assert.ok(h.includes(`>${label}<`));});
test("line and tooltip points begin only at 08:35 CT",()=>{const h=renderEfficiencyChart({symbol:"SPY",timeframe:"M1",points:points([.1,.2,.3,.4,.5,.6,.7])});assert.equal((h.match(/data-chart-point/g)||[]).length,2);});
test("stable signed efficiency is absent from module and rendering",async()=>{const source=await readFile(new URL("../screener/efficiency-chart.js",import.meta.url),"utf8"),h=renderEfficiencyChart({symbol:"SPY",timeframe:"M1",points:points([.1,.2,.3,.4,.5,.6])});for(const token of ["STABLE_SMA_LENGTH","stableSignedEfficiency","Stable Signed Efficiency","eff-stable","legend-stable"])assert.ok(!source.includes(token)&&!h.includes(token),token);});
test("tooltip contains only CT time and raw efficiency",()=>{const h=renderEfficiencyChart({symbol:"SPY",timeframe:"M1",points:points([.1,.2,.3,.4,.5,.054])});assert.match(h,/8:35 AM CT · Raw Efficiency: 0.054/);assert.doesNotMatch(h,/Stable Efficiency/);});
test("positive raw segments are green",()=>assert.deepEqual(signedSegments(points([.1,.2])).map(x=>x.sign),["positive"]));
test("negative raw segments are red",()=>assert.deepEqual(signedSegments(points([-.1,-.2])).map(x=>x.sign),["negative"]));
test("zero crossing splits exactly into negative and positive",()=>{const segments=signedSegments(points([-.25,.75]));assert.deepEqual(segments.map(x=>x.sign),["negative","positive"]);assert.equal(segments[0].to.efficiency,0);assert.equal(segments[1].from.efficiency,0);assert.equal(Date.parse(segments[0].to.observation_at),Date.parse(at(0))+15000);});
test("freshness remains timeframe aware",()=>{assert.deepEqual(FRESHNESS_SECONDS,{M1:120,M5:360});assert.equal(efficiencyFreshness("M1",at(0),Date.parse(at(0))+120000),"CURRENT");assert.equal(efficiencyFreshness("M1",at(0),Date.parse(at(0))+120001),"STALE");assert.equal(efficiencyFreshness("M5",at(0),Date.parse(at(0))+360000),"CURRENT");});
test("raw chart names both axes",()=>{const h=renderEfficiencyChart({symbol:"SPY",timeframe:"M1",points:points([.1,.2])});assert.match(h,/>Signed efficiency<\/text>/);assert.match(h,/>Time \(America\/Chicago\)<\/text>/);});
test("tooltip binding is scale-neutral",async()=>{const source=await readFile(new URL("../screener/chart-tooltip.js",import.meta.url),"utf8");for(const token of ["viewport","scale","zoom","pan","preventDefault"])assert.ok(!source.includes(token),token);});
