import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {dynamicSupportResistance,premarketHighLow,previousRegularSessionHighLow,rthVwap} from "../screener/tradingview-levels-reference.js";

const bar=(high,low,close=low+(high-low)/2,volume=100)=>({high,low,close,volume});

test("session extrema are used before a confirmed five-bar pivot exists",()=>{
  assert.deepEqual(dynamicSupportResistance([bar(10,8,9),bar(11,9,10),bar(10.5,9.5,10)]),{support:8,resistance:11,pivotHighs:[],pivotLows:[]});
});

test("a pivot is unavailable until both right-side minutes exist",()=>{
  const four=[bar(10,6),bar(11,7),bar(15,8),bar(12,7)];
  assert.deepEqual(dynamicSupportResistance(four).pivotHighs,[]);
  assert.deepEqual(dynamicSupportResistance([...four,bar(11,6)]).pivotHighs,[15]);
});

test("nearest confirmed support/resistance use equality pivots and current close crossing",()=>{
  const bars=[bar(12,8),bar(14,7),bar(16,5),bar(14,7),bar(13,8),bar(15,9),bar(17,10),bar(14,8),bar(13,7,12)];
  const first=dynamicSupportResistance(bars);
  assert.deepEqual(first.pivotLows,[5]);
  assert.ok(first.pivotHighs.includes(16));
  assert.equal(first.support,5);
  assert.equal(first.resistance,16);
  const crossed=dynamicSupportResistance([...bars,bar(18,14,17)]);
  assert.equal(crossed.resistance,17);
});

test("new completed minute updates native S/R without any gamma input",()=>{
  const bars=[bar(10,8,9),bar(11,7,10)];
  assert.equal(dynamicSupportResistance(bars).resistance,11);
  assert.equal(dynamicSupportResistance([...bars,bar(12,9,11)]).resistance,12);
});

test("PDH/PDL, premarket and RTH HLC3 VWAP are causal and SPX-safe",()=>{
  assert.deepEqual(previousRegularSessionHighLow([{high:10,low:5,complete:true},{high:12,low:6,complete:false}]),{pdh:10,pdl:5});
  assert.deepEqual(premarketHighLow([bar(11,8),bar(12,7)]),{pmh:12,pml:7});
  assert.deepEqual(premarketHighLow([bar(11,8)],true),{pmh:null,pml:null});
  assert.equal(rthVwap([bar(12,9,10,100),bar(14,10,13,300)]),((31/3)*100+(37/3)*300)/400);
  assert.equal(rthVwap([bar(12,9,10,100)],true),null);
});

test("Pine source is v6, one-minute/RTH native, gamma-only and non-lookahead for intraday levels",async()=>{
  const pine=await readFile(new URL("../LPPC_Gamma_Profile_Levels.pine",import.meta.url),"utf8");
  for(const required of ["//@version=6",'"TVG2"','"0930-1600:23456"','"0400-0930:23456"','request.security(extendedTicker, "1", f_native_sr()','candidateHigh == windowHigh','candidateLow == windowLow','array.min(sessionLows)','array.max(sessionHighs)','Gamma Profile Range %','Show Gamma Profile','TV native'])assert.ok(pine.includes(required),required);
  assert.ok(!pine.includes("lookahead=barmerge.lookahead_on)\n[nativeSupport"));
  for(const forbidden of ["LonesomeTheBlue","ATR channel","gross_gex","dynamic_support|"])
    assert.ok(!pine.includes(forbidden),forbidden);
});
