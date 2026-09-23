import {readFile,access} from "node:fs/promises";
import {execFileSync} from "node:child_process";
const files=["index.html","screener/index.html","screener/app.js","screener/dashboard-core.js","screener/tracking-core.js","screener/demo-data.js","screener/workstation-view.js","screener/view.js","screener/styles.css","screener/canary.html","screener/canary.js","screener/qualification.html","screener/qualification.js","screener/qualification-core.js","config.js"];
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
for(const route of ["home","opportunities","tracking","market","sectors","news","watchlist"])if(!home.includes('data-route="'+route+'"'))throw Error("Missing route: "+route);
if(!home.includes('src="./screener/app.js?v=3.0.21"')||!home.includes("frame-src 'none';"))throw Error("Primary application / CSP regression");
if(!(await readFile(new URL("../screener/workstation-view.js",import.meta.url),"utf8")).includes('dashboard-core.js?v=3.0.15'))throw Error("Nested workstation route import is not cache-versioned");
const demo=await readFile(new URL("../screener/demo-data.js",import.meta.url),"utf8");
if(/fetch\(|supabase|WebSocket|XMLHttpRequest/i.test(demo))throw Error("Demo isolation regression");
console.log("FOS workstation bundle verified; seven routes present; demo isolated; all JavaScript syntax checked.");
