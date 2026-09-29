import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {buildTVG2,parseTVG2,TVG2_SYMBOLS} from "../screener/tradingview-gamma.js";
import {renderHome} from "../screener/lppc-view.js";

const at="2026-09-29T14:45:00.000Z";
const rows=TVG2_SYMBOLS.map((symbol,index)=>({
  symbol,source_as_of:new Date(Date.parse(at)+index*60_000).toISOString(),updated_at:"2099-01-01T00:00:00Z",status:index===2?"STALE":"CURRENT",
  payload:{summary:{gamma_regime:index%2?"LONG GAMMA":"SHORT GAMMA",zero_gamma:100+index,call_wall:102+index,put_wall:98+index,gamma_magnet:101+index},strike_profile:[{strike:99+index,net_gex:-2_500_000},{strike:100+index,net_gex:0},{strike:101+index,net_gex:1_234_567}]},
  dynamic_support:1,dynamic_resistance:2,pdh:3,pdl:4,pmh:5,pml:6,vwap:7,score:.8,efficiency:.9,direction:"UP",
}));

test("TVG2 is gamma-only, exact-order, true-source-time and net-GEX millions",()=>{
  const result=buildTVG2(rows,Date.parse("2026-09-29T15:00:00Z"));
  const lines=result.text.split("\n");
  assert.equal(lines[0],"TVG2");
  assert.equal(lines.length,5);
  assert.deepEqual(lines.slice(1).map(line=>line.split("|")[0]),TVG2_SYMBOLS);
  assert.equal(lines[1].split("|")[1],String(Date.parse(rows[0].source_as_of)));
  assert.notEqual(lines[1].split("|")[1],String(Date.parse(rows[0].updated_at)));
  assert.match(lines[1],/99:-2\.5,101:1\.2346$/);
  assert.equal(result.strikeCounts.SPX,2);
  for(const forbidden of ["support","resistance","pdh","pdl","pmh","pml","vwap","score","efficiency","direction"])
    assert.ok(!result.text.toLowerCase().includes(forbidden),forbidden);
});

test("all symbols parse independently and preserve CURRENT/STALE, positive and negative gamma",()=>{
  const packet=buildTVG2(rows).text;
  for(const symbol of TVG2_SYMBOLS){
    const parsed=parseTVG2(packet,symbol);
    assert.equal(parsed.symbol,symbol);
    assert.equal(parsed.status,symbol==="IWM"?"STALE":"CURRENT");
    assert.deepEqual(parsed.profile.map(item=>item.netGexMillions),[-2.5,1.2346]);
  }
});

test("bad packet, missing symbol and missing source data fail closed",()=>{
  const packet=buildTVG2(rows).text;
  assert.throws(()=>parseTVG2(packet.replace("TVG2","TVG1"),"SPY"),/BAD_VERSION/);
  assert.throws(()=>parseTVG2(packet.split("\n").slice(0,4).join("\n"),"SPY"),/RECORD_COUNT/);
  assert.throws(()=>parseTVG2(packet,"SMH"),/SYMBOL_NOT_FOUND/);
  assert.throws(()=>buildTVG2(rows.slice(1)),/MISSING_SPX/);
});

test("materiality is deterministic and never truncates by profile position",()=>{
  const dense=rows.map(row=>({...row,payload:{...row.payload,strike_profile:Array.from({length:120},(_,index)=>({strike:50+index,net_gex:index%2?-50:2_000_000}))}}));
  const result=buildTVG2(dense,Date.now(),{softLimit:1500,maxCharacters:40000});
  assert.ok(result.materialityThresholdMillions>0);
  assert.equal(result.strikeCounts.SPX,60);
  assert.match(result.text,/50:2,/m);
  assert.match(result.text,/168:2$/m);
});

test("Home exposes one prominent copy action and exact-packet fallback",()=>{
  const model={lppc:[],gamma:[],aiCurrent:[],aiHistory:[]};
  const normal=renderHome(model,{aiExpanded:{}});
  assert.equal((normal.match(/data-action="copy-tradingview-gamma"/g)||[]).length,1);
  assert.match(normal,/gamma-only TVG2 packet/);
  const fallback=renderHome(model,{aiExpanded:{},tradingViewGammaFallback:"TVG2\nA&B"});
  assert.match(fallback,/role="dialog"/);
  assert.match(fallback,/TVG2\nA&amp;B/);
});

test("active browser implements clipboard success path and manual fallback",async()=>{
  const app=await readFile(new URL("../screener/cash-open-app.js",import.meta.url),"utf8");
  assert.match(app,/navigator\.clipboard\?\.writeText/);
  assert.match(app,/tradingViewGammaFallback=result\.text/);
  assert.doesNotMatch(app,/support.*TVG2|TVG2.*dynamic_support/is);
});
