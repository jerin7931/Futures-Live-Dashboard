import test from "node:test";
import assert from "node:assert/strict";
import {
  EFFICIENCY_BOUNDS,
  FRESHNESS_SECONDS,
  MOVE_BOUNDS,
  candleGeometry,
  clampRecentOffset,
  defaultEfficiencyViewport,
  efficiencyFreshness,
  efficiencySplit,
  gammaBarWidth,
  recentWindowSize,
  renderEfficiencyChart,
  scoreBarHeight,
  signedSegments,
  visibleEfficiencyRows,
  withLocalEfficiency,
} from "../screener/efficiency-chart.js";

const at=(minute)=>`2026-09-28T${minute}:00.000Z`;
const points=[
  {observation_at:at("13:31"),completed:true,open:100,high:102,low:99,close:101,efficiency:-1,move_percentile:0,model_score:.1},
  {observation_at:at("13:32"),completed:true,open:101,high:103,low:100,close:100.5,efficiency:0,move_percentile:.5,model_score:.2},
  {observation_at:at("13:33"),completed:true,open:100.5,high:101,low:100,close:100.5,efficiency:1,move_percentile:1,model_score:.4},
  {observation_at:at("13:34"),completed:true,open:null,high:null,low:null,close:null,efficiency:.25,move_percentile:null},
];
const localPoints=[100,101,100,102,101,103,104,102].map((close,index)=>({
  observation_at:new Date(Date.parse(at("13:31"))+index*60_000).toISOString(),completed:true,
  open:index%3===0?close-.5:index%3===1?close+.5:close,high:close+1,low:close-1,close,
  efficiency:index%2?-.99:.99,move_percentile:index/10,model_score:.1+index/100,
}));

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

test("rolling local efficiency uses exactly six completed closes and five signed moves",()=>{
  const rows=withLocalEfficiency(localPoints);
  assert.deepEqual(rows.slice(0,5).map(row=>row.local_efficiency),[null,null,null,null,null]);
  assert.ok(Math.abs(rows[5].local_efficiency-3/7)<1e-15);
  assert.ok(Math.abs(rows[7].local_efficiency-.25)<1e-15);
});

test("local efficiency preserves sign, returns zero for a flat path, and fails closed on missing closes",()=>{
  const down=withLocalEfficiency([6,5,4,3,2,1].map((close,index)=>({...localPoints[index],close})));
  assert.equal(down[5].local_efficiency,-1);
  const flat=withLocalEfficiency([2,2,2,2,2,2].map((close,index)=>({...localPoints[index],close})));
  assert.equal(flat[5].local_efficiency,0);
  const missing=withLocalEfficiency(localPoints.map((row,index)=>index===2?{...row,close:null}:row));
  assert.equal(missing[5].local_efficiency,null);
  assert.equal(missing[7].local_efficiency,null);
});

test("M1 and M5 use the same five-move local-efficiency definition",()=>{
  const m1=withLocalEfficiency(localPoints).map(row=>row.local_efficiency);
  const m5=withLocalEfficiency(localPoints.map((row,index)=>({...row,observation_at:new Date(Date.parse(at("13:35"))+index*300_000).toISOString()}))).map(row=>row.local_efficiency);
  assert.deepEqual(m5,m1);
});

test("candle geometry uses actual OHLC and direction",()=>{
  const geometry=candleGeometry(points[0],value=>200-value);
  assert.equal(geometry.wickTop,98);
  assert.equal(geometry.wickBottom,101);
  assert.equal(geometry.direction,"up");
  assert.equal(candleGeometry({open:2,high:1,low:0,close:2},x=>x),null);
});

test("rendered chart integrates local-efficiency candles, raw score, gamma, levels and viewport controls",()=>{
  const gamma={source_as_of:at("13:34"),payload:{summary:{net_gex:12_000_000,gamma_regime:"POSITIVE",zero_gamma_status:"CURRENT",zero_gamma:101.25},strike_profile:[{strike:100,net_gex:-5},{strike:101,net_gex:10}]}};
  const html=renderEfficiencyChart({symbol:"SPY",timeframe:"M1",points:localPoints,gamma,levels:{dynamic_support:99.5,dynamic_resistance:104.5,pdh:105,pdl:98,pwh:106,pwl:97,gamma_flip:101.25},expanded:true,currentPrice:101.75,currentMetrics:{efficiency:.75,move:.95,score:.88},now:Date.parse(localPoints.at(-1).observation_at)});
  assert.match(html,/class="candle-outline candle-up"/);
  assert.match(html,/candle-down/);
  assert.match(html,/candle-flat/);
  assert.match(html,/data-raw-score="0\.1"/);
  assert.match(html,/data-raw-score="0\.17"/);
  assert.match(html,/gamma-profile-bar gamma-negative/);
  assert.match(html,/gamma-profile-bar gamma-positive/);
  assert.match(html,/data-level="S" data-level-price="99\.5"/);
  assert.match(html,/data-level="FLIP" data-level-price="101\.25"/);
  assert.match(html,/is-expanded/);
  assert.match(html,/data-action="eff-timeframe".*>1M<\/button>/s);
  assert.match(html,/data-action="eff-mode".*>RECENT<\/button>/s);
  assert.match(html,/data-action="eff-latest"/);
  assert.match(html,/data-action="toggle-price-efficiency"/);
  assert.match(html,/SPY 101\.75/);
  assert.match(html,/LOCAL EFF \+0\.250 · MOVE 95\.0% · SCORE 0\.8800/);
  assert.doesNotMatch(html,/LOCAL EFF \+0\.750/);
  assert.match(html,/RAW SCORE SCALE 0–0\.1700/);
  assert.match(html,/NET Γ 12\.00M/);
  assert.doesNotMatch(html,/move-frame|move-bars|lppc-gamma/);
  assert.doesNotMatch(html,/data-action="(?:zoom|pan|reset)/i);
});

test("shared tooltip exposes the exact display values",()=>{
  const html=renderEfficiencyChart({symbol:"SPY",timeframe:"M1",points:localPoints,now:Date.parse(localPoints.at(-1).observation_at)});
  for(const label of ["Open","High","Low","Close","Local efficiency","Bullish","Bearish","Move","Raw score"])assert.match(html,new RegExp(label));
  assert.match(html,/SPY M1 combined Price Local Efficiency, gamma profile and raw model score chart/);
  assert.equal((html.match(/class="candle-missing"/g)||[]).length,5);
  assert.match(html,/Local efficiency \+0\.250/);
});

test("local efficiency is computed before RECENT/FULL slicing and remains invariant while dragging",()=>{
  const rows=Array.from({length:75},(_,index)=>{const close=100+Math.sin(index/4);return {...localPoints[index%localPoints.length],observation_at:new Date(Date.parse(at("13:31"))+index*60_000).toISOString(),open:close-.1,high:close+.2,low:close-.2,close};});
  const full=renderEfficiencyChart({symbol:"SPY",timeframe:"M1",points:rows,mode:"FULL"});
  const recent=renderEfficiencyChart({symbol:"SPY",timeframe:"M1",points:rows,mode:"RECENT",recentOffset:0});
  const dragged=renderEfficiencyChart({symbol:"SPY",timeframe:"M1",points:rows,mode:"RECENT",recentOffset:15});
  const expected=withLocalEfficiency(rows).at(-1).local_efficiency;
  const token=`LOCAL EFF ${expected>=0?"+":""}${expected.toFixed(3)}`;
  assert.match(full,new RegExp(token.replace(/[+]/g,"\\+")));
  assert.match(recent,new RegExp(token.replace(/[+]/g,"\\+")));
  assert.match(dragged,new RegExp(token.replace(/[+]/g,"\\+")));
  assert.equal((dragged.match(/class="candle-missing"/g)||[]).length,5);
});

test("persisted session efficiency cannot influence local candle composition or header",()=>{
  const changed=localPoints.map(row=>({...row,efficiency:row.efficiency*-1}));
  const strip=value=>value.replace(/efficiency:[^\s<]*/g,"");
  assert.equal(strip(renderEfficiencyChart({symbol:"SPY",timeframe:"M1",points:localPoints})),strip(renderEfficiencyChart({symbol:"SPY",timeframe:"M1",points:changed})));
});

test("recent windows and drag offsets are clamped deterministically",()=>{
  const rows=Array.from({length:75},(_,index)=>({...points[0],observation_at:new Date(Date.parse(at("13:31"))+index*60_000).toISOString()}));
  assert.equal(recentWindowSize("M1"),60);assert.equal(recentWindowSize("M5"),30);
  assert.equal(clampRecentOffset(rows.length,"M1",999),15);
  assert.deepEqual(visibleEfficiencyRows(rows,"M1","RECENT",0).rows.length,60);
  assert.equal(visibleEfficiencyRows(rows,"M1","RECENT",15).rows[0].observation_at,rows[0].observation_at);
  assert.equal(visibleEfficiencyRows(rows,"M1","FULL",12).rows.length,75);
  assert.equal(scoreBarHeight(.5,1,400),46);
  assert.equal(gammaBarWidth(-50,100,1000),100);
});

test("freshness and legacy signed segment behavior remain deterministic",()=>{
  assert.equal(efficiencyFreshness("M1",at("13:33"),Date.parse(at("13:34"))),"CURRENT");
  assert.equal(efficiencyFreshness("M1",at("13:31"),Date.parse(at("13:34"))),"STALE");
  assert.equal(signedSegments(points).length,3);
});
