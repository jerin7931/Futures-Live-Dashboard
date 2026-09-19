import {CONFIG} from "../config.js";
import {render} from "./view.js";
const $=id=>document.getElementById(id);
const client=window.supabase.createClient(CONFIG.supabaseUrl,CONFIG.supabasePublishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
let authorized=false,data=null,poll=null,busy=false,lastSequence=-1,lastStream=null;
const initialWall=Date.now(),initialMono=performance.now();
const now=()=>initialWall+performance.now()-initialMono;
function clear(message=""){
  authorized=false;data=null;lastSequence=-1;lastStream=null;
  $("auth").hidden=false;$("dashboard").hidden=true;$("signOut").hidden=true;
  for(const id of ["health","active","ranking","contenders","options","sources","history","tracking","coverage"])$(id).replaceChildren();
  $("authError").textContent=message;clearInterval(poll);
}
async function refresh(){
  if(!authorized||busy)return;busy=true;
  try{
    const {data:rows,error}=await client.from("fos_current").select("stream_id,sequence,payload").limit(1);
    if(error)throw Error("READ_FAILED");
    if(!authorized)return;
    if(rows.length){
      const row=rows[0];
      if(lastStream&&row.stream_id!==lastStream)throw Error("STREAM_CHANGED");
      if(row.sequence>=lastSequence){lastSequence=row.sequence;lastStream=row.stream_id;data=row.payload;}
    }
    $("connection").textContent=rows.length?"Private projection · "+(data?.health?.actionable_enabled?"1s":"5s")+" refresh":"Waiting for first projection";
  }catch{$("connection").textContent="Connection unavailable · expiry remains enforced";}
  finally{busy=false;if(authorized){render(document,data,now());clearTimeout(poll);poll=setTimeout(refresh,data?.health?.actionable_enabled?1000:5000);}}
}
async function authorize(session){
  if(!session?.user)return clear();
  const {data:reader,error}=await client.from("dashboard_readers").select("user_id").eq("user_id",session.user.id).maybeSingle();
  if(error||!reader)return clear("This account is not authorized for the private dashboard.");
  authorized=true;$("auth").hidden=true;$("dashboard").hidden=false;$("signOut").hidden=false;
  await refresh();
}
$("login").addEventListener("submit",async e=>{
  e.preventDefault();const fields=new FormData(e.target);
  const {data:result,error}=await client.auth.signInWithPassword({email:fields.get("email"),password:fields.get("password")});
  if(error)$("authError").textContent="Sign-in failed. Check your credentials.";else await authorize(result.session);
});
$("signOut").addEventListener("click",async()=>{clear();await client.auth.signOut();});
client.auth.onAuthStateChange(event=>{if(event==="SIGNED_OUT")clear();});
setInterval(()=>{if(authorized)render(document,data,now());},500);
document.addEventListener("visibilitychange",()=>{if(!document.hidden){if(authorized)render(document,data,now());refresh();}});
await authorize((await client.auth.getSession()).data.session);
