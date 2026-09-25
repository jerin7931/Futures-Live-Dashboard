import {readFile,access} from "node:fs/promises";
import {execFileSync} from "node:child_process";
const files=["index.html","screener/index.html","screener/cash-open-app.js","screener/cash-open-core.js","screener/cash-open-view.js","screener/cash-open-demo.js","screener/tracking-core.js","screener/options-analysis-view.js","screener/styles.css","config.js"];
for(const file of files){
 const text=await readFile(new URL("../"+file,import.meta.url),"utf8");
 if(/intraday_analysis|write_intraday|spyCard|qqqCard|gammaFrameHost|insiderfinance|market_briefs|options_chain_live|spy_qqq/i.test(text))throw Error("Retired dependency: "+file);
 if(/service[_-]?role|SUPABASE_SECRET|WEBULL_APP/i.test(text))throw Error("Privileged marker: "+file);
 if(file.endsWith(".js"))execFileSync(process.execPath,["--check",file]);
}
for(const old of ["app.js","core.js","gamma.js","styles.css"]){
 let exists=true;try{await access(new URL("../"+old,import.meta.url));}catch{exists=false;}
 if(exists)throw Error("Retired root module still exists: "+old);
}
const home=await readFile(new URL("../index.html",import.meta.url),"utf8");
for(const id of ["auth","login","dashboard","primaryNav","page","detailOverlay","demoBanner"])if(!home.includes('id="'+id+'"'))throw Error("Missing region: "+id);
for(const route of ["home","tracking","options-analysis","news"])if(!home.includes('data-route="'+route+'"'))throw Error("Missing route: "+route);
for(const route of ["market","sectors","opportunities","watchlist"])if(home.includes('data-route="'+route+'"'))throw Error("Retired navigation remains: "+route);
if(!home.includes('src="./screener/cash-open-app.js?v=4.0.0"')||!home.includes("frame-src 'none';")||!home.includes("font-src 'self' https://cdn.jsdelivr.net;")||!home.includes('https://gbtjmhjhqhtnbswsylvd.supabase.co'))throw Error("Primary application / CSP regression");
const live=await readFile(new URL("../screener/cash-open-app.js",import.meta.url),"utf8");
if(/fos_current|fos_symbol_history|fos_tracker_current|fos_events|fetch\(|Webull|OpenAI/i.test(live))throw Error("Old projection or live provider call in Cash-Open app");
const demo=await readFile(new URL("../screener/cash-open-demo.js",import.meta.url),"utf8");
if(/fetch\(|supabase|WebSocket|XMLHttpRequest/i.test(demo))throw Error("Demo isolation regression");
console.log("Cash-Open Focus bundle verified; four visible routes present; demo isolated; all JavaScript syntax checked.");
