import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {
  EFFICIENCY_BOUNDS,
  STABLE_EMA_LENGTH,
  renderEfficiencyChart,
  signedSegments,
  stableEfficiency,
  visibleEfficiencyRange,
} from "../screener/efficiency-chart.js";

const at=index=>`2026-09-28T14:${String(30+index).padStart(2,"0")}:00Z`;
const points=values=>values.map((efficiency,index)=>({observation_at:at(index),efficiency,source_status:"CURRENT"}));
const directions=states=>states.map((direction_state,index)=>({observation_at:at(index),direction_state}));

test("1 axis orientation is signed efficiency on Y and time on X",()=>{
  const html=renderEfficiencyChart({symbol:"SPY",timeframe:"M1",points:points([-.1,.2]),directionTimeline:directions(["BEARISH","BULLISH"]),freshness:{status:"CURRENT"}});
  assert.match(html,/data-axis="y"[^>]*>Signed efficiency/);
  assert.match(html,/data-axis="x"[^>]*>Time \(CT\)/);
});

test("2 semantic efficiency bounds remain minus one to plus one",()=>{
  assert.deepEqual(EFFICIENCY_BOUNDS,{min:-1,max:1});
  const html=renderEfficiencyChart({symbol:"SPY",timeframe:"M1",points:points([0]),directionTimeline:directions(["BULLISH"])});
  for(const label of ["+1","+0.5","0","−0.5","−1"])assert.ok(html.includes(`>${label}</text>`));
});

test("3 zero is always included in the visible range",()=>{
  for(const values of [[.7,.8],[-.8,-.7],[.1]]){const range=visibleEfficiencyRange(points(values));assert.ok(range.min<=0&&range.max>=0);}
});

test("4 dynamic zoom never crops observations",()=>{
  const rows=stableEfficiency(points([-.36,.18,.41]),directions(["BULLISH","BULLISH","BULLISH"]));
  const range=visibleEfficiencyRange(rows);
  assert.ok(range.min<=-.36&&range.max>=.41);
});

test("5 dynamic zoom stays inside true bounds",()=>{
  const range=visibleEfficiencyRange([{efficiency:-4,stable_efficiency:-2},{efficiency:3,stable_efficiency:2}]);
  assert.ok(range.min>=-1&&range.max<=1);
});

test("6 positive raw segments are green-class segments",()=>{
  assert.deepEqual(signedSegments(points([.1,.2])).map(row=>row.sign),["positive"]);
  assert.match(renderEfficiencyChart({symbol:"SPY",timeframe:"M1",points:points([.1,.2])}),/eff-positive/);
});

test("7 negative raw segments are red-class segments",()=>{
  assert.deepEqual(signedSegments(points([-.1,-.2])).map(row=>row.sign),["negative"]);
  assert.match(renderEfficiencyChart({symbol:"SPY",timeframe:"M1",points:points([-.1,-.2])}),/eff-negative/);
});

test("8 zero crossings split and interpolate at exactly zero",()=>{
  const segments=signedSegments(points([-.25,.75]));
  assert.deepEqual(segments.map(row=>row.sign),["negative","positive"]);
  assert.equal(segments[0].to.efficiency,0);assert.equal(segments[1].from.efficiency,0);
});

test("9 stable efficiency is the thin white named line",async()=>{
  const html=renderEfficiencyChart({symbol:"SPY",timeframe:"M1",points:points([.1,.2]),directionTimeline:directions(["BULLISH","BULLISH"])});
  assert.match(html,/class="eff-stable"/);assert.match(html,/White: Direction-Adjusted Stable Efficiency/);
  const css=await readFile(new URL("../screener/styles.css",import.meta.url),"utf8");
  assert.match(css,/\.eff-stable\{[^}]*stroke:#fff;[^}]*stroke-width:1\.1/);
});

test("10 stable efficiency excludes explicitly incomplete observations",()=>{
  const rows=points([.1,.9,.2]);rows[1].completed=false;
  assert.deepEqual(stableEfficiency(rows,directions(["BULLISH","BULLISH","BULLISH"])).map(row=>row.efficiency),[.1,.2]);
});

test("11 stable efficiency has prefix equivalence and no future dependency",()=>{
  const all=stableEfficiency(points([.1,.3,-.2,.4]),directions(["BULLISH","BEARISH","BULLISH","BEARISH"]));
  const prefix=stableEfficiency(points([.1,.3]),directions(["BULLISH","BEARISH"]));
  assert.deepEqual(all.slice(0,2),prefix);assert.equal(STABLE_EMA_LENGTH,20);
});

test("12 mixed and unknown direction carry prior EMA without inventing a sign",()=>{
  const rows=stableEfficiency(points([.2,.9,-.8]),directions(["BULLISH","MIXED","UNKNOWN"]));
  assert.equal(rows[0].stable_efficiency,.2);
  assert.equal(rows[1].direction_adjusted_efficiency,null);assert.equal(rows[1].stable_efficiency,.2);
  assert.equal(rows[2].direction_adjusted_efficiency,null);assert.equal(rows[2].stable_efficiency,.2);
});

test("13 M1 and M5 stable calculations remain independent",()=>{
  const m1=stableEfficiency(points([.2,.4]),directions(["BULLISH","BULLISH"]));
  const m5=stableEfficiency(points([-.6]),directions(["BEARISH"]));
  assert.equal(m1.length,2);assert.equal(m5.length,1);assert.equal(m5[0].stable_efficiency,.6);
});

test("14 SPX chart honors source freshness and cannot relabel stale data current",()=>{
  const html=renderEfficiencyChart({symbol:"SPX",timeframe:"M1",points:points([.2,.3]),directionTimeline:directions(["BULLISH","BULLISH"]),freshness:{status:"STALE",newest_completed_at:at(1)}});
  assert.match(html,/data-source-status="STALE"/);assert.match(html,/freshness-stale">STALE/);assert.doesNotMatch(html,/freshness-current">CURRENT/);
});

test("15 efficiency chart module does not mutate or import LPPC state calculations",async()=>{
  const source=await readFile(new URL("../screener/efficiency-chart.js",import.meta.url),"utf8");
  for(const forbidden of ["percentile_1m","threshold_1m","event_state","telegram","gamma","option_chain"])assert.ok(!source.toLowerCase().includes(forbidden),forbidden);
});

test("16 stable efficiency has no dependency path into backend decisions or Telegram",async()=>{
  const files=[
    new URL("../../FinvizOpportunityScreener/src/fos/lppc_production.py",import.meta.url),
    new URL("../../FinvizOpportunityScreener/scripts/lppc_production_worker_v2.py",import.meta.url),
    new URL("../../FinvizOpportunityScreener/scripts/validate_lppc_telegram.py",import.meta.url),
  ];
  for(const file of files){const source=(await readFile(file,"utf8")).toLowerCase();assert.ok(!source.includes("stable_efficiency"),file.pathname);assert.ok(!source.includes("direction_adjusted_efficiency"),file.pathname);}
});
