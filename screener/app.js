import {CONFIG} from "../config.js";
import {buildDemoData} from "./demo-data.js?v=3.0.15";
import {availableIndustries,defaultFilters,normalizedLive,parseRoute,selectOpportunity} from "./dashboard-core.js?v=3.0.15";
import {renderWorkstation,renderDetail} from "./workstation-view.js?v=3.0.21";
import {defaultTrackerFilters,resolveTrackerHistory,rememberTrackerOptionQuality} from "./tracking-core.js?v=3.0.21";

const $=id=>document.getElementById(id);
const client=window.supabase.createClient(CONFIG.supabaseUrl,CONFIG.supabasePublishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
const initialWall=Date.now(),initialMono=performance.now();
const now=()=>initialWall+performance.now()-initialMono;
function storedFilters(){try{const value=JSON.parse(sessionStorage.getItem("fos-radar-filters-v1")||"null");return value&&typeof value==="object"?{...defaultFilters(),...value,directions:Array.isArray(value.directions)?value.directions:[],states:Array.isArray(value.states)?value.states:[]}:defaultFilters();}catch{return defaultFilters();}}
function saveFilters(){sessionStorage.setItem("fos-radar-filters-v1",JSON.stringify(ui.filters));}
const ui={page:"home",demo:false,selectedSymbol:null,watchlist:new Set(),filters:storedFilters(),trackerFilters:defaultTrackerFilters(),newsFilters:{scope:"ALL",category:"ALL",symbol:"",sector:"ALL",range:"ALL",sort:"firstSeen"},groupSelection:null};
let authorized=false,userId=null,model=null,payload=null,poll=null,busy=false,refreshAgain=false,lastSequence=-1,lastStream=null,watchlistAvailable=true;
let trackerHistoryCache=null;
let trackerOptionQualityCache=null;

function demoWatchlist(){try{return new Set(JSON.parse(localStorage.getItem("fos-demo-watchlist-v1")||"[]"));}catch{return new Set();}}
function saveDemoWatchlist(){localStorage.setItem("fos-demo-watchlist-v1",JSON.stringify([...ui.watchlist].sort()));}
function currentRoute(){const route=parseRoute(location.hash);ui.page=route.page;ui.demo=route.demo;return route;}
function draw(){const started=performance.now();renderWorkstation(document,model,ui,now());document.documentElement.dataset.renderMs=(performance.now()-started).toFixed(2);}

function clear(message=""){
  authorized=false;userId=null;model=null;payload=null;lastSequence=-1;lastStream=null;
  trackerHistoryCache=null;trackerOptionQualityCache=null;clearTimeout(poll);
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
  // Security-invoker view over owner-RLS append-only history: one latest row
  // per lifecycle, including terminal generations. No provider/browser write.
  const all=[];
  for(let page=0;page<20;page++){
    const response=await client.from("fos_tracker_current")
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
      if(ui.page==="tracking"&&model){
        const day=model?.market_session?.date;
        const history=resolveTrackerHistory(trackerHistoryCache,await loadTrackerHistory(day),{ownerId:userId,day});
        trackerHistoryCache=history.cache;
        model.tracked_lifecycles=history.rows;
        model.tracker_history_state=history.state;
        trackerOptionQualityCache=rememberTrackerOptionQuality(trackerOptionQualityCache,model,{ownerId:userId,day});
        model.tracker_option_quality_memory=trackerOptionQualityCache.values;
        const analysis=await loadAiAnalysis(model.tracked_lifecycles);
        model.ai_analysis_by_tracker_id=analysis.rows;
        model.ai_analysis_state=analysis.state;
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
  authorized=true;userId=session.user.id;$("auth").hidden=true;$("dashboard").hidden=false;currentRoute();await refresh();
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
function readTrackerFilters(form){const data=new FormData(form),f=defaultTrackerFilters();for(const key of Object.keys(f))f[key]=key==="nonterminalOnly"?data.has(key):String(data.get(key)||f[key]);ui.trackerFilters=f;}

$("login").addEventListener("submit",async event=>{event.preventDefault();const fields=new FormData(event.target);const {data:result,error}=await client.auth.signInWithPassword({email:fields.get("email"),password:fields.get("password")});if(error)$("authError").textContent="Sign-in failed. Check your credentials.";else await authorize(result.session);});
$("signOut").addEventListener("click",async()=>{clear();await client.auth.signOut();});
$("page").addEventListener("click",async event=>{
  const target=event.target.closest("[data-action]");if(!target)return;const action=target.dataset.action;
  if(action==="select"){ui.selectedSymbol=target.dataset.symbol;if(ui.page==="home")draw();else renderDetail(document,selectOpportunity(model,ui.selectedSymbol),model);}
  else if(action==="watch")await toggleWatch(target.dataset.symbol);
  else if(action==="clear-filters"){ui.filters=defaultFilters();saveFilters();draw();}
  else if(action==="clear-tracking-filters"){ui.trackerFilters=defaultTrackerFilters();draw();}
  else if(action==="page"){ui.filters.page=Number(target.dataset.page)||1;draw();}
  else if(action==="group"){ui.groupSelection={type:target.dataset.groupType,name:target.dataset.group};draw();}
  else if(action==="clear-group"){ui.groupSelection=null;draw();}
});
$("page").addEventListener("change",event=>{if(event.target.closest("#radarFilters")){readRadarFilters($("radarFilters"));draw();}else if(event.target.closest("#trackingFilters")){readTrackerFilters($("trackingFilters"));draw();}else if(event.target.closest("#newsFilters")){readNewsFilters($("newsFilters"));draw();}});
$("page").addEventListener("input",event=>{if(event.target.name==="query"&&event.target.closest("#radarFilters")){readRadarFilters($("radarFilters"));draw();}else if(event.target.name==="query"&&event.target.closest("#trackingFilters")){readTrackerFilters($("trackingFilters"));draw();}else if(event.target.name==="symbol"&&event.target.closest("#newsFilters")){readNewsFilters($("newsFilters"));draw();}});
$("page").addEventListener("submit",async event=>{if(event.target.id!=="watchlistAdd")return;event.preventDefault();const symbol=String(new FormData(event.target).get("symbol")||"");if(symbol)await toggleWatch(symbol);});
$("detailOverlay").addEventListener("click",event=>{if(event.target===$("detailOverlay")||event.target.closest('[data-action="close-detail"]'))renderDetail(document,null);});
document.addEventListener("keydown",event=>{if(event.key==="Escape")renderDetail(document,null);});
window.addEventListener("hashchange",async()=>{const priorDemo=ui.demo;currentRoute();renderDetail(document,null);if(priorDemo!==ui.demo||ui.page==="tracking")await refresh();else draw();});
document.addEventListener("visibilitychange",()=>{if(!document.hidden&&authorized)refresh();});
client.auth.onAuthStateChange(event=>{if(event==="SIGNED_OUT")clear();});
if(!location.hash)location.hash="#/home";
await authorize((await client.auth.getSession()).data.session);
