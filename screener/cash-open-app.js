import {CONFIG} from "../config.js?v=3.0.27-cutover";
import {DEFAULT_FILTERS,href,newYorkDate,normalizeCandidates,route,tradingViewExport,tradingViewFilename} from "./cash-open-core.js?v=4.0.0";
import {cashOpenDemo} from "./cash-open-demo.js?v=4.0.0";
import {renderDetail,renderPage} from "./cash-open-view.js?v=4.0.0";

const $=id=>document.getElementById(id);
const client=window.supabase.createClient(CONFIG.supabaseUrl,CONFIG.supabasePublishableKey,
  {auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
const ui={...route(location.hash),filters:{...DEFAULT_FILTERS},newsQuery:"",optionsSymbol:"SPX",
  optionsZoom:"NEAR",selectedSymbol:null,exportFeedback:""};
let authorized=false,userId=null,model={session:null,candidates:[],gamma:[],news:null},timer=null,busy=false;

function clear(message=""){
  authorized=false;userId=null;clearTimeout(timer);$("auth").hidden=false;$("dashboard").hidden=true;
  $("authError").textContent=message;$("detailOverlay").hidden=true;
}
function currentRoute(){
  const next=route(location.hash);
  if(next.redirect){location.hash=href("home",next.demo);return false;}
  ui.page=next.page;ui.demo=next.demo;
  return true;
}
function draw(){
  if(!authorized)return;
  const focus=document.activeElement,focused=focus?.closest("#page")?focus:null;
  const name=focused?.name,selection=(focused&&typeof focused.selectionStart==="number")?
    [focused.selectionStart,focused.selectionEnd]:null;
  const scroll=window.scrollY;
  $("pageTitle").textContent={home:"Home",tracking:"Tracking",news:"News & Catalysts",
    "options-analysis":"Options Analysis"}[ui.page];
  $("pageEyebrow").textContent="CASH-OPEN FOCUS · READ ONLY";
  $("demoBanner").hidden=!ui.demo;
  $("modeBadge").textContent=ui.demo?"SIMULATED":"CAPTURE ONLY";
  for(const link of document.querySelectorAll("#primaryNav a")){
    link.classList.toggle("active",link.dataset.route===ui.page);
    link.setAttribute("aria-current",link.dataset.route===ui.page?"page":"false");
  }
  $("page").innerHTML=renderPage(model,ui);
  if(name){
    const replacement=[...$("page").querySelectorAll("[name]")].find(item=>item.name===name);
    if(replacement){replacement.focus({preventScroll:true});if(selection&&replacement.setSelectionRange)replacement.setSelectionRange(...selection);}
  }
  if(window.scrollY!==scroll)window.scrollTo({top:scroll,behavior:"instant"});
  if(ui.selectedSymbol){
    const row=model.candidates.find(item=>item.symbol===ui.selectedSymbol);
    if(row){$("detailDialog").innerHTML=renderDetail(row);$("detailOverlay").hidden=false;}
  }
}
async function one(table,columns,day){
  const {data,error}=await client.from(table).select(columns).eq("owner_id",userId)
    .eq("session_date",day).limit(1);
  if(error)throw new Error(`${table}_READ_FAILED`);
  return data?.[0]||null;
}
async function many(table,columns,day){
  const {data,error}=await client.from(table).select(columns).eq("owner_id",userId)
    .eq("session_date",day).order("symbol").limit(500);
  if(error)throw new Error(`${table}_READ_FAILED`);
  return data||[];
}
async function gamma(day){
  const {data,error}=await client.from("fos_options_analysis_current")
    .select("symbol,session_date,updated_at,source_as_of,status,spot,payload")
    .eq("owner_id",userId).eq("session_date",day).in("symbol",["SPX","SPY","QQQ","IWM"]);
  if(error)throw new Error("GAMMA_READ_FAILED");
  return data||[];
}
async function refresh(){
  if(!authorized||busy)return;
  busy=true;
  try{
    if(ui.demo)model=cashOpenDemo();
    else{
      const day=newYorkDate();
      if(ui.page==="home"||ui.page==="tracking"){
        const [session,candidates]=await Promise.all([
          one("fos_cash_open_session_current","session_date,phase,status,spy_open_return,gate_0845_count,long_selected_count,short_selected_count,focus_locked_at,source_as_of,payload",day),
          many("fos_cash_open_candidates_current","symbol,session_date,exchange_code,direction,gate_0845,standard_0900,selected_0900,lane,underlying_rank,lane_rank,option_quality_at_lock,option_quality_current,data_status,source_as_of,payload",day)]);
        model={...model,session,candidates:normalizeCandidates(candidates)};
      }
      if(ui.page==="home"||ui.page==="options-analysis")model={...model,gamma:await gamma(day),gammaState:"READY"};
      if(ui.page==="home"||ui.page==="news"){
        const news=await one("fos_market_news_current","session_date,source_as_of,updated_at,payload",day);
        model={...model,news:news?.payload||null};
      }
    }
    $("connection").textContent=ui.demo?"Simulated data":"Connected · current-state only";
    $("snapshotTime").textContent=model.session?.source_as_of?
      new Date(model.session.source_as_of).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",timeZone:"America/Chicago"}):"Awaiting current session";
    draw();
  }catch(error){
    $("connection").textContent="Source unavailable · retaining last rendered evidence";
    if(ui.page==="options-analysis")model.gammaState="UNAVAILABLE";
    // Never blank the current rows or reset user-controlled filters on failure.
    draw();
  }finally{
    busy=false;clearTimeout(timer);
    if(authorized)timer=setTimeout(refresh,ui.page==="options-analysis"?15000:5000);
  }
}

async function authorize(session){
  if(!session?.user){clear();return;}
  const {data:reader,error}=await client.from("dashboard_readers")
    .select("user_id").eq("user_id",session.user.id).maybeSingle();
  if(error||!reader){clear("This account is not authorized for the private dashboard.");return;}
  authorized=true;userId=session.user.id;$("auth").hidden=true;$("dashboard").hidden=false;
  currentRoute();await refresh();
}

async function exportSymbols(copy){
  const result=tradingViewExport(model.candidates);
  if(!result.symbols.length){ui.exportFeedback="No symbols to export";draw();return;}
  try{
    if(copy){await navigator.clipboard.writeText(result.text);ui.exportFeedback=`Copied ${result.symbols.length} symbols`;}
    else{
      const url=URL.createObjectURL(new Blob([result.text],{type:"text/plain;charset=utf-8"}));
      const link=document.createElement("a");link.href=url;link.download=tradingViewFilename();
      document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),5000);
      ui.exportFeedback=`Exported ${result.symbols.length} symbols`;
    }
    if(result.unmapped)ui.exportFeedback+=` · ${result.unmapped} skipped: exchange unavailable`;
  }catch{ui.exportFeedback=copy?"Clipboard unavailable":"Download unavailable";}
  const feedback=$("cashExportFeedback");if(feedback)feedback.textContent=ui.exportFeedback;
}

$("login").addEventListener("submit",async event=>{
  event.preventDefault();const fields=new FormData(event.target);
  const {data,error}=await client.auth.signInWithPassword({email:fields.get("email"),password:fields.get("password")});
  if(error)$("authError").textContent="Sign-in failed. Check your credentials.";
  else await authorize(data.session);
});
$("signOut").addEventListener("click",async()=>{clear();await client.auth.signOut();});
$("page").addEventListener("click",event=>{
  const target=event.target.closest("[data-action]");if(!target)return;
  if(target.dataset.action==="detail"){
    ui.selectedSymbol=target.dataset.symbol;draw();
  }else if(target.dataset.action==="export-tradingview")exportSymbols(false);
  else if(target.dataset.action==="copy-tradingview")exportSymbols(true);
  else if(target.dataset.action==="select-options-symbol"){
    ui.optionsSymbol=target.dataset.symbol;draw();
  }else if(target.dataset.action==="gamma-zoom"){
    ui.optionsZoom=target.dataset.zoom;draw();
  }
});
$("page").addEventListener("change",event=>{
  if(event.target.name in ui.filters){ui.filters={...ui.filters,[event.target.name]:event.target.value};draw();}
});
$("page").addEventListener("input",event=>{
  if(event.target.name==="query"){ui.filters={...ui.filters,query:event.target.value};draw();}
  if(event.target.name==="newsQuery"){ui.newsQuery=event.target.value;draw();}
});
$("page").addEventListener("click",event=>{
  const card=event.target.closest("[data-gamma-symbol]");
  if(card)ui.optionsSymbol=card.dataset.gammaSymbol;
});
$("detailOverlay").addEventListener("click",event=>{
  if(event.target===$("detailOverlay")||event.target.closest('[data-action="close-detail"]')){
    ui.selectedSymbol=null;$("detailOverlay").hidden=true;
  }
});
document.addEventListener("keydown",event=>{if(event.key==="Escape"){
  ui.selectedSymbol=null;$("detailOverlay").hidden=true;
}});
window.addEventListener("hashchange",()=>{if(!currentRoute())return;ui.selectedSymbol=null;
  $("detailOverlay").hidden=true;refresh();});
document.addEventListener("visibilitychange",()=>{if(!document.hidden&&authorized)refresh();});
client.auth.onAuthStateChange(event=>{if(event==="SIGNED_OUT")clear();});
if(!location.hash)location.hash="#/home";
await authorize((await client.auth.getSession()).data.session);
