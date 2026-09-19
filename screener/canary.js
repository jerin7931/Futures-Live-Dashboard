import {CONFIG} from "../config.js";
import {render} from "./view.js";
const client=window.supabase.createClient(CONFIG.supabaseUrl,CONFIG.supabasePublishableKey);
const result=document.getElementById("result"),checks=document.getElementById("checks");
function assert(value,message){if(!value)throw Error(message);}
try{
  const session=(await client.auth.getSession()).data.session;
  assert(session?.user,"Sign in on the private screener, then reload this test.");
  const run=new URL(location.href).searchParams.get("run");
  assert(/^[a-f0-9-]{36}$/.test(run??""),"A specific canary run ID is required.");
  const {data,error}=await client.from("fos_events").select("payload").eq("owner_id",session.user.id).eq("stream_id",run).eq("kind","CANARY_TEST").limit(1);
  assert(!error&&data?.length===1,"Private canary read failed or no matching test exists.");
  const test=data[0].payload;
  assert(test.test_only===true&&test.source_is_synthetic===true&&test.run_id===run,"Not an isolated canary envelope.");
  assert(test.cases.length===8,"Incomplete case coverage.");
  let passed=0;
  for(const c of test.cases){
    const state=render(document,c.payload,Date.parse(c.test_now));
    const optionCount=state.options.reduce((n,o)=>n+(o.result?.rows.length??0),0);
    assert(state.active.length===c.expected_active,c.name+": active count");
    assert(optionCount===c.expected_options,c.name+": options count");
    assert(document.querySelectorAll("#active .setup").length===c.expected_active,c.name+": rendered active count");
    assert(document.querySelectorAll("#options .option-row").length===c.expected_options,c.name+": rendered option count");
    const li=document.createElement("li");li.textContent="PASS — "+c.name+" · active "+state.active.length+" · options "+optionCount;checks.append(li);passed++;
  }
  result.textContent="PASS — "+passed+"/8 connected acceptance cases. Private Supabase read → deployed production renderer. No production signals, configuration or market-data qualification changed.";
  result.dataset.outcome="PASS";result.dataset.run=run;
}catch(e){result.textContent="FAIL — "+e.message;result.dataset.outcome="FAIL";}
