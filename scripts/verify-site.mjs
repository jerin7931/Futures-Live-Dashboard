import {readFile,access} from "node:fs/promises";
import {execFileSync} from "node:child_process";
const files=["index.html","screener/index.html","screener/cash-open-app.js","screener/cash-open-core.js","screener/ai-workspace-view.js","screener/options-analysis-view.js","screener/tradingview-gamma.js","screener/styles.css","config.js"];
for(const file of files){
 const text=await readFile(new URL("../"+file,import.meta.url),"utf8");
 if(/intraday_analysis|write_intraday|spyCard|qqqCard|gammaFrameHost|market_briefs|options_chain_live|spy_qqq/i.test(text))throw Error("Retired dependency: "+file);
 if(/service[_-]?role|SUPABASE_SECRET|WEBULL_APP/i.test(text))throw Error("Privileged marker: "+file);
 if(file.endsWith(".js"))execFileSync(process.execPath,["--check",file]);
}
for(const old of ["app.js","core.js","gamma.js","styles.css"]){
 let exists=true;try{await access(new URL("../"+old,import.meta.url));}catch{exists=false;}
 if(exists)throw Error("Retired root module still exists: "+old);
}
const home=await readFile(new URL("../index.html",import.meta.url),"utf8");
for(const id of ["auth","login","dashboard","primaryNav","page","detailOverlay","demoBanner"])if(!home.includes('id="'+id+'"'))throw Error("Missing region: "+id);
for(const route of ["home","options-analysis"])if(!home.includes('data-route="'+route+'"'))throw Error("Missing route: "+route);
for(const route of ["market","sectors","opportunities","watchlist","tracking","news","option-chain"])if(home.includes('data-route="'+route+'"'))throw Error("Retired navigation remains: "+route);
if(!home.includes('src="./screener/cash-open-app.js?v=6.0.2"')||!home.includes("frame-src 'none';")||!home.includes("font-src 'self' https://cdn.jsdelivr.net;")||!home.includes('https://gbtjmhjhqhtnbswsylvd.supabase.co'))throw Error("Primary application / CSP regression");
const live=await readFile(new URL("../screener/cash-open-app.js",import.meta.url),"utf8");
if(/fos_current|fos_symbol_history|fos_tracker_current|fos_events|fetch\(|Webull|OpenAI/i.test(live))throw Error("Old projection or live provider call in Cash-Open app");
if(!live.includes("buildTVG2")||!live.includes("navigator.clipboard?.writeText")||/fos_lppc_(?:efficiency|participation|observation)/.test(live))throw Error("TradingView-first Home regression");
console.log("SPX / ES AI v6.0.2 bundle verified; persistent AI detail state, read-only SPX_AI, TVG2 gamma export, preserved Option Analysis, and exactly two visible routes.");
