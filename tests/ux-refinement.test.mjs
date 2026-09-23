import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {TRACKER_FIELDS,TRACKER_SORTS,HIGH_QUALITY_RULES,highQualityTrackerFilters,filterTracked,matchesTrackerRule} from "../screener/tracking-core.js";
import {homeFocusData,renderWorkstation} from "../screener/workstation-view.js";

const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),"utf8");
const tracker=(id,symbol,extra={})=>({id,symbol,tracker_state:"TRACKING",alignment:"ALIGNED",direction:"LONG",efficiency_at_confirmation:.85,current_efficiency:.75,option_quality:"GOOD",data_status:"FRESH",...extra});
const model=rows=>({as_of:"2026-09-23T14:00:00Z",market_session:{date:"2026-09-23"},data_mode:"LIVE_DASHBOARD_READ_ONLY",tracked_lifecycles:rows,tracker_option_quality_memory:Object.fromEntries(rows.map(row=>[row.id,{quality:row.option_quality,observed_at:"2026-09-23T14:00:00Z"}])),opportunities:[],market_benchmarks:[],news:[]});
const doc=()=>{const ids=new Map(["pageEyebrow","pageTitle","demoBanner","modeBadge","snapshotTime","connection","page"].map(id=>[id,{innerHTML:"",textContent:"",hidden:false}]));return {ids,getElementById:id=>ids.get(id),querySelectorAll:()=>[]};};

test("built-in High Quality uses alignment, confirmation efficiency and GOOD+ only",()=>{
  const f=highQualityTrackerFilters();assert.deepEqual(f.rules,HIGH_QUALITY_RULES);
  const rows=[tracker("a","AAA",{current_efficiency:.32}),tracker("b","BBB",{efficiency_at_confirmation:.79}),tracker("c","CCC",{option_quality:"FAIR"}),tracker("d","DDD",{alignment:"COUNTERTREND"})];
  assert.deepEqual(filterTracked(rows,f).map(row=>row.id),["a"]);
});

test("numeric and categorical rule operators, quality ordering, and null-last sort",()=>{
  const rows=[tracker("a","AAA",{current_efficiency:.8,atr_percent:1.8}),tracker("b","BBB",{current_efficiency:.6,atr_percent:1.2,option_quality:"EXCELLENT"}),tracker("c","CCC",{current_efficiency:null,atr_percent:null,option_quality:"FAIR"})];
  assert.deepEqual(filterTracked(rows,{rules:[{field:"atrPercent",operator:"between",value:1.5,value2:2}]}).map(row=>row.id),["a"]);
  assert.deepEqual(filterTracked(rows,{rules:[{field:"efficiency",operator:">=",value:.7}]}).map(row=>row.id),["a"]);
  assert.deepEqual(filterTracked(rows,{rules:[{field:"direction",operator:"is one of",value:"LONG,SHORT"}]}).length,3);
  assert.deepEqual(filterTracked(rows,{rules:[{field:"optionQuality",operator:">=",value:"GOOD"}]}).map(row=>row.id),["a","b"]);
  assert.deepEqual(filterTracked(rows,{sort:"currentEfficiencyHigh"}).map(row=>row.id),["a","b","c"]);
  assert.ok(TRACKER_FIELDS.atrFibPullback.numeric);assert.ok(TRACKER_SORTS.atrFibDeep);
});

test("Home selects at most five qualifying setups, deterministic pulse and current attention",()=>{
  const rows=Array.from({length:7},(_,i)=>tracker(`id-${i}`,`S${i}`,{current_efficiency:.9-i*.05}));
  rows.push(tracker("weak","WK",{tracker_state:"WEAKENING",efficiency_at_confirmation:.4}));
  rows.push(tracker("ct","CT",{alignment:"COUNTERTREND",option_quality:"FAIR"}));
  rows.push(tracker("old","OLD",{tracker_state:"INVALIDATED"}));
  const data=homeFocusData(model(rows));assert.equal(data.best.length,5);assert.deepEqual(data.best.map(row=>row.id),["id-0","id-1","id-2","id-3","id-4"]);
  assert.equal(data.groups.ALIGNED.length,8);assert.equal(data.groups.COUNTERTREND.length,1);assert.equal(data.attention[0].row.id,"weak");
});

test("three tracking renders preserve selected view, chips, sort and filtered identities",()=>{
  const value=model([tracker("a","AAA",{current_efficiency:.91}),tracker("b","BBB",{option_quality:"FAIR"}),tracker("c","CCC",{alignment:"COUNTERTREND"})]);
  const ui={page:"tracking",demo:false,trackerFilters:{...highQualityTrackerFilters(),sort:"currentEfficiencyHigh"},selectedTrackingView:"builtin:high-quality",trackerFormRevision:0};
  const document=doc(),page=document.ids.get("page");let writes=0;Object.defineProperty(page,"innerHTML",{get(){return this.html||"";},set(value){this.html=value;writes++;}});
  for(let n=0;n<4;n++){value.as_of=new Date(Date.parse("2026-09-23T14:00:00Z")+n*5000).toISOString();renderWorkstation(document,value,ui,Date.parse(value.as_of));assert.match(page.innerHTML,/data-tracker-id="a"/);assert.doesNotMatch(page.innerHTML,/data-tracker-id="b"/);assert.match(page.innerHTML,/High Quality/);assert.match(page.innerHTML,/currentEfficiencyHigh/);}
  assert.equal(writes,1);assert.equal(ui.trackerFilters.rules.length,3);assert.equal(ui.selectedTrackingView,"builtin:high-quality");
  const app=read("screener/app.js");assert.doesNotMatch(app,/location\.reload\(/);assert.match(app,/loadTrackingPresets\(force=false\)/);
  assert.ok(app.indexOf('from("fos_filter_presets")')<app.indexOf('async function refresh()'));
});

test("news priority is bounded and source/category text is escaped",()=>{
  const value=model([tracker("a","AAA")]);value.news=Array.from({length:8},(_,i)=>({headline:i===0?"<script>alert(1)</script>":`Story ${i}`,symbols:i===0?["AAA"]:[],category:"MARKET",first_seen_at:new Date(Date.parse(value.as_of)-i*60000).toISOString()}));
  const data=homeFocusData(value);assert.equal(data.news.length,6);assert.equal(data.news[0].headline,"<script>alert(1)</script>");
  const document=doc();renderWorkstation(document,value,{page:"home",demo:false},Date.parse(value.as_of));
  assert.doesNotMatch(document.ids.get("page").innerHTML,/<script>alert/);assert.match(document.ids.get("page").innerHTML,/&lt;script&gt;/);
});

test("Midnight CSP keeps old network boundaries and uses one shared stylesheet",()=>{
  const root=read("index.html"),nested=read("screener/index.html"),css=read("screener/styles.css");
  for(const html of [root,nested]){assert.match(html,/font-src 'self' https:\/\/cdn\.jsdelivr\.net/);assert.match(html,/frame-src 'none'/);assert.match(html,/form-action 'self'/);}
  for(const value of ["#0e1117","#12161d","#171c24","Geist","Inter","IBM Plex Mono",".tracking-chips",".focus-grid"])assert.ok(css.includes(value),value);
  assert.match(root,/styles\.css\?v=3\.0\.31/);assert.match(nested,/styles\.css\?v=3\.0\.31/);
});

test("saved-view actions use an in-page editor, not unsupported browser dialogs",()=>{
  const document=doc();renderWorkstation(document,model([tracker("a","AAA")]),{page:"tracking",demo:false,trackerFilters:highQualityTrackerFilters(),selectedTrackingView:"custom",trackerPresetEditor:{mode:"save",name:""},trackerPresetError:""},Date.parse("2026-09-23T14:00:00Z"));
  assert.match(document.ids.get("page").innerHTML,/id="trackingPresetEditor"/);
  assert.match(document.ids.get("page").innerHTML,/Name this Tracking view/);
  const app=read("screener/app.js");assert.doesNotMatch(app,/window\.(prompt|confirm|alert)\(/);
});

test("edited saved view retains its identity and an explicit Update action",()=>{
  const document=doc();renderWorkstation(document,model([tracker("a","AAA")]),{page:"tracking",demo:false,trackerFilters:{...highQualityTrackerFilters(),sort:"currentEfficiencyHigh"},selectedTrackingView:"preset-a",trackerViewDirty:true,trackerPresets:[{id:"preset-a",name:"My View",is_default:true}],trackerFormRevision:1},Date.parse("2026-09-23T14:00:00Z"));
  const html=document.ids.get("page").innerHTML;
  assert.match(html,/My View · Default · Modified/);assert.match(html,/data-action="update-tracking-view"/);assert.match(html,/currentEfficiencyHigh/);
  const app=read("screener/app.js");assert.match(app,/markTrackingViewChanged\(\)/);assert.match(app,/is_default:update&&current\?current\.is_default:false/);
});
