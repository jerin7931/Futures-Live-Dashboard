import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {parseRoute,defaultFilters} from "../screener/dashboard-core.js";
import {hydrateTrackerRows,filterTracked,sortTracked,defaultTrackerFilters} from "../screener/tracking-core.js";
import {renderWorkstation} from "../screener/workstation-view.js";

const tracker=(id,symbol,alignment,state,extra={})=>({id,symbol,session:"2026-09-22",direction:"LONG",
  alignment,tracker_state:state,data_status:"FRESH",first_confirmed_at:"2026-09-22T14:40:00Z",
  first_alignment_at:alignment==="ALIGNED"?"2026-09-22T14:45:00Z":null,
  movement_quality:"GOOD",atr_dollars:"1.5",atr_percent:"1.5",v1_state:"NO_TREND",...extra});
const model=(lifecycles)=>({schema_version:"FOS_LIVE_DASHBOARD_2",data_mode:"LIVE_DASHBOARD_READ_ONLY",
  as_of:"2026-09-22T14:50:00Z",opportunities:[],tracked_lifecycles:lifecycles,
  tracker_history_state:"READY"});
const doc=()=>{const ids=new Map(["pageEyebrow","pageTitle","demoBanner","modeBadge","snapshotTime","connection","page"]
  .map(id=>[id,{textContent:"",innerHTML:"",hidden:false}]));
  return {ids,getElementById(id){return ids.get(id);},querySelectorAll(){return [];}};};

test("tracked route is separate from preconfirmation radar",()=>{
  assert.deepEqual(parseRoute("#/tracking"),{page:"tracking",demo:false});
  assert.match(readFileSync(new URL("../index.html",import.meta.url),"utf8"),/data-route="tracking"/);
});

test("terminal lifecycle is retained beside a later active lifecycle of same symbol",()=>{
  const rows=hydrateTrackerRows(model([tracker("old","CRM","ALIGNED","INVALIDATED",{invalidated_at:"2026-09-22T15:00:00Z"}),
    tracker("new","CRM","COUNTERTREND","TRACKING",{first_confirmed_at:"2026-09-22T15:05:00Z"})]));
  assert.equal(rows.length,2);
  assert.deepEqual(sortTracked(rows).map(row=>row.id),["new","old"]);
  assert.deepEqual(filterTracked(rows,{...defaultTrackerFilters(),nonterminalOnly:true}).map(row=>row.id),["new"]);
});

test("movement, direction, status, sector, data and null-last sorts stay local",()=>{
  const rows=hydrateTrackerRows(model([tracker("a","AAA","ALIGNED","TRACKING",{direction:"LONG",sector:"Technology",atr_percent:"2.1",movement_quality:"HIGH"}),
    tracker("b","BBB","COUNTERTREND","WEAKENING",{direction:"SHORT",sector:"Financials",atr_percent:"1.5",movement_quality:"GOOD",data_status:"STALE"}),
    tracker("c","CCC","UNKNOWN","INVALIDATED",{direction:"LONG",atr_percent:null,movement_quality:null})]));
  assert.deepEqual(filterTracked(rows,{direction:"LONG",movement:"GOOD+"}).map(row=>row.id),["a"]);
  assert.deepEqual(filterTracked(rows,{status:"WEAKENING",data:"STALE",sector:"Financials"}).map(row=>row.id),["b"]);
  assert.deepEqual(sortTracked(rows,"atrPercent").map(row=>row.id),["a","b","c"]);
});

test("two sections show unknown explicitly and escape untrusted tracker strings",()=>{
  const value=model([tracker("a","AAA","ALIGNED","TRACKING",{company_name:"Safe"}),
    tracker("b","BBB","UNKNOWN","WEAKENING",{company_name:'<img src=x onerror="bad">'}),
    tracker("c","CCC","COUNTERTREND","INVALIDATED",{invalidation_reason:"INVALIDATED_COUNTERTREND_FAILED"})]);
  const document=doc();renderWorkstation(document,value,{page:"tracking",demo:false,trackerFilters:defaultTrackerFilters()},Date.parse(value.as_of));
  const html=document.ids.get("page").innerHTML;
  assert.match(html,/COUNTERTREND \/ AWAITING ALIGNMENT/);
  assert.match(html,/ATR UNKNOWN · AWAITING 5M DATA/);
  assert.match(html,/INVALIDATED_COUNTERTREND_FAILED/);
  assert.match(html,/&lt;img src=x/);assert.doesNotMatch(html,/<img src=x/);
});

test("a nonterminal V2 lifecycle leaves Radar while its current detail remains available",()=>{
  const value=model([tracker("active","CRM","ALIGNED","TRACKING")]);
  value.opportunities=[{symbol:"CRM",company_name:"CRM",confirmed_tracker:{id:"active",alignment:"ALIGNED"},tracker_state:"TRACKING"},
    {symbol:"ABC",company_name:"ABC",v1_state:"EMERGING"}];
  let document=doc();renderWorkstation(document,value,{page:"opportunities",demo:false,
    filters:{...defaultFilters(),includeETFs:true},watchlist:new Set()},Date.parse(value.as_of));
  assert.doesNotMatch(document.ids.get("page").innerHTML,/data-symbol="CRM"/);
  document=doc();renderWorkstation(document,value,{page:"tracking",demo:false,trackerFilters:defaultTrackerFilters()},Date.parse(value.as_of));
  assert.match(document.ids.get("page").innerHTML,/CRM/);
});
