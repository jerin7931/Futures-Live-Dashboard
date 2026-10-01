import {CONFIG} from "../config.js?v=3.0.27-cutover";
import {href,route} from "./cash-open-core.js?v=6.0.1";
import {renderPage} from "./ai-workspace-view.js?v=6.0.1";
import {capturePageState,createUIState,restorePageState} from "./ui-state.js?v=5.7.0";
import {buildTVG2,tradingViewGammaFeedback} from "./tradingview-gamma.js?v=5.9.0";

const $=id=>document.getElementById(id);
const client=window.supabase.createClient(CONFIG.supabaseUrl,CONFIG.supabasePublishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
const ui=createUIState(route(location.hash));
let authorized=false,userId=null,timer=null,busy=false;
let model={gamma:[],aiCurrent:[],aiHistory:[],gammaState:"READY"};

function clear(message=""){authorized=false;userId=null;clearTimeout(timer);$("auth").hidden=false;$("dashboard").hidden=true;$("authError").textContent=message;}
function currentRoute(){const next=route(location.hash);if(next.redirect){location.hash=href("home",next.demo);return false;}ui.page=next.page;ui.demo=next.demo;return true;}
function draw(){
  if(!authorized)return;
  capturePageState($("page"),ui);
  const focus=document.activeElement,focused=focus?.closest("#page")?focus:null,name=focused?.name,selection=focused&&typeof focused.selectionStart==="number"?[focused.selectionStart,focused.selectionEnd]:null,scroll=window.scrollY;
  $("pageTitle").textContent={home:"AI Analysis","options-analysis":"Options Analysis"}[ui.page];
  $("pageEyebrow").textContent="SPX / ES AI WORKSPACE · READ ONLY";$("demoBanner").hidden=true;$("modeBadge").textContent="READ ONLY";$("dashboard").querySelector(".brand").href=href("home");
  for(const link of document.querySelectorAll("#primaryNav a")){link.href=href(link.dataset.route);link.classList.toggle("active",link.dataset.route===ui.page);link.setAttribute("aria-current",link.dataset.route===ui.page?"page":"false");}
  $("page").innerHTML=renderPage(model,ui);
  restorePageState($("page"),ui);
  if(name){const replacement=[...$("page").querySelectorAll("[name]")].find(item=>item.name===name);if(replacement){replacement.focus({preventScroll:true});if(selection&&replacement.setSelectionRange)replacement.setSelectionRange(...selection);}}
  if(window.scrollY!==scroll)window.scrollTo({top:scroll,behavior:"instant"});
}
async function gamma(){const {data,error}=await client.from("fos_options_analysis_current").select("symbol,session_date,updated_at,source_as_of,status,spot,payload").eq("owner_id",userId).in("symbol",["SPX","SPY","QQQ","IWM"]);if(error)throw new Error("GAMMA_READ_FAILED");return data||[];}
const AI_COLUMNS="tracker_id,symbol,session_date,analysis_slot_at,generated_at,source_as_of,input_hash,analysis_markdown,analysis_summary,structure_read,levels_read,options_read,market_context,risks,watch_for,analysis_status,model_label,metadata,analysis_at,market_session_date,decision,bias,market_state,confidence,concise_summary,full_analysis,recommended_underlying,option_type,expiration,strike,bid,ask,premium_reference,delta,gamma,theta,iv,volume,open_interest,entry_condition,target,invalidation,es_key_levels,spx_key_levels,gamma_context,source_timestamps,source_ages,warnings,analysis_version";
async function aiCurrent(){const {data,error}=await client.from("fos_ai_analysis_current").select(AI_COLUMNS).eq("owner_id",userId).eq("tracker_id","SPX_AI").limit(1);if(error)throw new Error("AI_CURRENT_READ_FAILED");return data||[];}
async function aiHistory(){const {data,error}=await client.from("fos_ai_analysis_history").select(AI_COLUMNS).eq("owner_id",userId).eq("tracker_id","SPX_AI").order("analysis_at",{ascending:false,nullsFirst:false}).limit(50);if(error)throw new Error("AI_HISTORY_READ_FAILED");return data||[];}
async function refresh(){
  if(!authorized||busy)return;busy=true;
  try{
    if(ui.page==="home"){
      const refreshHistory=!ui.aiHistoryFetchedAt||Date.now()-ui.aiHistoryFetchedAt>=60000;
      const [gammaRows,current,history]=await Promise.all([gamma(),aiCurrent(),refreshHistory?aiHistory():Promise.resolve(model.aiHistory)]);
      if(refreshHistory)ui.aiHistoryFetchedAt=Date.now();
      model={...model,gamma:gammaRows,aiCurrent:current,aiHistory:history,gammaState:"READY"};
    }else if(ui.page==="options-analysis")model={...model,gamma:await gamma(),gammaState:"READY"};
    $("connection").textContent="Connected · Supabase read only";const stamps=[...(model.aiCurrent||[]).map(row=>Date.parse(row.analysis_at||row.analysis_slot_at||row.generated_at)),...(model.gamma||[]).map(row=>Date.parse(row.source_as_of))].filter(Number.isFinite);$("snapshotTime").textContent=stamps.length?new Date(Math.max(...stamps)).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",timeZone:"America/Chicago"}):"Awaiting source data";draw();
  }catch{$("connection").textContent="Source unavailable · retaining last rendered state";if(ui.page==="options-analysis")model.gammaState="UNAVAILABLE";draw();}
  finally{busy=false;clearTimeout(timer);if(authorized)timer=setTimeout(refresh,15000);}
}
async function authorize(session){if(!session?.user){clear();return;}const {data:reader,error}=await client.from("dashboard_readers").select("user_id").eq("user_id",session.user.id).maybeSingle();if(error||!reader){clear("This account is not authorized for the private dashboard.");return;}authorized=true;userId=session.user.id;$("auth").hidden=true;$("dashboard").hidden=false;currentRoute();await refresh();}

async function copyTradingViewGamma(){
  try{
    const result=buildTVG2(model.gamma,Date.now());
    try{
      if(!navigator.clipboard?.writeText)throw new Error("CLIPBOARD_API_UNAVAILABLE");
      await navigator.clipboard.writeText(result.text);
      ui.tradingViewGammaFeedback=tradingViewGammaFeedback(result);
      ui.tradingViewGammaFallback=null;
    }catch{
      ui.tradingViewGammaFeedback=`Clipboard unavailable - select and copy the exact TVG2 packet below. ${result.characterCount} characters.`;
      ui.tradingViewGammaFallback=result.text;
    }
  }catch(error){
    ui.tradingViewGammaFeedback=`TradingView gamma not copied - ${error.message}`;
    ui.tradingViewGammaFallback=null;
  }
  draw();
  document.querySelector("[data-tv-gamma-fallback]")?.select();
}

$("login").addEventListener("submit",async event=>{event.preventDefault();const fields=new FormData(event.target);const {data,error}=await client.auth.signInWithPassword({email:fields.get("email"),password:fields.get("password")});if(error)$("authError").textContent="Sign-in failed. Check your credentials.";else await authorize(data.session);});
$("signOut").addEventListener("click",async()=>{clear();await client.auth.signOut();});
$("page").addEventListener("click",async event=>{const target=event.target.closest("[data-action]");if(!target)return;if(target.dataset.action==="copy-tradingview-gamma"){await copyTradingViewGamma();return;}if(target.dataset.action==="close-tv-gamma-fallback"){ui.tradingViewGammaFallback=null;draw();return;}if(target.dataset.action==="select-options-symbol")ui.optionsSymbol=target.dataset.symbol;else if(target.dataset.action==="gamma-zoom"&&["TIGHT","NEAR","WIDE","ALL"].includes(target.dataset.zoom))ui.optionsZoom=target.dataset.zoom;draw();});
$("page").addEventListener("click",event=>{const card=event.target.closest("[data-gamma-symbol]");if(card)ui.optionsSymbol=card.dataset.gammaSymbol;});
window.addEventListener("hashchange",()=>{if(currentRoute())refresh();});document.addEventListener("visibilitychange",()=>{if(!document.hidden&&authorized)refresh();});document.addEventListener("keydown",event=>{if(event.key==="Escape"&&ui.tradingViewGammaFallback){ui.tradingViewGammaFallback=null;draw();}});client.auth.onAuthStateChange(event=>{if(event==="SIGNED_OUT")clear();});if(!location.hash)location.hash="#/home";await authorize((await client.auth.getSession()).data.session);
