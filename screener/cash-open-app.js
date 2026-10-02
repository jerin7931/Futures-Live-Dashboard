import {CONFIG} from "../config.js?v=3.0.27-cutover";
import {href,route} from "./cash-open-core.js?v=6.4.0";
import {renderPage} from "./ai-workspace-view.js?v=6.4.0";
import {capturePageState,createUIState,restorePageState} from "./ui-state.js?v=6.4.0";

const $=id=>document.getElementById(id);
const client=window.supabase.createClient(CONFIG.supabaseUrl,CONFIG.supabasePublishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
const ui=createUIState(route(location.hash||href("home")));
ui.optionsSymbol=["SPY","QQQ","IWM"].includes(ui.optionsSymbol)?ui.optionsSymbol:"SPY";
let authorized=false,userId=null,timer=null,busy=false;
let model={gamma:[],gammaState:"READY"};

function clear(message=""){authorized=false;userId=null;clearTimeout(timer);$("auth").hidden=false;$("dashboard").hidden=true;$("authError").textContent=message;}
function currentRoute(){const next=route(location.hash);if(next.redirect){location.hash=href("home",next.demo);return false;}ui.page=next.page;ui.demo=next.demo;return true;}
function draw(){
  if(!authorized)return;
  capturePageState($("page"),ui);
  $("pageTitle").textContent=ui.page==="options-analysis"?"Options Analysis":"Three-Bot Status";
  $("pageEyebrow").textContent="SPY / QQQ / IWM · READ ONLY";
  $("demoBanner").hidden=true;$("modeBadge").textContent="RUNTIMES OFF";$("dashboard").querySelector(".brand").href=href("home");
  for(const link of document.querySelectorAll("#primaryNav a")){link.href=href(link.dataset.route);link.classList.toggle("active",link.dataset.route===ui.page);link.setAttribute("aria-current",link.dataset.route===ui.page?"page":"false");}
  $("page").innerHTML=renderPage(model,ui);restorePageState($("page"),ui);
}
async function gamma(){const {data,error}=await client.from("fos_options_analysis_current").select("symbol,session_date,updated_at,source_as_of,status,spot,payload").eq("owner_id",userId).in("symbol",["SPY","QQQ","IWM"]);if(error)throw new Error("GAMMA_READ_FAILED");return data||[];}
async function refresh(){if(!authorized||busy)return;busy=true;try{model={...model,gamma:await gamma(),gammaState:"READY"};$("connection").textContent="Connected · Supabase read only";const stamps=model.gamma.map(row=>Date.parse(row.source_as_of)).filter(Number.isFinite);$("snapshotTime").textContent=stamps.length?new Date(Math.max(...stamps)).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",timeZone:"America/Chicago"}):"Awaiting source data";draw();}catch{$("connection").textContent="Source unavailable · retaining last rendered state";model.gammaState="UNAVAILABLE";draw();}finally{busy=false;clearTimeout(timer);if(authorized)timer=setTimeout(refresh,15000);}}
async function authorize(session){if(!session?.user){clear();return;}const {data:reader,error}=await client.from("dashboard_readers").select("user_id").eq("user_id",session.user.id).maybeSingle();if(error||!reader){clear("This account is not authorized for the private dashboard.");return;}authorized=true;userId=session.user.id;$("auth").hidden=true;$("dashboard").hidden=false;currentRoute();await refresh();}

$("login").addEventListener("submit",async event=>{event.preventDefault();const fields=new FormData(event.target);const {data,error}=await client.auth.signInWithPassword({email:fields.get("email"),password:fields.get("password")});if(error)$("authError").textContent="Sign-in failed. Check your credentials.";else await authorize(data.session);});
$("signOut").addEventListener("click",async()=>{clear();await client.auth.signOut();});
$("page").addEventListener("click",event=>{const target=event.target.closest("[data-action]");if(!target)return;if(target.dataset.action==="select-options-symbol")ui.optionsSymbol=target.dataset.symbol;else if(target.dataset.action==="gamma-zoom"&&["TIGHT","NEAR","WIDE","ALL"].includes(target.dataset.zoom))ui.optionsZoom=target.dataset.zoom;draw();});
window.addEventListener("hashchange",()=>{if(currentRoute())refresh();});document.addEventListener("visibilitychange",()=>{if(!document.hidden&&authorized)refresh();});client.auth.onAuthStateChange(event=>{if(event==="SIGNED_OUT")clear();});if(!location.hash)location.hash=href("home");await authorize((await client.auth.getSession()).data.session);
