import {readFile,access} from "node:fs/promises";
import {execFileSync} from "node:child_process";

const files=["index.html","screener/index.html","screener/cash-open-app.js","screener/cash-open-core.js","screener/ai-workspace-view.js","screener/options-analysis-view.js","screener/styles.css","config.js"];
for(const file of files){
  const text=await readFile(new URL("../"+file,import.meta.url),"utf8");
  if(/service[_-]?role|SUPABASE_SECRET|WEBULL_APP/i.test(text))throw Error("Privileged marker: "+file);
  if(file.endsWith(".js"))execFileSync(process.execPath,["--check",file]);
}
for(const retired of ["spx-fast/index.html","screener/spx-fast-view.js"]){
  let exists=true;try{await access(new URL("../"+retired,import.meta.url));}catch{exists=false;}
  if(exists)throw Error("Retired SPX Fast surface remains: "+retired);
}
const home=await readFile(new URL("../index.html",import.meta.url),"utf8");
for(const id of ["auth","login","dashboard","primaryNav","page","detailOverlay","demoBanner"])if(!home.includes('id="'+id+'"'))throw Error("Missing region: "+id);
for(const route of ["home","options-analysis"])if(!home.includes('data-route="'+route+'"'))throw Error("Missing route: "+route);
if(/data-route="spx-fast"|SPX \/ ES AI Workspace/.test(home))throw Error("SPX Fast UI remains");
if(!home.includes('src="./screener/cash-open-app.js?v=6.4.0"')||!home.includes("frame-src 'none';")||!home.includes('https://gbtjmhjhqhtnbswsylvd.supabase.co'))throw Error("Primary application / CSP regression");
const live=await readFile(new URL("../screener/cash-open-app.js",import.meta.url),"utf8");
if(/get_spx_fast_state|SPX_AI|fos_ai_analysis_|\.insert\(|\.upsert\(|\.update\(|\.delete\(/.test(live))throw Error("Retired SPX Fast writer/reader remains");
if(!live.includes('["SPY","QQQ","IWM"]'))throw Error("Three-Bot gamma universe is not exact");
console.log("Three-Bot v6.4.0 bundle verified; authenticated read-only SPY/QQQ/IWM status with SPX Fast removed.");
