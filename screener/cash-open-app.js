import {CONFIG} from "../config.js?v=3.0.27-cutover";
import {href,route} from "./cash-open-core.js?v=6.4.0";
import {renderPage} from "./ai-workspace-view.js?v=6.5.3";
import {renderReversalDetail} from "./option-reversal-view.js?v=6.5.3";
import {capturePageState,createUIState,restorePageState} from "./ui-state.js?v=6.4.0";

const $=id=>document.getElementById(id);
const client=window.supabase.createClient(CONFIG.supabaseUrl,CONFIG.supabasePublishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
const ui=createUIState(route(location.hash||href("home")));
ui.optionsSymbol=["SPY","QQQ","IWM"].includes(ui.optionsSymbol)?ui.optionsSymbol:"SPY";
let authorized=false,userId=null,timer=null,busy=false,reversalChannel=null;
let model={gamma:[],gammaState:"READY",reversal:[],reversalState:"READY"};

function clear(message=""){authorized=false;userId=null;clearTimeout(timer);if(reversalChannel){client.removeChannel(reversalChannel);reversalChannel=null;}$("auth").hidden=false;$("dashboard").hidden=true;$("authError").textContent=message;}
function currentRoute(){const next=route(location.hash);if(next.redirect){location.hash=href("home",next.demo);return false;}ui.page=next.page;ui.demo=next.demo;return true;}
function draw(){
  if(!authorized)return;
  capturePageState($("page"),ui);
  $("pageTitle").textContent=ui.page==="options-analysis"?"Gamma Analysis":"Option Reversal Monitor";
  $("pageEyebrow").textContent="SPY / QQQ / IWM · VOLATILITY SURFACE";
  $("demoBanner").hidden=true;$("modeBadge").textContent="READ ONLY";$("dashboard").querySelector(".brand").href=href("home");
  for(const link of document.querySelectorAll("#primaryNav a")){link.href=href(link.dataset.route);link.classList.toggle("active",link.dataset.route===ui.page);link.setAttribute("aria-current",link.dataset.route===ui.page?"page":"false");}
  $("page").innerHTML=renderPage(model,ui);restorePageState($("page"),ui);
}
async function gamma(){const {data,error}=await client.from("fos_options_analysis_current").select("symbol,session_date,updated_at,source_as_of,status,spot,payload").eq("owner_id",userId).in("symbol",["SPY","QQQ","IWM"]);if(error)throw new Error("GAMMA_READ_FAILED");return data||[];}
async function reversal(){const {data,error}=await client.from("fos_option_reversal_current").select("*").eq("owner_id",userId).in("symbol",["SPY","QQQ","IWM"]).order("direction").order("symbol");if(error)throw new Error("REVERSAL_READ_FAILED");return data||[];}
async function refresh(){if(!authorized||busy)return;busy=true;try{const [gammaResult,reversalResult]=await Promise.allSettled([gamma(),reversal()]);if(gammaResult.status==="fulfilled")model={...model,gamma:gammaResult.value,gammaState:"READY"};else model.gammaState="UNAVAILABLE";if(reversalResult.status==="fulfilled")model={...model,reversal:reversalResult.value,reversalState:"READY"};else model.reversalState="UNAVAILABLE";const available=gammaResult.status==="fulfilled"||reversalResult.status==="fulfilled";$("connection").textContent=available?"Connected · Supabase read only":"Source unavailable · retaining last rendered state";const stamps=[...model.reversal.map(row=>Date.parse(row.surface_ts||row.updated_at)),...model.gamma.map(row=>Date.parse(row.source_as_of))].filter(Number.isFinite);$("snapshotTime").textContent=stamps.length?new Date(Math.max(...stamps)).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",timeZone:"America/Chicago"}):"Awaiting source data";draw();}finally{busy=false;clearTimeout(timer);if(authorized)timer=setTimeout(refresh,15000);}}
function subscribeReversal(){if(reversalChannel)client.removeChannel(reversalChannel);reversalChannel=client.channel("option-reversal-current-"+userId).on("postgres_changes",{event:"*",schema:"public",table:"fos_option_reversal_current",filter:"owner_id=eq."+userId},()=>refresh()).subscribe();}
async function authorize(session){if(!session?.user){clear();return;}const {data:reader,error}=await client.from("dashboard_readers").select("user_id").eq("user_id",session.user.id).maybeSingle();if(error||!reader){clear("This account is not authorized for the private dashboard.");return;}authorized=true;userId=session.user.id;$("auth").hidden=true;$("dashboard").hidden=false;currentRoute();subscribeReversal();await refresh();}

$("login").addEventListener("submit",async event=>{event.preventDefault();const fields=new FormData(event.target);const {data,error}=await client.auth.signInWithPassword({email:fields.get("email"),password:fields.get("password")});if(error)$("authError").textContent="Sign-in failed. Check your credentials.";else await authorize(data.session);});
$("signOut").addEventListener("click",async()=>{clear();await client.auth.signOut();});
$("page").addEventListener("click",event=>{const target=event.target.closest("[data-action]");if(!target)return;if(target.dataset.action==="select-options-symbol")ui.optionsSymbol=target.dataset.symbol;else if(target.dataset.action==="gamma-zoom"&&["TIGHT","NEAR","WIDE","ALL"].includes(target.dataset.zoom))ui.optionsZoom=target.dataset.zoom;else if(target.dataset.action==="open-reversal-detail"){const row=model.reversal.find(item=>item.symbol===target.dataset.symbol&&item.direction===target.dataset.direction);$("detailDialog").innerHTML=renderReversalDetail(row);$("detailOverlay").hidden=false;}draw();});
$("detailOverlay").addEventListener("click",event=>{if(event.target===$("detailOverlay")||event.target.closest('[data-action="close-reversal-detail"]'))$("detailOverlay").hidden=true;});
document.addEventListener("keydown",event=>{if(event.key==="Escape")$("detailOverlay").hidden=true;});
window.addEventListener("hashchange",()=>{if(currentRoute())refresh();});document.addEventListener("visibilitychange",()=>{if(!document.hidden&&authorized)refresh();});client.auth.onAuthStateChange(event=>{if(event==="SIGNED_OUT")clear();});if(!location.hash)location.hash=href("home");await authorize((await client.auth.getSession()).data.session);
