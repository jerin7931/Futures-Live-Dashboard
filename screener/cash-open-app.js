import {CONFIG} from "../config.js?v=3.0.27-cutover";
import {href,chicagoDate,route} from "./cash-open-core.js?v=5.4.1";
import {strictZeroDte} from "./option-chain-core.js?v=5.2.0";
import {renderPage} from "./lppc-view.js?v=5.9.0";
import {bindChartTooltips} from "./chart-tooltip.js?v=5.7.0";
import {capturePageState,createUIState,restorePageState} from "./ui-state.js?v=5.7.0";
import {buildTVG2,tradingViewGammaFeedback} from "./tradingview-gamma.js?v=5.9.0";

const $=id=>document.getElementById(id);
const client=window.supabase.createClient(CONFIG.supabaseUrl,CONFIG.supabasePublishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
const ui=createUIState(route(location.hash));
let authorized=false,userId=null,timer=null,busy=false;
let model={lppc:[],eventHistory:[],gamma:[],aiCurrent:[],aiHistory:[],chainPointers:[],optionChain:[],gammaState:"READY"};

function clear(message=""){authorized=false;userId=null;clearTimeout(timer);$("auth").hidden=false;$("dashboard").hidden=true;$("authError").textContent=message;}
function currentRoute(){const next=route(location.hash);if(next.redirect){location.hash=href("home",next.demo);return false;}ui.page=next.page;ui.demo=next.demo;return true;}
function draw(){
  if(!authorized)return;
  capturePageState($("page"),ui);
  const focus=document.activeElement,focused=focus?.closest("#page")?focus:null,name=focused?.name,selection=focused&&typeof focused.selectionStart==="number"?[focused.selectionStart,focused.selectionEnd]:null,scroll=window.scrollY;
  $("pageTitle").textContent={home:"Home","options-analysis":"Options Analysis","option-chain":"Option Chain"}[ui.page];
  $("pageEyebrow").textContent="LPPC PRODUCTION · READ ONLY";$("demoBanner").hidden=true;$("modeBadge").textContent="READ ONLY";$("dashboard").querySelector(".brand").href=href("home");
  for(const link of document.querySelectorAll("#primaryNav a")){link.href=href(link.dataset.route);link.classList.toggle("active",link.dataset.route===ui.page);link.setAttribute("aria-current",link.dataset.route===ui.page?"page":"false");}
  $("page").innerHTML=renderPage(model,ui);
  restorePageState($("page"),ui);
  bindChartTooltips($("page"));
  if(name){const replacement=[...$("page").querySelectorAll("[name]")].find(item=>item.name===name);if(replacement){replacement.focus({preventScroll:true});if(selection&&replacement.setSelectionRange)replacement.setSelectionRange(...selection);}}
  if(window.scrollY!==scroll)window.scrollTo({top:scroll,behavior:"instant"});
}
async function rows(table,columns,day,order=null,limit=5000){let query=client.from(table).select(columns).eq("owner_id",userId).eq("session_date",day).limit(limit);if(order)query=query.order(order);const {data,error}=await query;if(error)throw new Error(`${table}_READ_FAILED`);return data||[];}
async function gamma(day){const {data,error}=await client.from("fos_options_analysis_current").select("symbol,session_date,updated_at,source_as_of,status,spot,payload").eq("owner_id",userId).eq("session_date",day).in("symbol",["SPX","SPY","QQQ","IWM"]);if(error)throw new Error("GAMMA_READ_FAILED");return data||[];}
const AI_COLUMNS="tracker_id,symbol,session_date,analysis_slot_at,generated_at,source_as_of,input_hash,analysis_markdown,analysis_summary,structure_read,levels_read,options_read,market_context,risks,watch_for,analysis_status,model_label,metadata";
async function aiCurrent(day){return rows("fos_ai_analysis_current",AI_COLUMNS,day,null,4);}
async function aiHistory(day){return rows("fos_ai_analysis_history",AI_COLUMNS,day,"analysis_slot_at",100);}
async function chain(day){
  const snapshots=await rows("fos_option_chain_snapshot_current","underlying,session_date,expiration_date,snapshot_id,status,source_as_of,updated_at,coverage,contracts",day,null,4);
  const contracts=snapshots.flatMap(row=>(Array.isArray(row.contracts)?row.contracts:[]).map(contract=>({...contract,underlying:row.underlying,session_date:row.session_date,expiration_date:row.expiration_date})));
  return {pointers:snapshots,contracts:strictZeroDte(contracts,day)};
}
async function refresh(){
  if(!authorized||busy)return;busy=true;
  try{
    const day=chicagoDate();
    if(ui.page==="home"){
      const refreshHistory=!ui.aiHistoryFetchedAt||Date.now()-ui.aiHistoryFetchedAt>=60000;
      const [lppc,eventHistory,gammaRows,current,history]=await Promise.all([rows("fos_lppc_state_current","*",day),rows("fos_lppc_event_history","symbol,session_date,recorded_at,transition,event_state,telegram_event_type,telegram_delivery_status,payload",day,"recorded_at"),gamma(day),aiCurrent(day),refreshHistory?aiHistory(day):Promise.resolve(model.aiHistory)]);
      if(refreshHistory)ui.aiHistoryFetchedAt=Date.now();
      model={...model,lppc,eventHistory,gamma:gammaRows,aiCurrent:current,aiHistory:history,gammaState:"READY"};
    }else if(ui.page==="options-analysis")model={...model,gamma:await gamma(day),gammaState:"READY"};
    else if(ui.page==="option-chain"){const result=await chain(day);model={...model,chainPointers:result.pointers,optionChain:result.contracts};}
    $("connection").textContent="Connected · Supabase read only";const stamps=model.lppc.map(row=>Date.parse(row.updated_at)).filter(Number.isFinite);$("snapshotTime").textContent=stamps.length?new Date(Math.max(...stamps)).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",timeZone:"America/Chicago"}):"Awaiting current session";draw();
  }catch{$("connection").textContent="Source unavailable · retaining last rendered state";if(ui.page==="options-analysis")model.gammaState="UNAVAILABLE";draw();}
  finally{busy=false;clearTimeout(timer);if(authorized)timer=setTimeout(refresh,ui.page==="options-analysis"?15000:5000);}
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
$("page").addEventListener("click",async event=>{const target=event.target.closest("[data-action]");if(!target)return;if(target.dataset.action==="copy-tradingview-gamma"){await copyTradingViewGamma();return;}if(target.dataset.action==="close-tv-gamma-fallback"){ui.tradingViewGammaFallback=null;draw();return;}if(target.dataset.action==="select-options-symbol")ui.optionsSymbol=target.dataset.symbol;else if(target.dataset.action==="gamma-zoom"&&["TIGHT","NEAR","WIDE","ALL"].includes(target.dataset.zoom))ui.optionsZoom=target.dataset.zoom;else if(target.dataset.action==="toggle-ai")ui.aiExpanded[target.dataset.symbol]=!ui.aiExpanded[target.dataset.symbol];else if(target.dataset.action==="chain-security")ui.chainFilters.security=target.dataset.value;else if(target.dataset.action==="chain-right")ui.chainFilters.right=target.dataset.value;else if(target.dataset.action==="chain-premium-reset"){ui.chainFilters.askMin="";ui.chainFilters.askMax="";}else if(target.dataset.action==="chain-direction")ui.chainFilters.direction=ui.chainFilters.direction==="asc"?"desc":"asc";draw();});
$("page").addEventListener("input",event=>{if(event.target.name==="askMin"||event.target.name==="askMax")ui.chainFilters[event.target.name]=event.target.value;draw();});
$("page").addEventListener("change",event=>{if(event.target.name==="sort"){ui.chainFilters.sort=event.target.value;draw();}});$("page").addEventListener("click",event=>{const card=event.target.closest("[data-gamma-symbol]");if(card)ui.optionsSymbol=card.dataset.gammaSymbol;});
window.addEventListener("hashchange",()=>{if(currentRoute())refresh();});document.addEventListener("visibilitychange",()=>{if(!document.hidden&&authorized)refresh();});document.addEventListener("keydown",event=>{if(event.key==="Escape"&&ui.tradingViewGammaFallback){ui.tradingViewGammaFallback=null;draw();}});client.auth.onAuthStateChange(event=>{if(event==="SIGNED_OUT")clear();});if(!location.hash)location.hash="#/home";await authorize((await client.auth.getSession()).data.session);
