import {CONFIG} from "../config.js?v=3.0.27-cutover";
import {buildDemoData} from "./demo-data.js?v=3.0.15";
import {availableIndustries,defaultFilters,normalizedLive,parseRoute,selectOpportunity} from "./dashboard-core.js?v=3.0.31";
import {renderWorkstation,renderDetail} from "./workstation-view.js?v=3.0.36";
import {TRACKER_FIELDS,TRACKER_SORTS,defaultTrackerFilters,highQualityTrackerFilters,validTrackerRules,resolveTrackerHistory,rememberTrackerOptionQuality} from "./tracking-core.js?v=3.0.30";

const $=id=>document.getElementById(id);
const client=window.supabase.createClient(CONFIG.supabaseUrl,CONFIG.supabasePublishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
const initialWall=Date.now(),initialMono=performance.now();
const now=()=>initialWall+performance.now()-initialMono;
function storedFilters(){try{const value=JSON.parse(sessionStorage.getItem("fos-radar-filters-v1")||"null");return value&&typeof value==="object"?{...defaultFilters(),...value,directions:Array.isArray(value.directions)?value.directions:[],states:Array.isArray(value.states)?value.states:[]}:defaultFilters();}catch{return defaultFilters();}}
function saveFilters(){sessionStorage.setItem("fos-radar-filters-v1",JSON.stringify(ui.filters));}
const ui={page:"home",demo:false,selectedSymbol:null,optionsSymbol:"SPX",optionsZoom:"NEAR",optionsAnalysisRows:[],optionsAnalysisState:"UNAVAILABLE",watchlist:new Set(),filters:storedFilters(),trackerFilters:highQualityTrackerFilters(),selectedTrackingView:"builtin:high-quality",trackerPresets:[],trackerEditor:null,trackerPresetEditor:null,trackerPresetError:"",trackerViewDirty:false,trackerFormRevision:0,newsFilters:{scope:"ALL",category:"ALL",symbol:"",sector:"ALL",range:"ALL",sort:"firstSeen"},groupSelection:null};
let authorized=false,userId=null,model=null,payload=null,poll=null,busy=false,refreshAgain=false,lastSequence=-1,lastStream=null,watchlistAvailable=true;
let presetOwner=null;
let trackerHistoryCache=null;
let trackerOptionQualityCache=null;
let optionsPoll=null,optionsBusy=false;

function demoWatchlist(){try{return new Set(JSON.parse(localStorage.getItem("fos-demo-watchlist-v1")||"[]"));}catch{return new Set();}}
function saveDemoWatchlist(){localStorage.setItem("fos-demo-watchlist-v1",JSON.stringify([...ui.watchlist].sort()));}
function currentRoute(){const route=parseRoute(location.hash);ui.page=route.page;ui.demo=route.demo;return route;}
function draw(){const started=performance.now();renderWorkstation(document,model,ui,now());document.documentElement.dataset.renderMs=(performance.now()-started).toFixed(2);}

function clear(message=""){
  authorized=false;userId=null;model=null;payload=null;lastSequence=-1;lastStream=null;
  trackerHistoryCache=null;trackerOptionQualityCache=null;presetOwner=null;ui.trackerPresets=[];clearTimeout(poll);
  clearTimeout(optionsPoll);ui.optionsAnalysisRows=[];ui.optionsAnalysisState="UNAVAILABLE";
  $("auth").hidden=false;$("dashboard").hidden=true;$("authError").textContent=message;renderDetail(document,null);
}

async function loadWatchlist(){
  if(ui.demo){ui.watchlist=demoWatchlist();return;}
  const {data,error}=await client.from("fos_watchlist").select("symbol,pinned").eq("user_id",userId);
  watchlistAvailable=!error;ui.watchlist=new Set((data||[]).filter(row=>row.pinned!==false).map(row=>row.symbol));
  if(model&&!watchlistAvailable)model.watchlist_capacity={monitoring_enabled:false,capacity:0,message:"Private watchlist storage is unavailable; no symbol was silently persisted."};
}

async function loadTrackerHistory(day){
  if(!day)return {rows:[],state:"UNAVAILABLE"};
  // Physical owner-RLS current state: one row per lifecycle, including terminal
  // generations. No history scan or provider/browser write.
  const all=[];
  for(let page=0;page<20;page++){
    const response=await client.from("fos_tracker_current_state")
      .select("tracker_id,sequence,payload")
      .eq("owner_id",userId).eq("session_date",day)
      .not("payload->>alignment","is",null)
      .order("tracker_id",{ascending:true}).range(page*500,page*500+499);
    if(response.error)return {rows:[],state:"UNAVAILABLE"};
    const rows=response.data||[];all.push(...rows.map(row=>row.payload));
    if(rows.length<500)return {rows:all,state:"READY"};
  }
  return {rows:all,state:"INCOMPLETE_HISTORY"};
}

async function loadAiAnalysis(trackers){
  const ids=[...new Set(trackers.map(row=>row.id).filter(Boolean))];
  if(!ids.length)return {rows:{},state:"READY"};
  const byId={};
  for(let offset=0;offset<ids.length;offset+=100){
    const response=await client.from("fos_ai_analysis_current")
      .select("tracker_id,symbol,session_date,generated_at,source_as_of,analysis_status,analysis_summary,structure_read,levels_read,options_read,risks,watch_for,analysis_markdown")
      .eq("owner_id",userId).in("tracker_id",ids.slice(offset,offset+100));
    if(response.error)return {rows:{},state:"UNAVAILABLE"};
    for(const row of response.data||[])byId[row.tracker_id]=row;
  }
  return {rows:byId,state:"READY"};
}

async function loadTrackerLevels(trackers){
  const ids=[...new Set(trackers.map(row=>row.id).filter(Boolean))];
  if(!ids.length)return {rows:{},state:"READY"};
  const byId={};
  for(let offset=0;offset<ids.length;offset+=100){
    const response=await client.from("fos_tracker_levels_current")
      .select("tracker_id,generated_at,source_as_of,levels,status")
      .eq("owner_id",userId).in("tracker_id",ids.slice(offset,offset+100));
    if(response.error)return {rows:{},state:"UNAVAILABLE"};
    for(const row of response.data||[])byId[row.tracker_id]=row;
  }
  return {rows:byId,state:"READY"};
}

async function loadTrackingPresets(force=false){
  if(ui.demo||!authorized||!userId||(!force&&presetOwner===userId))return;
  const firstLoad=presetOwner!==userId;
  const {data,error}=await client.from("fos_filter_presets").select("id,name,filters,sort,is_default").eq("owner_id",userId).eq("page","tracking").order("name");
  if(!error){ui.trackerPresets=data||[];presetOwner=userId;if(firstLoad){const preferred=ui.trackerPresets.find(item=>item.is_default);if(preferred)applyTrackingView(preferred.id);}ui.trackerFormRevision++;if(ui.page==="tracking")draw();}
}
function applyTrackingView(value){
  if(value==="builtin:high-quality"){ui.trackerFilters=highQualityTrackerFilters();ui.selectedTrackingView=value;}
  else if(value==="custom"){ui.selectedTrackingView=value;}
  else{const preset=ui.trackerPresets.find(item=>item.id===value);if(!preset)return;
    ui.trackerFilters={...defaultTrackerFilters(),rules:validTrackerRules(preset.filters?.rules).map(rule=>({...rule})),sort:TRACKER_SORTS[preset.sort?.key]?preset.sort.key:"default"};ui.selectedTrackingView=value;}
  ui.trackerViewDirty=false;ui.trackerEditor=null;ui.trackerFormRevision++;draw();
}
function markTrackingViewChanged(){if(ui.trackerPresets.some(item=>item.id===ui.selectedTrackingView))ui.trackerViewDirty=true;else ui.selectedTrackingView="custom";}
function changeTrackerRules(rules){ui.trackerFilters={...ui.trackerFilters,rules:validTrackerRules(rules)};markTrackingViewChanged();ui.trackerEditor=null;ui.trackerFormRevision++;draw();}
async function saveTrackingView(name,update=false){
  if(ui.demo)return;
  const current=ui.trackerPresets.find(item=>item.id===ui.selectedTrackingView);
  if(!name?.trim())return;
  const row={owner_id:userId,page:"tracking",name:name.trim().slice(0,80),filters:{rules:validTrackerRules(ui.trackerFilters.rules)},sort:{key:ui.trackerFilters.sort},is_default:update&&current?current.is_default:false,updated_at:new Date().toISOString()};
  const query=update&&current?client.from("fos_filter_presets").update(row).eq("id",current.id).eq("owner_id",userId).select("id").single():client.from("fos_filter_presets").upsert(row,{onConflict:"owner_id,page,name"}).select("id").single();
  const {data,error}=await query;if(error){ui.trackerPresetError="View could not be saved.";ui.trackerFormRevision++;draw();return;}
  ui.selectedTrackingView=data.id;ui.trackerViewDirty=false;ui.trackerPresetEditor=null;ui.trackerPresetError="";await loadTrackingPresets(true);ui.trackerFormRevision++;draw();
}
async function deleteTrackingView(name){const current=ui.trackerPresets.find(item=>item.id===ui.selectedTrackingView);if(!current||name!==current.name)return;
  const {error}=await client.from("fos_filter_presets").delete().eq("id",current.id).eq("owner_id",userId);if(error){ui.trackerPresetError="View could not be deleted.";ui.trackerFormRevision++;draw();return;}
  ui.trackerPresetEditor=null;ui.trackerPresetError="";await loadTrackingPresets(true);applyTrackingView("builtin:high-quality");
}
async function setDefaultTrackingView(){const current=ui.trackerPresets.find(item=>item.id===ui.selectedTrackingView);if(!current)return;
  const cleared=await client.from("fos_filter_presets").update({is_default:false}).eq("owner_id",userId).eq("page","tracking").eq("is_default",true);
  if(cleared.error){ui.trackerPresetError="Default view could not be changed.";ui.trackerPresetEditor={mode:"update",name:current.name};ui.trackerFormRevision++;draw();return;}
  const chosen=await client.from("fos_filter_presets").update({is_default:true,updated_at:new Date().toISOString()}).eq("id",current.id).eq("owner_id",userId);
  if(chosen.error){ui.trackerPresetError="Default view could not be changed.";ui.trackerPresetEditor={mode:"update",name:current.name};ui.trackerFormRevision++;draw();return;}await loadTrackingPresets(true);
}

async function loadMarketBenchmarks(day){
  if(!day)return {rows:[],state:"UNAVAILABLE"};
  const response=await client.from("fos_benchmark_current")
    .select("symbol,session_date,updated_at,source_as_of,data_status,payload")
    .eq("owner_id",userId);
  if(response.error)return {rows:[],state:"UNAVAILABLE"};
  return {rows:(response.data||[]).filter(row=>row.session_date===day),state:"READY"};
}

async function loadOptionsAnalysis(){
  clearTimeout(optionsPoll);
  if(!authorized||ui.page!=="options-analysis")return;
  if(optionsBusy)return;
  optionsBusy=true;
  try{
    if(ui.demo){ui.optionsAnalysisRows=[];ui.optionsAnalysisState="READY";}
    else{
      const response=await client.from("fos_options_analysis_current")
        .select("symbol,session_date,updated_at,source_as_of,status,spot,payload")
        .eq("owner_id",userId).in("symbol",["SPX","SPY","QQQ","IWM"]);
      if(response.error)throw Error("OPTIONS_ANALYSIS_READ_FAILED");
      ui.optionsAnalysisRows=response.data||[];ui.optionsAnalysisState="READY";
    }
  }catch{ui.optionsAnalysisState="UNAVAILABLE";}
  finally{
    optionsBusy=false;
    if(authorized&&ui.page==="options-analysis"){
      draw();optionsPoll=setTimeout(loadOptionsAnalysis,15000);
    }
  }
}

async function refresh(){
  if(!authorized)return;
  if(busy){refreshAgain=true;return;}
  busy=true;currentRoute();
  try{
    if(ui.demo){model=buildDemoData(now());await loadWatchlist();}
    else{
      const {data:rows,error}=await client.from("fos_current").select("stream_id,sequence,payload").limit(1);
      if(error)throw Error("READ_FAILED");
      if(!authorized)return;
      if(rows.length){const row=rows[0];if(lastStream&&row.stream_id!==lastStream)throw Error("STREAM_CHANGED");if(row.sequence>=lastSequence){
        let symbolRows=[];
        if(row.payload?.dashboard?.schema_version==="FOS_LIVE_DASHBOARD_2"){
          const response=await client.from("fos_symbol_current").select("symbol,sequence,payload").eq("owner_id",userId).eq("stream_id",row.stream_id).lte("sequence",row.sequence);
          if(response.error)throw Error("SYMBOL_READ_FAILED");symbolRows=response.data||[];
        }
        lastSequence=row.sequence;lastStream=row.stream_id;payload=row.payload;model=normalizedLive(payload,symbolRows);
      }}
      if(["tracking","home"].includes(ui.page)&&model){
        const day=model?.market_session?.date;
        const benchmarks=await loadMarketBenchmarks(day);
        model.market_benchmarks=benchmarks.rows;
        model.market_benchmarks_state=benchmarks.state;
        const history=resolveTrackerHistory(trackerHistoryCache,await loadTrackerHistory(day),{ownerId:userId,day});
        trackerHistoryCache=history.cache;
        model.tracked_lifecycles=history.rows;
        model.tracker_history_state=history.state;
        trackerOptionQualityCache=rememberTrackerOptionQuality(trackerOptionQualityCache,model,{ownerId:userId,day});
        model.tracker_option_quality_memory=trackerOptionQualityCache.values;
        if(ui.page==="tracking"){
          const analysis=await loadAiAnalysis(model.tracked_lifecycles);
          model.ai_analysis_by_tracker_id=analysis.rows;model.ai_analysis_state=analysis.state;
        }
        const levels=await loadTrackerLevels(model.tracked_lifecycles);
        model.tracker_levels_by_tracker_id=levels.rows;model.tracker_levels_state=levels.state;
      }
      await loadWatchlist();
    }
  }catch{$("connection").textContent="Connection unavailable · stale evidence remains labeled";}
  finally{
    busy=false;
    if(refreshAgain){refreshAgain=false;return refresh();}
    if(authorized){draw();clearTimeout(poll);poll=setTimeout(refresh,ui.demo?30000:5000);}
  }
}

async function authorize(session){
  if(!session?.user)return clear();
  const {data:reader,error}=await client.from("dashboard_readers").select("user_id").eq("user_id",session.user.id).maybeSingle();
  if(error||!reader)return clear("This account is not authorized for the private dashboard.");
  authorized=true;userId=session.user.id;$("auth").hidden=true;$("dashboard").hidden=false;currentRoute();if(ui.page==="tracking")await loadTrackingPresets();await refresh();if(ui.page==="options-analysis")await loadOptionsAnalysis();
}

async function toggleWatch(symbol){
  if(!symbol)return;
  const adding=!ui.watchlist.has(symbol);
  if(ui.demo){adding?ui.watchlist.add(symbol):ui.watchlist.delete(symbol);saveDemoWatchlist();draw();return;}
  if(!watchlistAvailable)return;
  const response=adding?await client.from("fos_watchlist").upsert({user_id:userId,symbol,pinned:true},{onConflict:"user_id,symbol"}):await client.from("fos_watchlist").delete().eq("user_id",userId).eq("symbol",symbol);
  if(response.error){watchlistAvailable=false;if(model)model.watchlist_capacity={monitoring_enabled:false,capacity:0,message:"Private watchlist write failed closed; no local-only substitute was used."};draw();return;}
  adding?ui.watchlist.add(symbol):ui.watchlist.delete(symbol);draw();
}

function readRadarFilters(form){
  const data=new FormData(form),f={...ui.filters};f.query=String(data.get("query")||"");f.asset=String(data.get("asset")||"ALL");f.includeETFs=data.has("includeETFs");f.sector=String(data.get("sector")||"ALL");f.industry=String(data.get("industry")||"ALL");f.catalyst=String(data.get("catalyst")||"ALL");f.sensor=String(data.get("sensor")||"ALL");f.efficiency=String(data.get("efficiency")||"ALL");f.optionQuality=String(data.get("optionQuality")||"ALL");f.tracker=String(data.get("tracker")||"ALL");f.sort=String(data.get("sort")||"newest");f.directions=data.getAll("direction").map(String);f.states=data.getAll("state").map(String);f.watchlistOnly=data.has("watchlistOnly");f.freshOnly=data.has("freshOnly");f.page=1;
  if(f.industry!=="ALL"&&!availableIndustries(model?.opportunities||[],f.sector).includes(f.industry))f.industry="ALL";
  ui.filters=f;saveFilters();
}
function readNewsFilters(form){const data=new FormData(form);ui.newsFilters={scope:String(data.get("scope")||"ALL"),category:String(data.get("category")||"ALL"),symbol:String(data.get("symbol")||""),sector:String(data.get("sector")||"ALL"),range:String(data.get("range")||"ALL"),sort:String(data.get("sort")||"firstSeen")};}
function readTrackerFilters(form){ui.trackerFilters={...ui.trackerFilters,query:String(form.querySelector('[name="query"]')?.value||""),sort:String(form.querySelector('[name="sort"]')?.value||"default")};}
function rememberTrackerRuleDraft(target){
  if(!ui.trackerEditor||!["value","value2"].includes(target.name))return;
  // The five-second data refresh reconciles controls from this draft. Capture
  // edits without redrawing, so a select or partially typed number stays put.
  ui.trackerEditor={...ui.trackerEditor,[target.name]:target.value};
}
function rememberTrackingPresetDraft(target){
  if(!ui.trackerPresetEditor||target.name!=="name")return;
  // Keep the in-progress name through the five-second data reconciliation.
  ui.trackerPresetEditor={...ui.trackerPresetEditor,name:target.value};
}

$("login").addEventListener("submit",async event=>{event.preventDefault();const fields=new FormData(event.target);const {data:result,error}=await client.auth.signInWithPassword({email:fields.get("email"),password:fields.get("password")});if(error)$("authError").textContent="Sign-in failed. Check your credentials.";else await authorize(result.session);});
$("signOut").addEventListener("click",async()=>{clear();await client.auth.signOut();});
$("page").addEventListener("click",async event=>{
  const target=event.target.closest("[data-action]");if(!target)return;const action=target.dataset.action;
  if(action==="select"){ui.selectedSymbol=target.dataset.symbol;if(ui.page==="home")draw();else renderDetail(document,selectOpportunity(model,ui.selectedSymbol),model);}
  else if(action==="select-options-symbol"){ui.optionsSymbol=target.dataset.symbol;draw();}
  else if(action==="gamma-zoom"&&["TIGHT","NEAR","WIDE","ALL"].includes(target.dataset.zoom)){ui.optionsZoom=target.dataset.zoom;draw();}
  else if(action==="watch")await toggleWatch(target.dataset.symbol);
  else if(action==="clear-filters"){ui.filters=defaultFilters();saveFilters();draw();}
  else if(action==="clear-tracking-filters"){ui.trackerFilters=defaultTrackerFilters();markTrackingViewChanged();ui.trackerEditor=null;ui.trackerFormRevision++;draw();}
  else if(action==="add-tracker-rule"){ui.trackerEditor={field:"direction",operator:"is",value:"LONG",index:-1};ui.trackerFormRevision++;draw();}
  else if(action==="edit-tracker-rule"){const index=Number(target.dataset.index);ui.trackerEditor={...ui.trackerFilters.rules[index],index};ui.trackerFormRevision++;draw();}
  else if(action==="remove-tracker-rule"){changeTrackerRules(ui.trackerFilters.rules.filter((_,i)=>i!==Number(target.dataset.index)));}
  else if(action==="cancel-tracker-rule"){ui.trackerEditor=null;ui.trackerFormRevision++;draw();}
  else if(action==="save-tracking-view"){ui.trackerPresetEditor={mode:"save",name:""};ui.trackerPresetError="";ui.trackerFormRevision++;draw();}
  else if(action==="update-tracking-view"){const current=ui.trackerPresets.find(item=>item.id===ui.selectedTrackingView);if(current){ui.trackerPresetEditor={mode:"update",name:current.name};ui.trackerPresetError="";ui.trackerFormRevision++;draw();}}
  else if(action==="set-default-tracking-view")await setDefaultTrackingView();
  else if(action==="delete-tracking-view"){const current=ui.trackerPresets.find(item=>item.id===ui.selectedTrackingView);if(current){ui.trackerPresetEditor={mode:"delete",name:current.name};ui.trackerPresetError="";ui.trackerFormRevision++;draw();}}
  else if(action==="cancel-tracking-view"){ui.trackerPresetEditor=null;ui.trackerPresetError="";ui.trackerFormRevision++;draw();}
  else if(action==="high-quality-view"){applyTrackingView("builtin:high-quality");}
  else if(action==="page"){ui.filters.page=Number(target.dataset.page)||1;draw();}
  else if(action==="group"){ui.groupSelection={type:target.dataset.groupType,name:target.dataset.group};draw();}
  else if(action==="clear-group"){ui.groupSelection=null;draw();}
});
$("page").addEventListener("change",event=>{if(event.target.closest("#radarFilters")){readRadarFilters($("radarFilters"));draw();}else if(event.target.closest("#trackingRuleEditor")){if(["field","operator"].includes(event.target.name)){const data=new FormData($("trackingRuleEditor"));const field=String(data.get("field"));ui.trackerEditor={...ui.trackerEditor,field,operator:event.target.name==="field"?(TRACKER_FIELDS[field]?.numeric?">=":"is"):String(data.get("operator")),value:event.target.name==="field"?(TRACKER_FIELDS[field]?.numeric?"":TRACKER_FIELDS[field]?.values?.[0]||""):String(data.get("value")||""),value2:event.target.name==="field"?"":ui.trackerEditor?.value2};ui.trackerFormRevision++;draw();}else rememberTrackerRuleDraft(event.target);}else if(event.target.closest("#trackingPresetEditor")){rememberTrackingPresetDraft(event.target);}else if(event.target.closest("#trackingFilters")){if(event.target.name==="view")applyTrackingView(event.target.value);else{readTrackerFilters($("trackingFilters"));if(event.target.name==="sort"){markTrackingViewChanged();ui.trackerFormRevision++;}draw();}}else if(event.target.closest("#newsFilters")){readNewsFilters($("newsFilters"));draw();}});
$("page").addEventListener("input",event=>{if(event.target.closest("#trackingRuleEditor")){rememberTrackerRuleDraft(event.target);}else if(event.target.closest("#trackingPresetEditor")){rememberTrackingPresetDraft(event.target);}else if(event.target.name==="query"&&event.target.closest("#radarFilters")){readRadarFilters($("radarFilters"));draw();}else if(event.target.name==="query"&&event.target.closest("#trackingFilters")){readTrackerFilters($("trackingFilters"));draw();}else if(event.target.name==="symbol"&&event.target.closest("#newsFilters")){readNewsFilters($("newsFilters"));draw();}});
$("page").addEventListener("submit",async event=>{if(event.target.id==="trackingPresetEditor"){event.preventDefault();const name=String(new FormData(event.target).get("name")||"").trim();if(ui.trackerPresetEditor?.mode==="delete")await deleteTrackingView(name);else await saveTrackingView(name,ui.trackerPresetEditor?.mode==="update");return;}if(event.target.id==="trackingRuleEditor"){event.preventDefault();const data=new FormData(event.target),field=String(data.get("field")),meta=TRACKER_FIELDS[field];const rule={field,operator:String(data.get("operator")),value:meta?.boolean?data.get("value")==="true":meta?.numeric?Number(data.get("value")):String(data.get("value")||"")};if(rule.operator==="between")rule.value2=Number(data.get("value2"));const rules=[...ui.trackerFilters.rules];const index=ui.trackerEditor?.index??-1;if(index<0)rules.push(rule);else rules[index]=rule;changeTrackerRules(rules);return;}if(event.target.id!=="watchlistAdd")return;event.preventDefault();const symbol=String(new FormData(event.target).get("symbol")||"");if(symbol)await toggleWatch(symbol);});
$("detailOverlay").addEventListener("click",event=>{if(event.target===$("detailOverlay")||event.target.closest('[data-action="close-detail"]'))renderDetail(document,null);});
document.addEventListener("keydown",event=>{if(event.key==="Escape")renderDetail(document,null);});
window.addEventListener("hashchange",async()=>{const priorDemo=ui.demo;currentRoute();renderDetail(document,null);clearTimeout(optionsPoll);if(ui.page==="tracking")await loadTrackingPresets();if(priorDemo!==ui.demo||["tracking","home"].includes(ui.page))await refresh();else draw();if(ui.page==="options-analysis")await loadOptionsAnalysis();});
document.addEventListener("visibilitychange",()=>{if(!document.hidden&&authorized)refresh();});
client.auth.onAuthStateChange(event=>{if(event==="SIGNED_OUT")clear();});
if(!location.hash)location.hash="#/home";
await authorize((await client.auth.getSession()).data.session);
