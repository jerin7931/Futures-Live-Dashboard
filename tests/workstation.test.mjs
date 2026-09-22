import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {buildDemoData} from "../screener/demo-data.js";
import {parseRoute,routeHref,defaultFilters,filterOpportunities,paginate,availableIndustries,filterNews,dashboardStatus,normalizedLive} from "../screener/dashboard-core.js";
import {renderWorkstation} from "../screener/workstation-view.js";

const now=Date.now(),demo=buildDemoData(now);
const base=()=>({...defaultFilters(),pageSize:50});
const fakeDocument=()=>{
  const ids=new Map(["pageEyebrow","pageTitle","demoBanner","modeBadge","snapshotTime","connection","page"].map(id=>[id,{id,textContent:"",innerHTML:"",hidden:false}]));
  const links=["home","opportunities","market","sectors","news","watchlist"].map(route=>({dataset:{route},href:"",classList:{active:false,toggle(_name,value){this.active=value;}}}));
  return {ids,links,getElementById(id){return ids.get(id);},querySelectorAll(selector){return selector==="[data-route]"?links:[];}};
};

test("demo contract is rich, deterministic, isolated, and covers required semantics",()=>{
  assert.equal(demo.schema_version,"FOS_LIVE_DASHBOARD_1");assert.ok(demo.opportunities.length>=24);
  assert.deepEqual(new Set(demo.opportunities.map(row=>row.v1_state)),new Set(["CONFIRMED","CONFIRMING","EMERGING","DEGRADING","NO_TREND","REVERSED"]));
  assert.ok(demo.opportunities.some(row=>row.v1_direction==="LONG"));assert.ok(demo.opportunities.some(row=>row.v1_direction==="SHORT"));assert.ok(demo.opportunities.some(row=>row.asset_type==="ETF"));
  assert.equal(demo.opportunities.find(row=>row.v1_state==="NO_TREND").v1_direction,null);
  assert.ok(demo.opportunities.find(row=>row.v1_state==="REVERSED").reversed_from);
  assert.equal(demo.opportunities.find(row=>row.symbol==="QQQ").market_relative,null);
  assert.deepEqual(demo.market.map(row=>row.symbol),["SPY","QQQ","IWM","VIX","US10Y","US2Y","DXY","WTI"]);
  assert.equal(demo.production_activation,null);assert.equal(demo.brokerage_execution,false);assert.equal(demo.options_requests_enabled,false);
});

test("hash routing supports every page and isolated demo refreshes",()=>{
  assert.deepEqual(parseRoute("#/demo"),{demo:true,page:"home"});assert.deepEqual(parseRoute("#/demo/news"),{demo:true,page:"news"});
  assert.deepEqual(parseRoute("#/market"),{demo:false,page:"market"});assert.deepEqual(parseRoute("#/missing"),{demo:false,page:"home"});
  assert.equal(routeHref("watchlist",true),"#/demo/watchlist");
});

test("combined opportunity filters, search, sorting, counts, and pagination are functional",()=>{
  const cases=[
    [{...base(),states:["CONFIRMED"],directions:["LONG"]},row=>row.v1_state==="CONFIRMED"&&row.v1_direction==="LONG"],
    [{...base(),states:["CONFIRMED"],directions:["SHORT"]},row=>row.v1_state==="CONFIRMED"&&row.v1_direction==="SHORT"],
    [{...base(),sector:"Technology",asset:"STOCK"},row=>row.sector==="Technology"&&row.asset_type==="STOCK"],
    [{...base(),asset:"ETF",states:["EMERGING"]},row=>row.asset_type==="ETF"&&row.v1_state==="EMERGING"],
    [{...base(),industry:"Semiconductors",states:["CONFIRMING"]},row=>row.industry==="Semiconductors"&&row.v1_state==="CONFIRMING"],
    [{...base(),catalyst:"NONE"},row=>row.news.length===0],
    [{...base(),query:"amd"},row=>row.symbol==="AMD"],
  ];
  for(const [filters,predicate] of cases){const rows=filterOpportunities(demo.opportunities,filters);assert.ok(rows.length,JSON.stringify(filters));assert.ok(rows.every(predicate));}
  const watched=new Set(["AMD","META"]);const watchedLong=filterOpportunities(demo.opportunities,{...base(),watchlistOnly:true,directions:["LONG"]},watched);assert.ok(watchedLong.every(row=>watched.has(row.symbol)&&row.v1_direction==="LONG"));
  const first=filterOpportunities(demo.opportunities,{...base(),sort:"symbol"});assert.equal(first[0].symbol,"AAPL");
  const volumeRows=[{symbol:"NULL",session_volume:null},{symbol:"LOW",session_volume:100},{symbol:"HIGH",session_volume:900}];
  assert.deepEqual(filterOpportunities(volumeRows,{...base(),sort:"volume"}).map(row=>row.symbol),["HIGH","LOW","NULL"]);
  const page=paginate(first,2,7);assert.equal(page.rows.length,7);assert.equal(page.total,30);assert.equal(page.page,2);
  assert.ok(availableIndustries(demo.opportunities,"Technology").includes("Semiconductors"));
});

test("news uses causal first-seen ordering and independent filters",()=>{
  const first=filterNews(demo.news,{sort:"firstSeen"});for(let i=1;i<first.length;i++)assert.ok(Date.parse(first[i-1].first_seen_at)>=Date.parse(first[i].first_seen_at));
  const company=filterNews(demo.news,{scope:"COMPANY",symbol:"AMD"});assert.ok(company.length);assert.ok(company.every(row=>row.scope==="COMPANY"&&row.symbols.includes("AMD")));
  const published=filterNews(demo.news,{sort:"published"});for(let i=1;i<published.length;i++)assert.ok(Date.parse(published[i-1].publication_at)>=Date.parse(published[i].publication_at));
});

test("all six renderers share one view model and escape provider text",()=>{
  let homeHtml="";
  for(const page of ["home","opportunities","market","sectors","news","watchlist"]){const doc=fakeDocument();const model=structuredClone(demo);model.opportunities[0].company_name='<img src=x onerror="boom">';renderWorkstation(doc,model,{page,demo:true,selectedSymbol:"AMD",watchlist:new Set(["AMD"]),filters:base(),newsFilters:{scope:"ALL",category:"ALL",symbol:"",sector:"ALL",range:"ALL",sort:"firstSeen"},groupSelection:null},now);const html=doc.ids.get("page").innerHTML;assert.ok(html.length>100,page);assert.doesNotMatch(html,/<img src=x/);if(page==="home")homeHtml=html;}
  assert.match(homeHtml,/&lt;img src=x/);
});

test("status and live adapter fail closed",()=>{
  assert.equal(normalizedLive({dashboard:demo}),demo);assert.equal(normalizedLive({dashboard:{schema_version:"wrong"}}),null);assert.equal(normalizedLive(null),null);
  assert.equal(dashboardStatus(demo,now).state,"LIVE");assert.equal(dashboardStatus({...demo,as_of:new Date(now-200000).toISOString()},now).state,"STALE");assert.equal(dashboardStatus(null,now).state,"UNAVAILABLE");
});

test("stale macro freshness overrides an older provider delayed flag",()=>{
  const doc=fakeDocument(),model=structuredClone(demo),wti=model.market.find(row=>row.symbol==="WTI");
  wti.delayed=true;wti.freshness={state:"STALE",age_seconds:600};
  renderWorkstation(doc,model,{page:"market",demo:true,selectedSymbol:null,watchlist:new Set(),filters:base(),newsFilters:{scope:"ALL",category:"ALL",symbol:"",sector:"ALL",range:"ALL",sort:"firstSeen"},groupSelection:null},now);
  const wtiSection=doc.ids.get("page").innerHTML.split("WTI Crude")[1].slice(0,500);
  assert.match(wtiSection,/STALE/);assert.doesNotMatch(wtiSection,/DELAYED/);
});

test("soft-light theme and pastel state/direction classes are shared by live and demo",()=>{
  const css=readFileSync(new URL("../screener/styles.css",import.meta.url),"utf8");
  for(const token of ["#eef3f8","#f8fafc","#ffffff","#12263a","#c8d5e2","#edf9f4","#fff1f4","#e8f8f0","#f1eeff","#eaf3ff","#fff7e8","#fff0f3"]){assert.ok(css.includes(token),token);}
  assert.match(css,/\.badge\.state-confirmed\{/);assert.match(css,/\.badge\.state-emerging\{/);assert.match(css,/\.badge\.state-confirming\{/);assert.match(css,/\.badge\.state-no-trend\{/);assert.match(css,/\.badge\.state-degrading\{/);assert.match(css,/\.badge\.state-reversed\{/);
  const doc=fakeDocument();renderWorkstation(doc,demo,{page:"opportunities",demo:true,selectedSymbol:null,watchlist:new Set(),filters:base(),newsFilters:{scope:"ALL",category:"ALL",symbol:"",sector:"ALL",range:"ALL",sort:"firstSeen"},groupSelection:null},now);
  const html=doc.ids.get("page").innerHTML;
  assert.match(html,/badge positive direction-long/);assert.match(html,/badge negative direction-short/);
  for(const state of ["confirmed","confirming","emerging","degrading","no-trend","reversed"]){assert.match(html,new RegExp(`state-${state}`));}
});
