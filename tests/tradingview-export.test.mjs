import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {highQualityTrackerFilters,tradingViewSymbols,tradingViewFilename} from "../screener/tracking-core.js";
import {renderWorkstation} from "../screener/workstation-view.js";

const tracker=(id,symbol,extra={})=>({id,symbol,tracker_state:"TRACKING",alignment:"ALIGNED",direction:"LONG",efficiency_at_confirmation:.85,current_efficiency:.8,option_quality:"GOOD",...extra});
const document=()=>{const ids=new Map(["pageEyebrow","pageTitle","demoBanner","modeBadge","snapshotTime","connection","page"].map(id=>[id,{innerHTML:"",textContent:"",hidden:false}]));return {getElementById:id=>ids.get(id),querySelectorAll:()=>[]};};

test("export uses every filtered row, ordered by the live Tracking sort rather than a viewport",()=>{
  const rows=Array.from({length:31},(_,i)=>tracker(`id-${i}`,`S${i}`,{current_efficiency:.99-i*.01}));
  rows.push(tracker("excluded","NOPE",{option_quality:"FAIR"}));
  const model={as_of:"2026-09-24T14:00:00Z",market_session:{date:"2026-09-24"},tracked_lifecycles:rows,
    tracker_option_quality_memory:Object.fromEntries(rows.map(row=>[row.id,{quality:row.option_quality,observed_at:modelTime}])) ,opportunities:rows.map(row=>({symbol:row.symbol,exchange_code:"NSQ"})),market_benchmarks:[],news:[]};
  const ui={page:"tracking",demo:false,trackerFilters:{...highQualityTrackerFilters(),sort:"currentEfficiencyHigh"},selectedTrackingView:"builtin:high-quality"};
  renderWorkstation(document(),model,ui,Date.parse(model.as_of));
  const output=tradingViewSymbols(ui.trackingFilteredRows);
  assert.equal(output.symbols.length,35);
  assert.deepEqual(output.symbols.slice(0,4),["SP:SPX","AMEX:SPY","NASDAQ:QQQ","AMEX:IWM"]);
  assert.equal(output.symbols[4],"NASDAQ:S0");assert.equal(output.symbols.at(-1),"NASDAQ:S30");
  assert.equal(output.text,output.symbols.join(","));assert.equal(output.text.includes("NOPE"),false);
});

const modelTime="2026-09-24T14:00:00Z";

test("exchange mapping is evidence-based, skips unmapped rows and de-duplicates in first-seen order",()=>{
  const output=tradingViewSymbols([
    {symbol:"NVDA",exchange_code:"NSQ"},{symbol:"CRM",exchange_code:"NYSE"},
    {symbol:"NVDA",tradingview_symbol:"NASDAQ:NVDA"},{symbol:"MYSTERY"},
    {symbol:"AMD",exchange:"UNKNOWN"},{symbol:"AAPL",tradingview_symbol:"NYSE:MSFT"},
  ]);
  assert.equal(output.text,"SP:SPX,AMEX:SPY,NASDAQ:QQQ,AMEX:IWM,NASDAQ:NVDA,NYSE:CRM");assert.equal(output.unmapped,3);
  assert.equal(tradingViewSymbols([]).text,"SP:SPX,AMEX:SPY,NASDAQ:QQQ,AMEX:IWM");
  assert.equal(tradingViewSymbols([{symbol:"ASST",exchange_code:"NMS"},{symbol:"MARA",exchange_code:"NAS"},{symbol:"BTG",exchange_code:"ASE"},{symbol:"SPY",exchange_code:"PSE"}]).text,
    "SP:SPX,AMEX:SPY,NASDAQ:QQQ,AMEX:IWM,NASDAQ:ASST,NASDAQ:MARA,AMEX:BTG");
});

test("benchmark defaults remain exportable when no opportunity matches",()=>{
  const model={as_of:modelTime,market_session:{date:"2026-09-24"},tracked_lifecycles:[],opportunities:[],market_benchmarks:[],news:[]};
  const ui={page:"tracking",demo:false,trackerFilters:highQualityTrackerFilters(),selectedTrackingView:"builtin:high-quality"};
  const doc=document();renderWorkstation(doc,model,ui,Date.parse(modelTime));
  assert.equal(ui.trackingFilteredRows.length,0);
  assert.match(doc.getElementById("page").innerHTML,/data-action="export-tradingview"/);
  assert.doesNotMatch(doc.getElementById("page").innerHTML,/data-action="export-tradingview" disabled/);
  assert.equal(tradingViewSymbols(ui.trackingFilteredRows).symbols.length,4);
});

test("TXT and copy use the same comma-separated output with a local-time filename",()=>{
  assert.equal(tradingViewFilename(new Date(2026,8,24,9,7)),"FOS_TradingView_2026-09-24_0907.txt");
  const app=readFileSync(new URL("../screener/app.js",import.meta.url),"utf8");
  const fn=app.slice(app.indexOf("async function tradingViewExport"),app.indexOf("function clear("));
  assert.match(fn,/navigator\.clipboard\.writeText\(result\.text\)/);
  assert.match(fn,/new Blob\(\[result\.text\]/);
  assert.doesNotMatch(fn,/refresh\(|client\.from\(|fetch\(/);
  assert.match(app,/ui\.trackingFilteredRows\|\|\[\]/);
});
