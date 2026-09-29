import test from "node:test";
import assert from "node:assert/strict";
import {EFFICIENCY_PAGE_SIZE,attachObservationScores,efficiencyIdentity,loadEfficiencyPages,mergeEfficiencyRows,overlapStart} from "../screener/efficiency-history.js";
import {renderEfficiencyChart} from "../screener/efficiency-chart.js";

const day="2026-09-28";
const symbols=["SPX","SPY","QQQ","IWM"];
const iso=minutes=>new Date(Date.UTC(2026,8,28,13,30+minutes)).toISOString();
function fixture(){
  const rows=[];
  for(const symbol of symbols){
    for(let minute=1;minute<=390;minute+=1)rows.push({symbol,timeframe:"M1",session_date:day,observation_at:iso(minute),efficiency:minute/390});
    for(let minute=5;minute<=390;minute+=5)rows.push({symbol,timeframe:"M5",session_date:day,observation_at:iso(minute),efficiency:minute/390});
  }
  return mergeEfficiencyRows([],rows,day);
}

test("paginated full-session loader recovers all 1,872 rows through 3:00 PM despite 1,000-row cap",async()=>{
  const source=fixture();
  assert.equal(source.length,1872);
  const calls=[];
  const loaded=await loadEfficiencyPages(async(from,to)=>{calls.push([from,to]);return source.slice(from,Math.min(to+1,from+1000));});
  const merged=mergeEfficiencyRows([],loaded.rows,day);
  assert.equal(calls[0][1]-calls[0][0]+1,EFFICIENCY_PAGE_SIZE);
  assert.equal(calls.length,2);
  assert.equal(merged.length,1872);
  assert.equal(new Set(merged.map(efficiencyIdentity)).size,1872);
  for(const symbol of symbols){
    for(const timeframe of ["M1","M5"]){
      const series=merged.filter(row=>row.symbol===symbol&&row.timeframe===timeframe);
      assert.equal(series.at(-1).observation_at,iso(390),`${symbol} ${timeframe}`);
    }
  }
  const chart=renderEfficiencyChart({symbol:"SPX",timeframe:"M1",points:merged.filter(row=>row.symbol==="SPX"&&row.timeframe==="M1")});
  assert.match(chart,/3:00 PM/);
});

test("stable secondary ordering preserves tied timestamps across a page boundary",async()=>{
  const source=fixture();
  const pageSize=997;
  assert.equal(source[pageSize-1].observation_at,source[pageSize].observation_at);
  const loaded=await loadEfficiencyPages(async(from,to)=>source.slice(from,to+1),{pageSize,maxPages:4});
  const merged=mergeEfficiencyRows([],loaded.rows,day);
  assert.equal(merged.length,1872);
  assert.equal(new Set(merged.map(efficiencyIdentity)).size,1872);
});

test("overlap refresh replaces delayed rows, deduplicates, and never crosses session date",()=>{
  const original=fixture();
  const corrected={...original.at(-1),efficiency:-0.5};
  const duplicate={...original.at(-2)};
  const wrongDay={...original.at(-3),session_date:"2026-09-27"};
  const merged=mergeEfficiencyRows(original,[corrected,duplicate,wrongDay],day);
  assert.equal(merged.length,1872);
  assert.equal(merged.find(row=>efficiencyIdentity(row)===efficiencyIdentity(corrected)).efficiency,-0.5);
  assert.equal(overlapStart(iso(390)),iso(375));
});

test("page safety cap fails closed instead of silently truncating",async()=>{
  await assert.rejects(()=>loadEfficiencyPages(async()=>Array(1000).fill({}),{maxPages:2}),/EFFICIENCY_PAGE_SAFETY_CAP_REACHED/);
});

test("persisted raw scores attach by exact symbol, timeframe and timestamp without fabricating gaps",()=>{
  const efficiency=fixture().slice(0,3),observations=[{...efficiency[0],model_score:.12},{...efficiency[2],model_score:.34}];
  const merged=attachObservationScores(efficiency,observations);
  assert.equal(merged[0].model_score,.12);
  assert.equal(merged[1].model_score,undefined);
  assert.equal(merged[2].model_score,.34);
  assert.equal(efficiency[0].model_score,undefined);
});
