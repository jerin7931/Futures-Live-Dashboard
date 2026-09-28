import {CONFIG} from "../config.js?v=3.0.27-cutover";
import {href,newYorkDate,route} from "./cash-open-core.js?v=5.0.0";
import {strictZeroDte} from "./option-chain-core.js?v=5.0.0";
import {renderPage} from "./lppc-view.js?v=5.0.0";

const $=id=>document.getElementById(id);
const client=window.supabase.createClient(CONFIG.supabaseUrl,CONFIG.supabasePublishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
const ui={...route(location.hash),newsQuery:"",optionsSymbol:"SPX",optionsZoom:"NEAR",efficiencyTimeframes:{SPX:"M1",QQQ:"M1",IWM:"M1",SPY:"M1"},chainFilters:{security:"ALL",right:"ALL",askMin:"",askMax:"",sort:"near-spot",direction:"asc"}};
let authorized=false,userId=null,timer=null,busy=false;
let model={lppc:[],efficiency:[],eventHistory:[],gamma:[],news:null,chainPointers:[],optionChain:[],gammaState:"READY"};

function clear(message=""){authorized=false;userId=null;clearTimeout(timer);$("auth").hidden=false;$("dashboard").hidden=true;$("authError").textContent=message;}
function currentRoute(){const next=route(location.hash);if(next.redirect){location.hash=href("home",next.demo);return false;}ui.page=next.page;ui.demo=next.demo;return true;}
function draw(){
  if(!authorized)return;
  const focus=document.activeElement,focused=focus?.closest("#page")?focus:null,name=focused?.name,selection=focused&&typeof focused.selectionStart==="number"?[focused.selectionStart,focused.selectionEnd]:null,scroll=window.scrollY;
  $("pageTitle").textContent={home:"Home",news:"News & Catalysts","options-analysis":"Options Analysis","option-chain":"Option Chain"}[ui.page];
  $("pageEyebrow").textContent="LPPC PRODUCTION · READ ONLY";$("demoBanner").hidden=true;$("modeBadge").textContent="READ ONLY";$("dashboard").querySelector(".brand").href=href("home");
  for(const link of document.querySelectorAll("#primaryNav a")){link.href=href(link.dataset.route);link.classList.toggle("active",link.dataset.route===ui.page);link.setAttribute("aria-current",link.dataset.route===ui.page?"page":"false");}
  $("page").innerHTML=renderPage(model,ui);
  if(name){const replacement=[...$("page").querySelectorAll("[name]")].find(item=>item.name===name);if(replacement){replacement.focus({preventScroll:true});if(selection&&replacement.setSelectionRange)replacement.setSelectionRange(...selection);}}
  if(window.scrollY!==scroll)window.scrollTo({top:scroll,behavior:"instant"});
}
async function rows(table,columns,day,order=null,limit=5000){let query=client.from(table).select(columns).eq("owner_id",userId).eq("session_date",day).limit(limit);if(order)query=query.order(order);const {data,error}=await query;if(error)throw new Error(`${table}_READ_FAILED`);return data||[];}
async function gamma(day){const {data,error}=await client.from("fos_options_analysis_current").select("symbol,session_date,updated_at,source_as_of,status,spot,payload").eq("owner_id",userId).eq("session_date",day).in("symbol",["SPX","SPY","QQQ","IWM"]);if(error)throw new Error("GAMMA_READ_FAILED");return data||[];}
async function chain(day){
  const pointers=await rows("fos_option_chain_generation_current","underlying,session_date,expiration_date,generation_id,row_count,status,source_as_of,updated_at",day);
  const ids=pointers.filter(row=>row.row_count>0&&row.expiration_date===day).map(row=>row.generation_id);if(!ids.length)return {pointers,contracts:[]};
  const {data,error}=await client.from("fos_option_chain_current").select("*").eq("owner_id",userId).eq("session_date",day).in("generation_id",ids).limit(5000);if(error)throw new Error("OPTION_CHAIN_READ_FAILED");
  const allowed=new Map(pointers.map(row=>[row.underlying,row.generation_id]));const atomic=(data||[]).filter(row=>allowed.get(row.underlying)===row.generation_id);return {pointers,contracts:strictZeroDte(atomic,day)};
}
async function refresh(){
  if(!authorized||busy)return;busy=true;
  try{
    const day=newYorkDate();
    if(ui.page==="home"){
      const [lppc,efficiency,eventHistory,gammaRows]=await Promise.all([rows("fos_lppc_state_current","*",day),rows("fos_lppc_efficiency_current","symbol,session_date,timeframe,observation_at,efficiency,source_status,generation_id,updated_at",day,"observation_at"),rows("fos_lppc_event_history","symbol,session_date,recorded_at,transition,event_state,telegram_event_type,telegram_delivery_status,payload",day,"recorded_at"),gamma(day)]);
      model={...model,lppc,efficiency,eventHistory,gamma:gammaRows,gammaState:"READY"};
    }else if(ui.page==="options-analysis")model={...model,gamma:await gamma(day),gammaState:"READY"};
    else if(ui.page==="option-chain"){const result=await chain(day);model={...model,chainPointers:result.pointers,optionChain:result.contracts};}
    else if(ui.page==="news"){const current=await rows("fos_market_news_current","session_date,source_as_of,updated_at,payload",day,null,1);model={...model,news:current[0]?.payload||null};}
    $("connection").textContent="Connected · Supabase read only";const stamps=model.lppc.map(row=>Date.parse(row.updated_at)).filter(Number.isFinite);$("snapshotTime").textContent=stamps.length?new Date(Math.max(...stamps)).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",timeZone:"America/Chicago"}):"Awaiting current session";draw();
  }catch{$("connection").textContent="Source unavailable · retaining last rendered state";if(ui.page==="options-analysis")model.gammaState="UNAVAILABLE";draw();}
  finally{busy=false;clearTimeout(timer);if(authorized)timer=setTimeout(refresh,ui.page==="options-analysis"?15000:ui.page==="option-chain"?10000:5000);}
}
async function authorize(session){if(!session?.user){clear();return;}const {data:reader,error}=await client.from("dashboard_readers").select("user_id").eq("user_id",session.user.id).maybeSingle();if(error||!reader){clear("This account is not authorized for the private dashboard.");return;}authorized=true;userId=session.user.id;$("auth").hidden=true;$("dashboard").hidden=false;currentRoute();await refresh();}

$("login").addEventListener("submit",async event=>{event.preventDefault();const fields=new FormData(event.target);const {data,error}=await client.auth.signInWithPassword({email:fields.get("email"),password:fields.get("password")});if(error)$("authError").textContent="Sign-in failed. Check your credentials.";else await authorize(data.session);});
$("signOut").addEventListener("click",async()=>{clear();await client.auth.signOut();});
$("page").addEventListener("click",event=>{const target=event.target.closest("[data-action]");if(!target)return;if(target.dataset.action==="select-options-symbol")ui.optionsSymbol=target.dataset.symbol;else if(target.dataset.action==="gamma-zoom")ui.optionsZoom=target.dataset.zoom;else if(target.dataset.action==="eff-timeframe")ui.efficiencyTimeframes[target.dataset.symbol]=target.dataset.value;else if(target.dataset.action==="chain-security")ui.chainFilters.security=target.dataset.value;else if(target.dataset.action==="chain-right")ui.chainFilters.right=target.dataset.value;else if(target.dataset.action==="chain-premium-reset"){ui.chainFilters.askMin="";ui.chainFilters.askMax="";}else if(target.dataset.action==="chain-direction")ui.chainFilters.direction=ui.chainFilters.direction==="asc"?"desc":"asc";draw();});
$("page").addEventListener("input",event=>{if(event.target.name==="newsQuery")ui.newsQuery=event.target.value;if(event.target.name==="askMin"||event.target.name==="askMax")ui.chainFilters[event.target.name]=event.target.value;draw();});
$("page").addEventListener("change",event=>{if(event.target.name==="sort"){ui.chainFilters.sort=event.target.value;draw();}});$("page").addEventListener("click",event=>{const card=event.target.closest("[data-gamma-symbol]");if(card)ui.optionsSymbol=card.dataset.gammaSymbol;});
window.addEventListener("hashchange",()=>{if(currentRoute())refresh();});document.addEventListener("visibilitychange",()=>{if(!document.hidden&&authorized)refresh();});client.auth.onAuthStateChange(event=>{if(event==="SIGNED_OUT")clear();});if(!location.hash)location.hash="#/home";await authorize((await client.auth.getSession()).data.session);
