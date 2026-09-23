import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {parseRoute,defaultFilters} from "../screener/dashboard-core.js";
import {hydrateTrackerRows,filterTracked,sortTracked,defaultTrackerFilters,resolveTrackerHistory,rememberTrackerOptionQuality} from "../screener/tracking-core.js";
import {renderWorkstation,aiFreshness} from "../screener/workstation-view.js";

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

test("filtered tracker list survives intermittent paged read failure and recovers",()=>{
  const scope={ownerId:"owner-a",day:"2026-09-22"};
  const filters={...defaultTrackerFilters(),direction:"SHORT"};
  const rows=[tracker("a","AAA","ALIGNED","TRACKING",{direction:"SHORT"}),tracker("b","BBB","ALIGNED","TRACKING")];
  const first=resolveTrackerHistory(null,{rows,state:"READY"},scope);
  const failed=resolveTrackerHistory(first.cache,{rows:[],state:"UNAVAILABLE"},scope);
  assert.deepEqual(filterTracked(hydrateTrackerRows(model(failed.rows)),filters).map(row=>row.id),["a"]);
  assert.equal(failed.state,"UNAVAILABLE");
  const recovered=resolveTrackerHistory(failed.cache,{rows,state:"READY"},scope);
  assert.deepEqual(filterTracked(hydrateTrackerRows(model(recovered.rows)),filters).map(row=>row.id),["a"]);
});

test("tracker cache does not cross owners/sessions or hide a successful empty read",()=>{
  const scope={ownerId:"owner-a",day:"2026-09-22"};
  const first=resolveTrackerHistory(null,{rows:[tracker("a","AAA","ALIGNED","TRACKING")],state:"READY"},scope);
  assert.deepEqual(resolveTrackerHistory(first.cache,{rows:[],state:"UNAVAILABLE"},{ownerId:"owner-b",day:scope.day}).rows,[]);
  assert.deepEqual(resolveTrackerHistory(first.cache,{rows:[],state:"UNAVAILABLE"},{ownerId:scope.ownerId,day:"2026-09-23"}).rows,[]);
  assert.deepEqual(resolveTrackerHistory(first.cache,{rows:[],state:"READY"},scope).rows,[]);
  assert.deepEqual(resolveTrackerHistory(first.cache,{rows:[],state:"INCOMPLETE_HISTORY"},scope).rows,first.rows);
});

test("unchanged filtered tracking refresh keeps the existing table DOM",()=>{
  const value=model([tracker("a","AAA","ALIGNED","TRACKING",{direction:"SHORT"})]);
  const document=doc(),node=document.ids.get("page");let replacements=0;
  Object.defineProperty(node,"innerHTML",{get(){return this.html||"";},set(value){this.html=value;replacements++;}});
  const ui={page:"tracking",demo:false,trackerFilters:{...defaultTrackerFilters(),direction:"SHORT"}};
  const at=Date.parse(value.as_of);
  renderWorkstation(document,value,ui,at);
  renderWorkstation(document,value,ui,at+5000);
  assert.equal(replacements,1);
  assert.match(node.innerHTML,/AAA/);
  assert.match(node.innerHTML,/<strong>AAA<\/strong>/);
});

test("Fair+ tracker filter retains last observed quality through a temporary option gap",()=>{
  const scope={ownerId:"owner-a",day:"2026-09-23"};
  const value=model([tracker("active","AAA","ALIGNED","TRACKING",{confirmation_efficiency:0.9})]);
  const observedAt=new Date(Date.now()-1000).toISOString();
  value.opportunities=[{symbol:"AAA",confirmed_tracker:{id:"active"},option_execution_quality:{tracker_id:"active",overall_quality:"GOOD",updated_at:observedAt,valid_until:new Date(Date.now()+10000).toISOString(),contracts:[{bid:1,ask:2}]}}];
  const first=rememberTrackerOptionQuality(null,value,scope);
  assert.deepEqual(Object.keys(first.values),["active"]);
  assert.equal(first.values.active.contracts,undefined);
  value.tracker_option_quality_memory=first.values;
  assert.deepEqual(filterTracked(hydrateTrackerRows(value),{efficiency:"0.80",optionQuality:"FAIR+"}).map(row=>row.id),["active"]);
  value.opportunities=[{symbol:"AAA",confirmed_tracker:{id:"active"},option_execution_quality:null}];
  const gap=rememberTrackerOptionQuality(first,value,scope);
  value.tracker_option_quality_memory=gap.values;
  const duringGap=filterTracked(hydrateTrackerRows(value),{efficiency:"0.80",optionQuality:"FAIR+"});
  assert.deepEqual(duringGap.map(row=>row.id),["active"]);
  assert.equal(duringGap[0].option_quality_current,false);
  const document=doc();renderWorkstation(document,value,{page:"tracking",demo:false,trackerFilters:{...defaultTrackerFilters(),efficiency:"0.80",optionQuality:"FAIR+"}},Date.parse(value.as_of));
  assert.match(document.ids.get("page").innerHTML,/Last observed · not current/);
  value.opportunities[0].option_execution_quality={tracker_id:"active",overall_quality:"POOR",updated_at:new Date(Date.now()+1000).toISOString(),valid_until:new Date(Date.now()+15000).toISOString()};
  value.tracker_option_quality_memory=rememberTrackerOptionQuality(gap,value,scope).values;
  assert.deepEqual(filterTracked(hydrateTrackerRows(value),{efficiency:"0.80",optionQuality:"FAIR+"}),[]);
});

test("Good+ with efficiency high-low keeps tracker identities ordered during an option gap",()=>{
  const scope={ownerId:"owner-a",day:"2026-09-23"},stamp=new Date().toISOString();
  const value=model([
    tracker("fast","AAA","ALIGNED","TRACKING",{confirmation_efficiency:0.94}),
    tracker("slow","BBB","ALIGNED","TRACKING",{confirmation_efficiency:0.82}),
    tracker("below","CCC","ALIGNED","TRACKING",{confirmation_efficiency:0.79}),
  ]);
  value.opportunities=["AAA","BBB","CCC"].map((symbol,index)=>({symbol,confirmed_tracker:{id:["fast","slow","below"][index]},
    option_execution_quality:{tracker_id:["fast","slow","below"][index],overall_quality:"GOOD",updated_at:stamp}}));
  const remembered=rememberTrackerOptionQuality(null,value,scope);
  value.opportunities=[];
  value.tracker_option_quality_memory=rememberTrackerOptionQuality(remembered,value,scope).values;
  const filters={...defaultTrackerFilters(),efficiency:"0.80",optionQuality:"GOOD+",sort:"currentEfficiencyHigh"};
  assert.deepEqual(filterTracked(hydrateTrackerRows(value),filters).map(row=>row.id),["fast","slow"]);
  const document=doc();renderWorkstation(document,value,{page:"tracking",demo:false,trackerFilters:filters},Date.parse(value.as_of));
  assert.match(document.ids.get("page").innerHTML,/data-tracker-id="fast"/);
  assert.ok(document.ids.get("page").innerHTML.indexOf('data-tracker-id="fast"')<document.ids.get("page").innerHTML.indexOf('data-tracker-id="slow"'));
});

test("tracking displays immutable confirmation and changing current V1 efficiency separately",()=>{
  const old=tracker("old","CRM","ALIGNED","INVALIDATED",{
    confirmation_efficiency:"0.91",efficiency_at_confirmation:"0.91",current_efficiency:"0.72"});
  const current=tracker("new","CRM","COUNTERTREND","TRACKING",{
    confirmation_efficiency:"0.74",efficiency_at_confirmation:"0.74",current_efficiency:"0.42"});
  const unknown=tracker("unknown","ZZZ","ALIGNED","TRACKING",{
    confirmation_efficiency:null,efficiency_at_confirmation:null,current_efficiency:"0.86"});
  const value=model([old,current,unknown]);
  value.opportunities=[{symbol:"ZZZ",efficiency:0.99}];
  let rows=hydrateTrackerRows(value);
  assert.equal(rows.find(row=>row.id==="unknown").efficiency_at_confirmation,null);
  assert.equal(rows.find(row=>row.id==="new").current_efficiency,0.42);
  assert.deepEqual(filterTracked(rows,{efficiency:"0.80"}).map(row=>row.id),["unknown"]);
  assert.deepEqual(sortTracked(rows,"confirmationEfficiencyHigh").map(row=>row.id),["old","new","unknown"]);
  assert.deepEqual(sortTracked(rows,"confirmationEfficiencyLow").map(row=>row.id),["new","old","unknown"]);
  assert.deepEqual(sortTracked(rows,"currentEfficiencyHigh").map(row=>row.id),["unknown","old","new"]);
  assert.deepEqual(sortTracked(rows,"currentEfficiencyLow").map(row=>row.id),["new","old","unknown"]);
  const document=doc();renderWorkstation(document,value,{page:"tracking",demo:false,trackerFilters:defaultTrackerFilters()},Date.parse(value.as_of));
  const html=document.ids.get("page").innerHTML;
  assert.match(html,/>Eff @ Confirm</);assert.match(html,/>Current Eff</);
  assert.match(html,/Current efficiency/);assert.match(html,/Efficiency @ Confirmation/);
  assert.match(html,/Confirmation Efficiency — High to Low/);
  assert.match(html,/Current Efficiency — Low to High/);
  assert.match(html,/data-tracker-id="unknown"[\s\S]*?<td><strong>—<\/strong><\/td>/);
  value.tracked_lifecycles[1]={...current,current_efficiency:"0.63"};
  rows=hydrateTrackerRows(value);
  assert.equal(rows.find(row=>row.id==="new").efficiency_at_confirmation,0.74);
  assert.equal(rows.find(row=>row.id==="new").current_efficiency,0.63);
  const css=readFileSync(new URL("../screener/styles.css",import.meta.url),"utf8");
  assert.match(css,/\.tracked-table-wrap\{max-width:100%;overflow-x:auto\}/);
  assert.match(css,/\.tracked-table\{width:100%;table-layout:fixed/);
});

test("remembered option quality never crosses owner or session",()=>{
  const value=model([]);
  const previous={ownerId:"owner-a",day:"2026-09-23",values:{old:{quality:"GOOD",observed_at:new Date().toISOString()}}};
  assert.deepEqual(rememberTrackerOptionQuality(previous,value,{ownerId:"owner-b",day:"2026-09-23"}).values,{});
  assert.deepEqual(rememberTrackerOptionQuality(previous,value,{ownerId:"owner-a",day:"2026-09-24"}).values,{});
});

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

test("AI analysis joins by tracker ID, remains on terminal lifecycle, and never leaks to reentry",()=>{
  const value=model([tracker("old","CRM","ALIGNED","INVALIDATED"),tracker("new","CRM","ALIGNED","TRACKING")]);
  value.ai_analysis_by_tracker_id={old:{tracker_id:"old",generated_at:value.as_of,source_as_of:value.as_of,
    analysis_summary:"Historical read <script>alert(1)</script>",analysis_markdown:"# Old only"}};
  const rows=hydrateTrackerRows(value);
  assert.equal(rows.find(row=>row.id==="old").ai_analysis.analysis_summary.startsWith("Historical"),true);
  assert.equal(rows.find(row=>row.id==="new").ai_analysis,null);
  const document=doc();renderWorkstation(document,value,{page:"tracking",demo:false,trackerFilters:defaultTrackerFilters()},Date.parse(value.as_of));
  const html=document.ids.get("page").innerHTML;
  assert.match(html,/AI Analysis/);assert.match(html,/No AI analysis requested yet/);
  assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>alert/);
});

test("AI freshness labels and unavailable storage are explicit without browser model calls",()=>{
  const at=Date.parse("2026-09-22T14:50:00Z");
  assert.equal(aiFreshness({source_as_of:new Date(at-4*60000).toISOString()},at),"FRESH");
  assert.equal(aiFreshness({source_as_of:new Date(at-10*60000).toISOString()},at),"AGING");
  assert.equal(aiFreshness({source_as_of:new Date(at-16*60000).toISOString()},at),"STALE");
  const value=model([tracker("a","AAA","ALIGNED","TRACKING")]);value.ai_analysis_state="UNAVAILABLE";
  const document=doc();renderWorkstation(document,value,{page:"tracking",demo:false,trackerFilters:defaultTrackerFilters()},at);
  assert.match(document.ids.get("page").innerHTML,/AI analysis storage unavailable/);
  const app=readFileSync(new URL("../screener/app.js",import.meta.url),"utf8");
  assert.match(app,/fos_ai_analysis_current/);assert.doesNotMatch(app,/api\.openai|openai\.com|chat\.completions|responses\.create/i);
});

test("movement, direction, status, sector, data and null-last sorts stay local",()=>{
  const rows=hydrateTrackerRows(model([tracker("a","AAA","ALIGNED","TRACKING",{direction:"LONG",sector:"Technology",atr_percent:"2.1",movement_quality:"HIGH"}),
    tracker("b","BBB","COUNTERTREND","WEAKENING",{direction:"SHORT",sector:"Financials",atr_percent:"1.5",movement_quality:"GOOD",data_status:"STALE"}),
    tracker("c","CCC","UNKNOWN","INVALIDATED",{direction:"LONG",atr_percent:null,movement_quality:null})]));
  assert.deepEqual(filterTracked(rows,{direction:"LONG",movement:"GOOD+"}).map(row=>row.id),["a"]);
  assert.deepEqual(filterTracked(rows,{status:"WEAKENING",data:"STALE",sector:"Financials"}).map(row=>row.id),["b"]);
  assert.deepEqual(sortTracked(rows,"atrPercent").map(row=>row.id),["a","b","c"]);
});

test("dollar movers remain visible in All but not percentage quality floors",()=>{
  const rows=hydrateTrackerRows(model([
    tracker("high","AAA","ALIGNED","TRACKING",{movement_quality:"HIGH"}),
    tracker("good","BBB","ALIGNED","TRACKING",{movement_quality:"GOOD"}),
    tracker("acceptable","CCC","ALIGNED","TRACKING",{movement_quality:"ACCEPTABLE"}),
    tracker("dollar","DDD","ALIGNED","TRACKING",{movement_quality:"DOLLAR_MOVER",atr_dollars:"6.5",atr_percent:"0.97"}),
  ]));
  assert.equal(filterTracked(rows,{movement:"ALL"}).length,4);
  assert.deepEqual(filterTracked(rows,{movement:"HIGH"}).map(row=>row.id),["high"]);
  assert.deepEqual(new Set(filterTracked(rows,{movement:"GOOD+"}).map(row=>row.id)),new Set(["high","good"]));
  assert.deepEqual(new Set(filterTracked(rows,{movement:"ACCEPTABLE+"}).map(row=>row.id)),new Set(["high","good","acceptable"]));
  assert.deepEqual(filterTracked(rows,{movement:"DOLLAR_MOVER"}).map(row=>row.id),["dollar"]);
  assert.deepEqual(sortTracked(rows,"movement").map(row=>row.id),["high","good","acceptable","dollar"]);
  const document=doc();renderWorkstation(document,model(rows),{page:"tracking",demo:false,trackerFilters:defaultTrackerFilters()},Date.parse("2026-09-22T14:50:00Z"));
  assert.match(document.ids.get("page").innerHTML,/Dollar Movers/);
  assert.match(document.ids.get("page").innerHTML,/DOLLAR_MOVER/);
});

test("radar keeps ATR dollars, ATR percent and dollar-mover label visible",()=>{
  const value=model([]);
  value.opportunities=[{symbol:"BIG",company_name:"Big Corp",asset_type:"STOCK",
    v1_state:"NO_TREND",atr_dollars:6.5,atr_percent:0.97,
    movement_quality:"DOLLAR_MOVER",movement_admission_basis:"ATR_DOLLAR"}];
  const document=doc();renderWorkstation(document,value,{page:"opportunities",demo:false,
    filters:{...defaultFilters(),includeETFs:true},watchlist:new Set()},Date.parse(value.as_of));
  const html=document.ids.get("page").innerHTML;
  assert.match(html,/ATR \$6\.50/);
  assert.match(html,/0\.97%/);
  assert.match(html,/DOLLAR_MOVER/);
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
