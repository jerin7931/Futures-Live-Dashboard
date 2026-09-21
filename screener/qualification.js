import {CONFIG} from '../config.js';
import {render} from './view.js';
import {acceptEnvelope,witnessSample} from './qualification-core.js';
const $=id=>document.getElementById(id),run=new URL(location.href).searchParams.get('run');
const client=window.supabase.createClient(CONFIG.supabaseUrl,CONFIG.supabasePublishableKey);
const wall=Date.now(),mono=performance.now(),now=()=>wall+performance.now()-mono;
let user=null,current=null,received=null,paused=false,readError=false,timer=null,epoch=0,finished=false;
const samples=[],receipts=[],checks={hosted_private_read:false,rendered:false,options_rendered:false,
  momentum_rendered:false,target_response_rendered:false,concentration_rendered:false,
  trend_rendered:false,trend_expired_without_write:false,
  trend_fields_rendered:false,
  target_response_expired_without_write:false,momentum_expired_without_write:false,
  no_write_expiry:false,revoked_hidden:false,cross_attempt_hidden:false,disabled_hidden:false};
function report(){return {run_id:run,origin:location.origin,basis:current?.basis??'NO_RECORD',checks,receipts,samples,
  production_activation:false,live_market_qualified:false,market_requests:0,browser_database_writes:0};}
function summary(){return {...report(),samples:samples.length,receipts:receipts.length,
  last_receipt:receipts.at(-1),elapsed_ms:now()-wall,paused,read_error:readError};}
function clear(message){epoch++;user=null;current=null;clearTimeout(timer);render(document,null,now());$('result').textContent=message;$('pause').disabled=true;$('save').disabled=true;}
function frame(){
  if(!user||!current||finished)return;
  const t=now(),state=render(document,current.payload,t),sample=witnessSample(current,state,received,t,paused);
  samples.push(sample);if(samples.length>120000)samples.shift();
  const visibleOptions=sample.options.length,active=state.active.length;
  checks.hosted_private_read=true;
  if(current.basis==='HOSTED_SYNTHETIC_WALL_CLOCK'){
    if(current.phase==='VISIBLE'&&active===2&&document.querySelectorAll('#active .setup').length===2)checks.rendered=true;
    if(current.phase==='VISIBLE'&&visibleOptions===1&&document.querySelectorAll('#options .option-row').length===1)checks.options_rendered=true;
    if(current.phase==='VISIBLE'&&document.querySelector('#active .momentum-line')?.textContent.includes('MOVE +0.92%'))checks.momentum_rendered=true;
    if(current.phase==='VISIBLE'&&document.querySelector('#options .option-response')?.textContent.includes('EST RESPONSE +19–28%'))checks.target_response_rendered=true;
    if(current.phase==='VISIBLE'&&document.querySelector('#concentration')?.textContent.includes('INDUSTRY OVERLAP'))checks.concentration_rendered=true;
    if(current.phase==='VISIBLE'&&document.querySelector('#trend-synthetic')?.textContent.includes('SYN01')&&document.querySelector('#trend-synthetic')?.textContent.includes('AVAILABLE'))checks.trend_rendered=true;
    if(current.phase==='VISIBLE'&&['ROLLING_STRUCTURAL_BREAK','Current price','$101.20','Move / efficiency','Rank','#1','WHY NOW','source FRESH'].every(value=>document.querySelector('#trend-synthetic')?.textContent.includes(value)))checks.trend_fields_rendered=true;
    if(current.phase==='VISIBLE'&&t-Date.parse(current.generated_at)>6000&&document.querySelector('#trend-synthetic')?.textContent.includes('EXPIRED'))checks.trend_expired_without_write=true;
    if(current.phase==='VISIBLE'&&active===2&&visibleOptions===1&&t-Date.parse(current.generated_at)>6000&&
      document.querySelector('#options .option-response')?.textContent.includes('OPTION RESPONSE — UNAVAILABLE'))checks.target_response_expired_without_write=true;
    if(current.phase==='VISIBLE'&&active===2&&t-Date.parse(current.generated_at)>10000&&
      document.querySelector('#active .momentum-line')?.textContent.includes('MOVE —%'))checks.momentum_expired_without_write=true;
    if(current.phase==='EXPIRY_HOLD'&&active===0&&visibleOptions===0&&t-Date.parse(current.generated_at)>6500)checks.no_write_expiry=true;
    if(current.phase==='REVOKED'&&active===1&&visibleOptions===0)checks.revoked_hidden=true;
    if(current.phase==='CROSS_ATTEMPT'&&active===2&&visibleOptions===0)checks.cross_attempt_hidden=true;
    if(current.phase==='DISABLED'&&active===0&&visibleOptions===0)checks.disabled_hidden=true;
    if(current.phase==='COMPLETE'){
      const pass=Object.values(checks).every(Boolean);
      const missing=Object.entries(checks).filter(([,ok])=>!ok).map(([name])=>name);
      $('acceptance').textContent=(pass?'PASS':'FAIL')+' — hosted authenticated wall-clock engineering test; '+Object.values(checks).filter(Boolean).length+'/'+Object.keys(checks).length+'. NOT live-market qualification.'+(missing.length?' Missing: '+missing.join(', ')+'.':'');
      $('acceptance').dataset.outcome=pass?'PASS':'FAIL';finished=true;
    }
  }
  $('result').textContent=`Private isolated stream · ${current.phase??'OBSERVATION'} · sequence ${current.sequence} · active ${active} · options ${visibleOptions} · ${paused?'reads paused':readError?'read unavailable':'connected'}`;
  $('evidence').textContent=JSON.stringify(summary(),null,2);
}
async function poll(){
  const captured=epoch;
  if(user&&!paused&&!finished){
    try{
      const {data,error}=await client.from('fos_events').select('payload').eq('owner_id',user.id).eq('stream_id',run).eq('kind','QUALIFICATION_TEST').order('sequence',{ascending:false}).limit(1);
      if(error)throw Error('READ_UNAVAILABLE');
      if(captured!==epoch||!user)return;
      readError=false;
      if(data?.length){const e=acceptEnvelope(data[0].payload,run,current,now());
        if(e){current=e;received=new Date(now()).toISOString();receipts.push({sequence:e.sequence,generated_at:e.generated_at,received_at:received,delivery_ms:now()-Date.parse(e.generated_at)});
          $('basis').textContent=e.source_is_synthetic?'SYNTHETIC WALL-CLOCK ENGINEERING TEST — no real setup, option suggestion or live-data qualification.':'CONTROLLED MARKET OBSERVATIONS — isolated, not production recommendations. Unqualified branches remain unavailable.';
          $('save').disabled=false;}
      }
    }catch{readError=true;}
  }
  frame();if(user&&!finished)timer=setTimeout(poll,1000); // one read at a time
}
$('pause').onclick=()=>{paused=!paused;$('pause').textContent=paused?'Resume private reads':'Pause reads — expiry continues';frame();};
$('save').onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(report())],{type:'application/json'}));a.download=`hosted-qualification-${run}.json`;a.click();URL.revokeObjectURL(a.href);};
client.auth.onAuthStateChange(event=>{if(event==='SIGNED_OUT')clear('Signed out; isolated evidence cleared.');});
setInterval(frame,250);
try{
  if(!/^[a-f0-9-]{36}$/.test(run??''))throw Error('A specific qualification run ID is required.');
  const session=(await client.auth.getSession()).data.session;
  if(!session?.user)throw Error('Sign in on the private screener, then reload this test.');
  const {data,error}=await client.from('dashboard_readers').select('user_id').eq('user_id',session.user.id).maybeSingle();
  if(error||!data)throw Error('Owner dashboard authorization is required.');
  user=session.user;$('pause').disabled=false;$('result').textContent='Authenticated. Waiting for this isolated run.';poll();
}catch(e){clear(e.message);}
