import test from "node:test";
import assert from "node:assert/strict";
import {
  EFFICIENCY_BOUNDS,
  FRESHNESS_SECONDS,
  MOVE_BOUNDS,
  candleGeometry,
  defaultEfficiencyViewport,
  efficiencyFreshness,
  efficiencySplit,
  renderEfficiencyChart,
  signedSegments,
} from "../screener/efficiency-chart.js";

const at=(minute)=>`2026-09-28T${minute}:00.000Z`;
const points=[
  {observation_at:at("13:31"),completed:true,open:100,high:102,low:99,close:101,efficiency:-1,move_percentile:0},
  {observation_at:at("13:32"),completed:true,open:101,high:103,low:100,close:100.5,efficiency:0,move_percentile:.5},
  {observation_at:at("13:33"),completed:true,open:100.5,high:101,low:100,close:100.5,efficiency:1,move_percentile:1},
  {observation_at:at("13:34"),completed:true,open:null,high:null,low:null,close:null,efficiency:.25,move_percentile:null},
];

test("fixed viewport and display bounds remain frozen",()=>{
  const view=defaultEfficiencyViewport("2026-09-28");
  assert.equal((view.xMax-view.xMin)/60_000,390);
  assert.deepEqual(EFFICIENCY_BOUNDS,{min:-1,max:1});
  assert.deepEqual(MOVE_BOUNDS,{min:0,max:100});
  assert.deepEqual(FRESHNESS_SECONDS,{M1:120,M5:360});
});

test("efficiency maps exactly into candle body proportions",()=>{
  assert.deepEqual(efficiencySplit(-1),{bullish:0,bearish:1});
  assert.deepEqual(efficiencySplit(-.5),{bullish:.25,bearish:.75});
  assert.deepEqual(efficiencySplit(0),{bullish:.5,bearish:.5});
  assert.deepEqual(efficiencySplit(.5),{bullish:.75,bearish:.25});
  assert.deepEqual(efficiencySplit(1),{bullish:1,bearish:0});
});

test("candle geometry uses actual OHLC and direction",()=>{
  const geometry=candleGeometry(points[0],value=>200-value);
  assert.equal(geometry.wickTop,98);
  assert.equal(geometry.wickBottom,101);
  assert.equal(geometry.direction,"up");
  assert.equal(candleGeometry({open:2,high:1,low:0,close:2},x=>x),null);
});

test("rendered chart contains real candles, move bars, levels, and no interaction controls",()=>{
  const html=renderEfficiencyChart({symbol:"SPY",timeframe:"M1",points,levels:{dynamic_support:99.5,dynamic_resistance:103.5,pdh:104,pdl:98,pwh:105,pwl:97,gamma_flip:101.25},expanded:true,currentPrice:101.75,now:Date.parse(at("13:34"))});
  assert.match(html,/class="candle-outline candle-up" data-open="100" data-high="102" data-low="99" data-close="101"/);
  assert.match(html,/candle-down/);
  assert.match(html,/candle-flat/);
  assert.match(html,/data-move-percent="0\.000000000000"/);
  assert.match(html,/data-move-percent="50\.000000000000"/);
  assert.match(html,/data-move-percent="100\.000000000000"/);
  assert.match(html,/>100%<.*>50%<.*>0%</s);
  assert.match(html,/data-level="S" data-level-price="99\.5"/);
  assert.match(html,/data-level="FLIP" data-level-price="101\.25"/);
  assert.match(html,/is-expanded/);
  assert.match(html,/data-action="eff-timeframe".*>1M<\/button>/s);
  assert.match(html,/data-action="toggle-price-efficiency"/);
  assert.match(html,/SPY 101\.75/);
  assert.doesNotMatch(html,/data-action="(?:zoom|pan|reset)/i);
});

test("shared tooltip exposes the exact display values",()=>{
  const html=renderEfficiencyChart({symbol:"SPY",timeframe:"M1",points,now:Date.parse(at("13:34"))});
  for(const label of ["Open","High","Low","Close","Efficiency","Bullish","Bearish","Move"])assert.match(html,new RegExp(label));
  assert.match(html,/SPY M1 Price Efficiency candles and Move percentile bars/);
});

test("freshness and legacy signed segment behavior remain deterministic",()=>{
  assert.equal(efficiencyFreshness("M1",at("13:33"),Date.parse(at("13:34"))),"CURRENT");
  assert.equal(efficiencyFreshness("M1",at("13:31"),Date.parse(at("13:34"))),"STALE");
  assert.equal(signedSegments(points).length,3);
});
