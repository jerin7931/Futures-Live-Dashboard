import {readFile,access} from "node:fs/promises";
import {execFileSync} from "node:child_process";
const files=["index.html","screener/index.html","screener/app.js","screener/view.js","screener/styles.css","screener/canary.html","screener/canary.js","screener/qualification.html","screener/qualification.js","screener/qualification-core.js","config.js"];
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
for(const id of ["auth","login","dashboard","health","active","ranking","contenders","options","history","tracking","sources","coverage"])if(!home.includes('id="'+id+'"'))throw Error("Missing region: "+id);
if(!home.includes('src="./screener/app.js"')||!home.includes("frame-src 'none';"))throw Error("Primary application / CSP regression");
console.log("FOS primary bundle verified; retired modules absent; all JavaScript syntax checked.");
