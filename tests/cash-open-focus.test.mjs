import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {DEFAULT_FILTERS,filterTracking,focusRows,gateRows,route,tradingViewExport} from "../screener/cash-open-core.js";
import {cashOpenDemo} from "../screener/cash-open-demo.js";
import {renderHome,renderNews,renderTracking} from "../screener/cash-open-view.js";

const sample=()=>cashOpenDemo();

test("four current routes; removed hashes redirect to Home",()=>{
  for(const page of ["home","tracking","options-analysis","news"])
    assert.deepEqual(route(`#/${page}`),{demo:false,page,redirect:false});
  for(const old of ["opportunities","watchlist","market","sectors"])
    assert.deepEqual(route(`#/${old}`),{demo:false,page:"home",redirect:true});
  assert.deepEqual(route("#/demo/tracking"),{demo:true,page:"tracking",redirect:false});
});

test("focus membership is pinned while filters and sort operate locally",()=>{
  const rows=sample().candidates;
  const baseline=filterTracking(rows,DEFAULT_FILTERS);
  assert.deepEqual(baseline.selectedLong.map(row=>row.symbol),["NVDA","AMD"]);
  assert.deepEqual(baseline.selectedShort.map(row=>row.symbol),["MCD","CRM","UPS"]);
  const sorted=filterTracking(rows,{...DEFAULT_FILTERS,sort:"current-efficiency"});
  assert.deepEqual(sorted.selectedLong.map(row=>row.symbol),["NVDA","AMD"]);
  assert.deepEqual(sorted.selectedShort.map(row=>row.symbol),["MCD","CRM","UPS"]);
  assert.equal(filterTracking(rows,{...DEFAULT_FILTERS,direction:"SHORT"}).selectedLong.length,0);
  assert.equal(filterTracking(rows,{...DEFAULT_FILTERS,stage:"GATE"}).selectedShort.length,0);
  assert.equal(filterTracking(rows,{...DEFAULT_FILTERS,option:"GOOD+"}).selectedShort.length,2);
});

test("TradingView order ignores temporary filters and skips unmapped safely",()=>{
  const rows=sample().candidates;
  const result=tradingViewExport(rows);
  assert.deepEqual(result.symbols.slice(0,4),["SPCFD:SPX","AMEX:SPY","NASDAQ:QQQ","AMEX:IWM"]);
  assert.deepEqual(result.symbols.slice(4),[
    "NASDAQ:NVDA","NASDAQ:AMD","NYSE:MCD","NYSE:CRM","NYSE:UPS",
    "NYSE:CAT","NASDAQ:MSFT","NASDAQ:META"]);
  assert.equal(result.text,result.symbols.join(","));
  assert.equal(result.unmapped,0);
  const changed=[...rows,{...rows[0],symbol:"UNMAPPED",exchange_code:null,selected_0900:false,
    gate_0845:true,gate_rank:99}];
  assert.equal(tradingViewExport(changed).unmapped,1);
  assert.deepEqual(tradingViewExport(changed).symbols,result.symbols);
  assert.equal(filterTracking(rows,{...DEFAULT_FILTERS,query:"NO_MATCH"}).count,0);
  assert.deepEqual(tradingViewExport(rows).symbols,result.symbols);
});

test("Home, Tracking, News and demo render from current shape",()=>{
  const data=sample();
  const home=renderHome(data,true),tracking=renderTracking(data,DEFAULT_FILTERS),news=renderNews(data);
  assert.match(home,/LONG FOCUS/);assert.match(home,/SHORT FOCUS/);
  for(const symbol of ["SPX","SPY","QQQ","IWM"])assert.match(home,new RegExp(symbol));
  assert.match(home,/gamma-chart/);
  assert.match(tracking,/08:45 Opening Gate/);
  assert.match(tracking,/Export TradingView \.txt/);
  assert.match(news,/Simulated market headline/);
});

test("active bundle uses physical current-state reads and no model or provider calls",async()=>{
  const app=await readFile(new URL("../screener/cash-open-app.js",import.meta.url),"utf8");
  for(const table of ["fos_cash_open_session_current","fos_cash_open_candidates_current",
    "fos_options_analysis_current","fos_market_news_current"])assert.ok(app.includes(table));
  for(const forbidden of ["fos_current","fos_tracker_current","fos_symbol_history",
    "location.reload","OpenAI","Webull","Finviz"])assert.ok(!app.includes(forbidden));
  assert.match(app,/filters:\{\.\.\.DEFAULT_FILTERS\}/);
});
