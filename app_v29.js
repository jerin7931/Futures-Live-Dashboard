(()=>{
'use strict';
const cfg=window.DASHBOARD_CONFIG||{};
const $=id=>document.getElementById(id);
const $$=s=>[...document.querySelectorAll(s)];
if(!cfg.supabaseUrl||!cfg.supabasePublishableKey){document.body.innerHTML='config.js required';return;}
const client=window.supabase.createClient(cfg.supabaseUrl,cfg.supabasePublishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});

const TFS=['1m','5m','10m','15m','1h','4h'];
const ST_TFS=['1m','5m','10m','15m','1h','4h','1d'];
const DELTA_TFS=['1m','5m','10m','15m','1h'];
const TF_MIN={'1m':1,'5m':5,'10m':10,'15m':15,'1h':60,'4h':240,'1d':1380};
const ALIASES={ES:['ES','MES'],NQ:['NQ','MNQ']};
const TF_ALIASES={'1m':['1m'],'5m':['5m'],'10m':['10m'],'15m':['15m'],'1h':['1h','60m'],'4h':['4h','240m'],'1d':['1d','1D','D','day']};
const state={
  session:null,quotes:[],health:[],bars:[],footprints:[],events:[],
  symbol:'ES',tf:'5m',selectedEvent:null,
  chart:null,candles:null,ema9:null,ema21:null,vwap:null,markerApi:null,
  priceLines:[],chartKey:null,liveMinutes:{ES:new Map(),NQ:new Map()},
  visibility:{ema9:true,ema21:true,vwap:true,trades:true},
  channel:null,fetchTimers:{},barsSeq:0,marketBootstrapped:false
};
window.FM_ORDERFLOW_CLIENT=client;
window.FM_ORDERFLOW_STATE=state;
const QUEUE_UI_KEY='ema_cci_v29_queue_ui_v1';
const queueUi={hidden:false,root:'ALL',tf:'ALL',side:'ALL',decision:'ALL',execState:'ALL'};
function loadQueueUi(){
  try{
    const saved=JSON.parse(localStorage.getItem(QUEUE_UI_KEY)||'{}');
    for(const k of Object.keys(queueUi))if(Object.prototype.hasOwnProperty.call(saved,k))queueUi[k]=saved[k];
  }catch{}
}
function saveQueueUi(){try{localStorage.setItem(QUEUE_UI_KEY,JSON.stringify(queueUi));}catch{}}
function queueStateGroup(e){
  const s=String(e.execution_state||'').toUpperCase();
  if(['WAIT_NEXT_BAR','TRADE_CANDIDATE','FILLED','OPEN'].includes(s))return'ACTIVE';
  if(s==='TP_HIT')return'TP_HIT';
  if(s==='SL_HIT')return'SL_HIT';
  if(s==='NO_FILL')return'NO_FILL';
  if(['V2_SKIP','GAM_SKIP'].includes(s))return'SKIPPED';
  return'OTHER';
}
function queueFilteredEvents(){
  return state.events.filter(e=>{
    if(queueUi.root!=='ALL'&&String(e.root||'').toUpperCase()!==queueUi.root)return false;
    if(queueUi.tf!=='ALL'&&String(e.timeframe||'')!==queueUi.tf)return false;
    if(queueUi.side!=='ALL'&&String(e.direction||'').toUpperCase()!==queueUi.side)return false;
    if(queueUi.decision!=='ALL'&&String(e.v2_decision||'').toUpperCase()!==queueUi.decision)return false;
    if(queueUi.execState!=='ALL'&&queueStateGroup(e)!==queueUi.execState)return false;
    return true;
  });
}
function syncQueueControls(){
  const body=$('setupQueueBody'),btn=$('setupQueueToggle');
  if(body)body.classList.toggle('hidden',queueUi.hidden);
  if(btn){btn.textContent=queueUi.hidden?'Show Queue':'Hide Queue';btn.setAttribute('aria-expanded',String(!queueUi.hidden));}
  const vals={queueFilterRoot:queueUi.root,queueFilterTf:queueUi.tf,queueFilterSide:queueUi.side,queueFilterDecision:queueUi.decision,queueFilterState:queueUi.execState};
  for(const [id,v] of Object.entries(vals)){const n=$(id);if(n)n.value=v;}
}
loadQueueUi();

const fmt=(v,d=2)=>Number.isFinite(Number(v))?Number(v).toFixed(d):'—';
const pct=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?`${(100*Number(v)).toFixed(1)}%`:'—';
const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const ct=v=>{try{return new Intl.DateTimeFormat('en-US',{timeZone:cfg.timezone||'America/Chicago',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(v));}catch{return'—';}};
const CHART_TZ=cfg.timezone||'America/Chicago';
function chartDateFromTime(time){
  if(typeof time==='number'&&Number.isFinite(time))return new Date(time*1000);
  if(time&&typeof time==='object'&&Number.isFinite(time.year)&&Number.isFinite(time.month)&&Number.isFinite(time.day)){
    return new Date(Date.UTC(time.year,time.month-1,time.day));
  }
  const d=new Date(time);
  return Number.isNaN(d.getTime())?null:d;
}
function chartTickMark(time,tickMarkType){
  const d=chartDateFromTime(time);
  if(!d)return null;
  const common={timeZone:CHART_TZ};
  switch(Number(tickMarkType)){
    case 0:
      return new Intl.DateTimeFormat('en-US',{...common,year:'numeric'}).format(d);
    case 1:
      return new Intl.DateTimeFormat('en-US',{...common,month:'short'}).format(d);
    case 2:
      return new Intl.DateTimeFormat('en-US',{...common,month:'short',day:'numeric'}).format(d);
    case 3:
    case 4:
      return new Intl.DateTimeFormat('en-US',{...common,hour:'numeric',minute:'2-digit',hour12:true}).format(d);
    default:
      return new Intl.DateTimeFormat('en-US',{...common,hour:'numeric',minute:'2-digit',hour12:true}).format(d);
  }
}
function chartCrosshairTime(time){
  const d=chartDateFromTime(time);
  if(!d)return '--';
  return new Intl.DateTimeFormat('en-US',{
    timeZone:CHART_TZ,
    month:'short',
    day:'numeric',
    hour:'numeric',
    minute:'2-digit',
    hour12:true,
    timeZoneName:'short'
  }).format(d);
}
function base(v){const s=String(v||'').trim().toUpperCase().replace(/^\//,'');return s.startsWith('ES')||s.startsWith('MES')?'ES':s.startsWith('NQ')||s.startsWith('MNQ')?'NQ':s;}
function quote(root){return state.quotes.find(x=>String(x.symbol||'').trim().toUpperCase()===root)||state.quotes.find(x=>base(x.symbol)===root)||{};}
function quotePrice(root){return Number(quote(root).last);}
function health(name){return state.health.find(x=>x.service===name)||{};}
function tone(s){s=String(s||'WAITING').toUpperCase();return ['LIVE','READY'].includes(s)?'live':['ERROR','DEGRADED'].includes(s)?'error':'waiting';}
function badge(id,h,label){const n=$(id);if(!n)return;const s=String(h.status||'WAITING').toUpperCase();n.className=`badge ${tone(s)}`;n.textContent=`${label} ${s}`;}
function toast(m){const n=$('toast');if(!n)return;n.textContent=m;n.classList.remove('hidden');clearTimeout(n._t);n._t=setTimeout(()=>n.classList.add('hidden'),2200);}
function setTab(t){$$('.tab').forEach(x=>x.classList.toggle('active',x.dataset.tab===t));$$('.tab-panel').forEach(x=>x.classList.toggle('active',x.id===`tab-${t}`));setTimeout(()=>state.chart?.applyOptions({width:$('marketChart')?.clientWidth||900}),30);}
function schedule(key,fn,delay){clearTimeout(state.fetchTimers[key]);state.fetchTimers[key]=setTimeout(()=>{delete state.fetchTimers[key];if(state.session)void fn();},delay);}

function rowPayload(r){return r.payload||{};}
function directCompletedBars(root,tf){
  const now=Date.now(),aliases=TF_ALIASES[tf]||[tf];
  return state.bars.filter(r=>r.data_type==='ohlcv'&&base(r.symbol)===root&&aliases.includes(String(r.timeframe))&&Number(r.bar_close_ms)<=now).map(r=>{
    const p=rowPayload(r);
    return {time:Math.floor(Number(r.bar_open_ms)/1000),openMs:Number(r.bar_open_ms),closeMs:Number(r.bar_close_ms),open:Number(p.open),high:Number(p.high),low:Number(p.low),close:Number(p.close),volume:Number(p.volume||0)};
  }).filter(x=>[x.time,x.openMs,x.closeMs,x.open,x.high,x.low,x.close].every(Number.isFinite)).sort((a,b)=>a.openMs-b.openMs);
}
function aggregateFromOneMinute(root,tf){
  const one=directCompletedBars(root,'1m');if(tf==='1m'||!one.length)return one;const width=TF_MIN[tf];if(!width)return[];const groups=new Map,sessionMinutes=23*60;
  for(const b of one){const info=sessionTradingDayKey(b.openMs);if(info.minute>=16*60&&info.minute<17*60)continue;const elapsed=info.minute>=17*60?info.minute-17*60:(24*60-17*60)+info.minute,bucket=Math.floor(elapsed/width),key=`${info.key}|${bucket}`;if(!groups.has(key))groups.set(key,{bucket,rows:[]});groups.get(key).rows.push(b);}
  const out=[];for(const {bucket,rows} of groups.values()){rows.sort((a,b)=>a.openMs-b.openMs);const expected=tf==='1d'?sessionMinutes:Math.max(1,Math.min(width,sessionMinutes-bucket*width));if(rows.length/expected<0.95)continue;out.push({time:rows[0].time,openMs:rows[0].openMs,closeMs:rows[rows.length-1].closeMs,open:rows[0].open,high:Math.max(...rows.map(x=>x.high)),low:Math.min(...rows.map(x=>x.low)),close:rows[rows.length-1].close,volume:rows.reduce((a,x)=>a+(Number.isFinite(x.volume)?x.volume:0),0)});}return out.sort((a,b)=>a.openMs-b.openMs);
}
function completedBars(root,tf){const direct=directCompletedBars(root,tf);return direct.length?direct:aggregateFromOneMinute(root,tf);}
function emaSeries(bars,length){
  if(!bars.length)return[];const a=2/(length+1);let x=null,out=[];
  for(const b of bars){x=x==null?b.close:(a*b.close+(1-a)*x);out.push({time:b.time,value:x});}
  return out;
}
function sessionTradingDayKey(ms){
  const z=cfg.timezone||'America/Chicago';
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:z,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(ms)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
  let y=Number(parts.year),m=Number(parts.month),d=Number(parts.day),hh=Number(parts.hour),mm=Number(parts.minute);
  const q=new Date(Date.UTC(y,m-1,d));if(hh>=17)q.setUTCDate(q.getUTCDate()+1);
  return {key:q.toISOString().slice(0,10),minute:hh*60+mm};
}
function sessionVwapSeries(bars){
  let key=null,pv=0,vol=0,out=[];
  for(const b of bars){const k=sessionTradingDayKey(b.openMs).key;if(k!==key){key=k;pv=0;vol=0;}const v=Number(b.volume),tp=(b.high+b.low+b.close)/3;if(Number.isFinite(v)&&v>0){pv+=tp*v;vol+=v;}if(vol>0)out.push({time:b.time,value:pv/vol});}
  return out;
}

// TradingView/Pine ta.supertrend(factor=3, atrPeriod=10) semantics.
function pineRma(values,length){
  const out=Array(values.length).fill(null);let run=[];let seed=-1;
  for(let i=0;i<values.length;i++){
    const v=values[i];if(Number.isFinite(v))run.push(v);else run=[];
    if(run.length===length){seed=i;out[i]=run.reduce((a,b)=>a+b,0)/length;break;}
  }
  if(seed<0)return out;const alpha=1/length;
  for(let i=seed+1;i<values.length;i++)out[i]=Number.isFinite(values[i])?alpha*values[i]+(1-alpha)*out[i-1]:null;
  return out;
}
function supertrendState(bars,length=10,factor=3){
  if(bars.length<length+2)return'WAITING';
  const tr=bars.map((b,i)=>i===0?b.high-b.low:Math.max(b.high-b.low,Math.abs(b.high-bars[i-1].close),Math.abs(b.low-bars[i-1].close)));
  const atr=pineRma(tr,length),upper=Array(bars.length).fill(null),lower=Array(bars.length).fill(null),st=Array(bars.length).fill(null),dir=Array(bars.length).fill(null);
  for(let i=0;i<bars.length;i++){
    if(!Number.isFinite(atr[i]))continue;
    let ub=(bars[i].high+bars[i].low)/2+factor*atr[i],lb=(bars[i].high+bars[i].low)/2-factor*atr[i];
    const prevLb=i>0&&Number.isFinite(lower[i-1])?lower[i-1]:lb,prevUb=i>0&&Number.isFinite(upper[i-1])?upper[i-1]:ub;
    if(i>0){lb=(lb>prevLb||bars[i-1].close<prevLb)?lb:prevLb;ub=(ub<prevUb||bars[i-1].close>prevUb)?ub:prevUb;}
    lower[i]=lb;upper[i]=ub;
    if(i===0||!Number.isFinite(atr[i-1]))dir[i]=1;
    else if(st[i-1]===upper[i-1])dir[i]=bars[i].close>ub?-1:1;
    else dir[i]=bars[i].close<lb?1:-1;
    st[i]=dir[i]===-1?lb:ub;
  }
  const d=[...dir].reverse().find(Number.isFinite);return d===-1?'BULL':'BEAR';
}

function deltaFromPayload(p){
  for(const k of ['FP_Delta','delta','delta_volume','volume_delta','bid_ask_delta','net_delta']){const v=Number(p?.[k]);if(Number.isFinite(v))return v;}
  const ask=Number(p?.ask_volume??p?.buy_volume??p?.volume_ask),bid=Number(p?.bid_volume??p?.sell_volume??p?.volume_bid);
  return Number.isFinite(ask)&&Number.isFinite(bid)?ask-bid:null;
}
function footprintRows(root){
  const now=Date.now();return state.footprints.filter(r=>base(r.symbol)===root&&String(r.timeframe)==='1m'&&Number(r.bar_close_ms)<=now).sort((a,b)=>Number(a.bar_open_ms)-Number(b.bar_open_ms));
}
function deltaSnapshot(root,tf){
  const bars=completedBars(root,tf);if(!bars.length)return null;const target=bars[bars.length-1];
  const one=completedBars(root,'1m'),volMap=new Map(one.map(b=>[b.openMs,b.volume]));
  const rows=footprintRows(root).filter(r=>Number(r.bar_open_ms)>=target.openMs&&Number(r.bar_open_ms)<target.closeMs);
  if(!rows.length)return null;
  let net=0,total=0,used=0;
  for(const r of rows){const p=rowPayload(r),d=deltaFromPayload(p);let v=Number(p.FP_Total_Volume??p.total_volume??p.volume);if(!Number.isFinite(v)||v<=0)v=Number(volMap.get(Number(r.bar_open_ms)));
    if(Number.isFinite(d)&&Number.isFinite(v)&&v>0){net+=d;total+=v;used++;continue;}
    const dp=Number(p.FP_Delta_Pct);if(Number.isFinite(dp)&&Number.isFinite(v)&&v>0){net+=(dp/100)*v;total+=v;used++;}
  }
  return used&&total>0?100*net/total:null;
}

function quoteTimestamp(root){const q=quote(root),x=q.updated_at||q.timestamp;const ms=x?new Date(x).getTime():Date.now();return Number.isFinite(ms)?ms:Date.now();}
function updateLiveMinute(root){
  const px=quotePrice(root);if(!Number.isFinite(px))return null;const ms=quoteTimestamp(root),openMs=Math.floor(ms/60000)*60000,closeMs=openMs+60000,map=state.liveMinutes[root];let b=map.get(openMs);
  if(!b){const one=completedBars(root,'1m'),prior=one.length?one[one.length-1]:null;const old=[...map.values()].filter(x=>x.openMs<openMs).sort((a,b)=>b.openMs-a.openMs)[0];const o=Number.isFinite(prior?.close)?prior.close:Number.isFinite(old?.close)?old.close:px;b={openMs,closeMs,time:Math.floor(openMs/1000),open:o,high:px,low:px,close:px};map.set(openMs,b);}else{b.high=Math.max(b.high,px);b.low=Math.min(b.low,px);b.close=px;}
  for(const k of map.keys())if(k<openMs-26*3600000)map.delete(k);return b;
}
function formingBucket(root,tf){
  const current=updateLiveMinute(root);if(!current)return null;const info=sessionTradingDayKey(current.openMs);if(info.minute>=16*60&&info.minute<17*60)return null;
  if(tf==='1m')return current;
  const width=TF_MIN[tf];if(!width)return null;
  // Full exchange session is anchored at 17:00 CT. Subtract local elapsed-minute
  // remainder from the quote timestamp; this is display-only and never model input.
  let elapsed=info.minute>=17*60?info.minute-17*60:(24*60-17*60)+info.minute;
  const rem=elapsed%width,sec=new Date(current.openMs).getUTCSeconds();
  const bucketOpen=current.openMs-rem*60000-sec*1000;
  const bucketEnd=Math.min(bucketOpen+width*60000,bucketOpen+(TF_MIN[tf]||width)*60000);
  const one=completedBars(root,'1m').filter(b=>b.openMs>=bucketOpen&&b.openMs<bucketEnd),tmp=[...one.map(x=>({...x})),current].filter(x=>x.openMs>=bucketOpen&&x.openMs<bucketEnd).sort((a,b)=>a.openMs-b.openMs);
  if(!tmp.length)return null;return{time:Math.floor(bucketOpen/1000),openMs:bucketOpen,closeMs:bucketEnd,open:tmp[0].open,high:Math.max(...tmp.map(x=>x.high)),low:Math.min(...tmp.map(x=>x.low)),close:tmp[tmp.length-1].close};
}
function updateFormingChart(){if(!state.candles)return;const f=formingBucket(state.symbol,state.tf);if(!f)return;const closed=completedBars(state.symbol,state.tf),last=closed[closed.length-1];if(last&&f.time<=last.time)return;try{state.candles.update({time:f.time,open:f.open,high:f.high,low:f.low,close:f.close});}catch(e){console.warn('forming candle',e);}}

function currentPlan(root){
  const rows=state.events.filter(e=>e.root===root&&e.v2_decision==='TRADE');
  return rows.find(e=>['WAIT_NEXT_BAR','FILLED','OPEN'].includes(e.execution_state))||state.events.find(e=>e.root===root)||null;
}
function renderDecisions(){
  const cards=['ES','NQ'].map(root=>{const e=currentPlan(root),q=quotePrice(root);if(!e)return`<article class="decision-card waiting"><div class="decision-head"><div><span>${root}</span><h3>WAITING</h3></div><strong>${fmt(q)}</strong></div><p>No EMA/CCI Transition decision yet.</p></article>`;
    const terminalNoTrade=['NON_EVALUABLE_SESSION_BOUNDARY','INVALID_STOP','NO_FILL'].includes(e.execution_state),trade=e.v2_decision==='TRADE'&&!terminalNoTrade,displayDecision=terminalNoTrade?'NO TRADE':e.v2_decision,market=e.entry_method==='NEXT_BAR_MARKET',entry=e.actual_fill_price??e.planned_entry_price,stop=e.actual_stop_price??e.planned_stop_price,target=e.actual_target_price??e.planned_target_price;
    return`<article class="decision-card ${trade?'trade':'skip'}" data-event-card="${esc(e.event_id)}"><div class="decision-head"><div><span>${root} · ${esc(e.timeframe)} · ${esc(e.direction)}</span><h3>${esc(displayDecision)}</h3></div><div><strong>${esc(e.production_quality||'—')}</strong><small>${fmt(q)}</small></div></div><div class="decision-kpis"><div><span>P(TP)</span><strong>${pct(e.v2_p_tp)}</strong></div><div><span>GAM EV</span><strong>${Number(e.gam_predicted_ev)>=0?'+':''}${fmt(e.gam_predicted_ev,3)}R</strong></div><div><span>Signal</span><strong>${esc(e.signal)}</strong></div><div><span>Session</span><strong>${esc(e.session_scope)}</strong></div></div>${trade?`<div class="plan-grid"><div><span>Entry</span><strong>${Number.isFinite(Number(entry))?fmt(entry):market?'MARKET · NEXT BAR':'—'}</strong><small>${esc(e.entry_method)}</small></div><div><span>Stop</span><strong>${fmt(stop)}</strong><small>${esc(e.stop_method)}</small></div><div><span>Target</span><strong>${Number.isFinite(Number(target))?fmt(target):`${fmt(e.target_r,1)}R · fill-dependent`}</strong><small>${fmt(e.target_r,1)}R</small></div><div><span>State</span><strong>${esc(e.execution_state)}</strong><small>${e.entry_valid_until?`valid to ${ct(e.entry_valid_until)}`:''}</small></div></div>`:`<div class="state-pill">${esc(e.execution_state)}</div>`}</article>`;});
  $('decisionGrid').innerHTML=cards.join('');const latest=state.events[0];$('modelThrough').textContent=latest?`Model through ${ct(latest.signal_close_utc)} completed signal bar · forming price is display-only`:'Completed bars only · waiting for model state';
}
function renderQueue(){syncQueueControls();const filtered=queueFilteredEvents(),rows=filtered.slice(0,50),count=$('setupQueueCount');if(count)count.textContent=`Showing ${rows.length} of ${filtered.length} matching - ${state.events.length} loaded`;$('setupRows').innerHTML=rows.map(e=>`<tr data-event-id="${esc(e.event_id)}" class="${e.event_id===state.selectedEvent?'selected':''}"><td>${ct(e.signal_close_utc)}</td><td><strong>${esc(e.root)}</strong></td><td>${esc(e.timeframe)}</td><td>${esc(e.direction)}</td><td class="${e.v2_decision==='TRADE'?'good':''}">${esc(e.v2_decision)}</td><td>${esc(e.production_quality||'—')}</td><td>${pct(e.v2_p_tp)}</td><td>${fmt(e.gam_predicted_ev,3)}R</td><td>${esc(e.execution_state)}</td></tr>`).join('')||'<tr><td colspan="9">No signals match the current filters.</td></tr>';}
function renderHistory(){$('historyRows').innerHTML=state.events.slice(0,500).map(e=>{const entry=e.actual_fill_price??e.planned_entry_price,stop=e.actual_stop_price??e.planned_stop_price,target=e.actual_target_price??e.planned_target_price;return`<tr data-event-id="${esc(e.event_id)}"><td>${ct(e.signal_close_utc)}</td><td>${esc(e.root)}</td><td>${esc(e.timeframe)}</td><td>${esc(e.signal)}</td><td>${esc(e.v2_decision)}</td><td>${pct(e.v2_p_tp)}</td><td>${esc(e.production_quality||'—')}</td><td>${e.entry_method==='NEXT_BAR_MARKET'&&!Number.isFinite(Number(entry))?'MARKET':fmt(entry)}</td><td>${fmt(stop)}</td><td>${Number.isFinite(Number(target))?fmt(target):fmt(e.target_r,1)+'R'}</td><td>${esc(e.execution_state)}</td><td>${esc(e.outcome||'—')}</td></tr>`;}).join('');}
function renderSupertrend(){$('supertrendGrid').innerHTML=ST_TFS.map(tf=>{const s=supertrendState(completedBars('ES',tf),10,3),c=s==='BULL'?'bull':s==='BEAR'?'bear':'';return`<div class="snapshot-cell ${c}"><span>${tf}</span><strong>${s}</strong><small>${completedBars('ES',tf).length?'completed':'waiting'}</small></div>`;}).join('');}
function renderDelta(){let html='<div class="delta-table"><div></div>'+DELTA_TFS.map(t=>`<div class="delta-cell"><strong>${t}</strong></div>`).join('');for(const root of ['ES','NQ']){html+=`<div class="delta-cell"><strong>${root}</strong></div>`;for(const tf of DELTA_TFS){const v=deltaSnapshot(root,tf),c=v==null?'':v>=0?'bull':'bear';html+=`<div class="delta-cell ${c}"><strong>${v==null?'WAIT':v>=0?'BULL':'BEAR'}</strong><span class="v">${v==null?'—':(v>=0?'+':'')+v.toFixed(1)+'%'}</span></div>`;}}$('deltaSnapshot').innerHTML=html+'</div>';}
function selected(){return state.events.find(x=>x.event_id===state.selectedEvent)||state.events[0]||null;}
function renderContext(){const e=selected();if(!e){$('selectedContext').innerHTML='<p class="muted">Select a setup.</p>';$('rawEvent').textContent='';return;}state.selectedEvent=e.event_id;const c=e.context_summary||{},val=(x,s='')=>Number.isFinite(Number(x))?fmt(x,2)+s:'—';const items=[['Room to obstacle',val(c.room_to_nearest_obstacle_r,'R')],['VWAP side',c.price_above_vwap==null?'—':c.price_above_vwap?'Above':'Below'],['VWAP slope 15m',val(c.vwap_slope_15m_atr,' ATR')],['PDH',val(c.prior_day_high_signed_r_dir,'R')],['PDL',val(c.prior_day_low_signed_r_dir,'R')],['ONH',val(c.overnight_high_signed_r_dir,'R')],['ONL',val(c.overnight_low_signed_r_dir,'R')],['OR30 High',val(c.or30_high_signed_r_dir,'R')],['OR30 Low',val(c.or30_low_signed_r_dir,'R')],['Time bucket',c.time_of_day_bucket||'—'],['Same-TF FVG',c.v2_fvg_same_opposing_present?'Opposing':c.v2_fvg_same_aligned_present?'Aligned':'None'],['Same-TF S/R',c.v2_sr_geo_same_opposing_present?'Opposing':c.v2_sr_geo_same_supportive_present?'Supportive':'None']];$('selectedContext').innerHTML=items.map(([a,b])=>`<div><span>${esc(a)}</span><strong>${esc(b)}</strong></div>`).join('');$('rawEvent').textContent=JSON.stringify(e,null,2);}

function clearLines(){for(const l of state.priceLines){try{state.candles.removePriceLine(l);}catch{}}state.priceLines=[];}
function ensureChart(){if(state.chart)return;const host=$('marketChart');state.chart=LightweightCharts.createChart(host,{width:host.clientWidth,height:590,layout:{background:{color:'#0d151c'},textColor:'#9bb0bf'},grid:{vertLines:{color:'#17232c'},horzLines:{color:'#17232c'}},localization:{locale:'en-US',timeFormatter:chartCrosshairTime},timeScale:{timeVisible:true,secondsVisible:false,tickMarkFormatter:chartTickMark}});state.candles=state.chart.addSeries(LightweightCharts.CandlestickSeries,{upColor:'#33b88a',downColor:'#e66d74',borderVisible:false,wickUpColor:'#33b88a',wickDownColor:'#e66d74'});state.ema9=state.chart.addSeries(LightweightCharts.LineSeries,{lineWidth:2,priceLineVisible:false,lastValueVisible:false});state.ema21=state.chart.addSeries(LightweightCharts.LineSeries,{lineWidth:2,priceLineVisible:false,lastValueVisible:false});state.vwap=state.chart.addSeries(LightweightCharts.LineSeries,{lineWidth:1,priceLineVisible:false,lastValueVisible:false});}
function setModelMarkers(){if(!state.candles)return;const bars=completedBars(state.symbol,state.tf),byClose=new Map(bars.map(b=>[b.closeMs,b.time]));const rows=state.events.filter(e=>e.root===state.symbol&&e.timeframe===state.tf).slice(0,80).map(e=>{const closeMs=new Date(e.signal_close_utc).getTime(),time=byClose.get(closeMs);return{time,position:e.direction==='LONG'?'belowBar':'aboveBar',shape:e.direction==='LONG'?'arrowUp':'arrowDown',text:`${e.v2_decision} ${e.production_quality||''}`.trim()};}).filter(m=>Number.isFinite(m.time)).sort((a,b)=>a.time-b.time);try{if(state.markerApi?.setMarkers)state.markerApi.setMarkers(rows);else if(window.LightweightCharts.createSeriesMarkers)state.markerApi=window.LightweightCharts.createSeriesMarkers(state.candles,rows);}catch(e){console.warn('markers',e);}}
function renderChart(forceFit=false){ensureChart();const key=`${state.symbol}|${state.tf}`,b=completedBars(state.symbol,state.tf);state.candles.setData(b.map(x=>({time:x.time,open:x.open,high:x.high,low:x.low,close:x.close})));state.ema9.setData(state.visibility.ema9?emaSeries(b,9):[]);state.ema21.setData(state.visibility.ema21?emaSeries(b,21):[]);state.vwap.setData(state.visibility.vwap?sessionVwapSeries(b):[]);clearLines();setModelMarkers();const e=selected();if(e&&e.root===state.symbol&&e.timeframe===state.tf&&state.visibility.trades&&e.v2_decision==='TRADE'){
    const entry=e.actual_fill_price??e.planned_entry_price,stop=e.actual_stop_price??e.planned_stop_price,target=e.actual_target_price??e.planned_target_price;
    for(const [p,title] of [[entry,'ENTRY'],[stop,'SL'],[target,'TP']])if(Number.isFinite(Number(p)))state.priceLines.push(state.candles.createPriceLine({price:Number(p),lineWidth:2,axisLabelVisible:true,title}));
  }
  updateFormingChart();if(forceFit||state.chartKey!==key)state.chart.timeScale().fitContent();state.chartKey=key;$('chartTitle').textContent=`${state.symbol} · ${state.tf}`;$('chartStatus').textContent=`${b.length} completed ${state.tf} bars · forming quote candle is display-only · model inputs remain completed-bar-only`;}

async function fetchQuotes(){
  if(!state.session)return;
  const q=await client.from('market_quotes_live').select('symbol,contract,last,bid,ask,updated_at');
  if(q.error){console.warn(q.error);return;}
  state.quotes=q.data||[];
  badge('feedBadge',health('market_feed'),'FEED');
  updateFormingChart();
  window.dispatchEvent(new CustomEvent('fm-market-quotes-updated',{detail:{quotes:state.quotes}}));
}
async function fetchHealth(){
  if(!state.session)return;
  const h=await client.from('service_health')
    .select('service,status,message,updated_at,metadata')
    .in('service',['market_feed','ema_cci_v2_model']);
  if(h.error){console.warn(h.error);return;}
  state.health=h.data||[];
  badge('feedBadge',health('market_feed'),'FEED');
  badge('modelBadge',health('ema_cci_v2_model'),'EMA/CCI');
  if($('rawHealth'))$('rawHealth').textContent=JSON.stringify(state.health,null,2);
}
const EVENT_FIELDS=[
  'event_id','root','contract','timeframe','session_scope','signal','direction','signal_close_utc',
  'trading_day','signal_segment','gam_predicted_ev','gam_policy','entry_method','stop_method','target_r',
  'v2_p_tp','v2_decision','base_quality','production_quality','v2_entry_proxy_price',
  'planned_entry_price','planned_stop_price','planned_target_price','risk_points',
  'execution_state','entry_valid_until','actual_fill_price','actual_stop_price','actual_target_price',
  'resolved_at','outcome','context_summary','updated_at'
].join(',');
async function fetchEvents(){
  if(!state.session)return;
  const e=await client.from('ema_cci_v2_events')
    .select(EVENT_FIELDS).order('signal_close_utc',{ascending:false}).limit(150);
  if(e.error){console.warn(e.error);return;}
  state.events=e.data||[];
  if(!state.selectedEvent&&state.events[0])state.selectedEvent=state.events[0].event_id;
}
function marketRowKey(x){return `${x.data_type}|${String(x.symbol)}|${String(x.timeframe)}|${Number(x.bar_open_ms)}`;}
function mergeRows(existing,incoming,maxRows=12000){
  const m=new Map((existing||[]).map(x=>[marketRowKey(x),x]));
  for(const x of incoming||[])m.set(marketRowKey(x),x);
  return [...m.values()].sort((a,b)=>Number(a.bar_open_ms)-Number(b.bar_open_ms)).slice(-maxRows);
}
function mergeQuoteRow(row){
  if(!row)return;
  const key=String(row.symbol||'').trim().toUpperCase();
  const i=state.quotes.findIndex(x=>String(x.symbol||'').trim().toUpperCase()===key);
  if(i>=0)state.quotes[i]={...state.quotes[i],...row};else state.quotes.push(row);
  updateFormingChart();
  window.dispatchEvent(new CustomEvent('fm-market-quotes-updated',{detail:{quotes:state.quotes}}));
}
function mergeHealthRow(row){
  if(!row||!['market_feed','ema_cci_v2_model'].includes(String(row.service)))return;
  const i=state.health.findIndex(x=>x.service===row.service);
  if(i>=0)state.health[i]={...state.health[i],...row};else state.health.push(row);
  badge('feedBadge',health('market_feed'),'FEED');
  badge('modelBadge',health('ema_cci_v2_model'),'EMA/CCI');
  if($('rawHealth'))$('rawHealth').textContent=JSON.stringify(state.health,null,2);
}
function mergeEventRow(row){
  if(!row||!row.event_id)return;
  const i=state.events.findIndex(x=>x.event_id===row.event_id);
  if(i>=0)state.events[i]={...state.events[i],...row};else state.events.unshift(row);
  state.events.sort((a,b)=>new Date(b.signal_close_utc)-new Date(a.signal_close_utc));
  state.events=state.events.slice(0,150);
  if(!state.selectedEvent)state.selectedEvent=row.event_id;
}
async function fetchExact(table,symbol,tf,type,max=250){
  const r=await client.from(table)
    .select('data_type,symbol,timeframe,bar_open_ms,bar_close_ms,payload,received_at')
    .eq('data_type',type).eq('symbol',symbol).eq('timeframe',tf)
    .order('bar_open_ms',{ascending:false}).limit(max);
  if(r.error)return{rows:[],error:r.error};
  return{rows:r.data||[],error:null};
}
async function fetchFrame(root,tf,type,max,table='market_bars_live'){
  for(const symbol of ALIASES[root])for(const sourceTf of (TF_ALIASES[tf]||[tf])){
    const z=await fetchExact(table,symbol,sourceTf,type,max);
    if(z.error){console.warn(table,root,sourceTf,z.error);continue;}
    if(z.rows.length)return z.rows;
  }
  return[];
}
async function fetchMarketBootstrap(){
  if(!state.session)return;
  const seq=++state.barsSeq,specs=[];
  for(const root of ['ES','NQ'])for(const tf of ST_TFS)specs.push([root,tf]);
  const barSets=await Promise.all(specs.map(([r,t])=>fetchFrame(r,t,'ohlcv',t==='1m'?720:180)));
  const fpSets=await Promise.all(['ES','NQ'].map(async root=>{
    const [legacy,live]=await Promise.all([
      fetchFrame(root,'1m','footprint',80,'tv_market_bars'),
      fetchFrame(root,'1m','footprint',80,'market_bars_live')
    ]);
    const m=new Map;for(const x of legacy)m.set(Number(x.bar_open_ms),x);for(const x of live)m.set(Number(x.bar_open_ms),x);
    return [...m.values()];
  }));
  if(seq!==state.barsSeq)return;
  state.bars=mergeRows([],barSets.flat(),8000);
  state.footprints=mergeRows([],fpSets.flat(),500);
  state.marketBootstrapped=true;
}
async function fetchMarketIncremental(){
  if(!state.session||!state.marketBootstrapped)return fetchMarketBootstrap();
  const now=Date.now(),lookback=10*60*1000,fpLookback=4*60*1000;
  const [bars,fp]=await Promise.all([
    client.from('market_bars_live')
      .select('data_type,symbol,timeframe,bar_open_ms,bar_close_ms,payload,received_at')
      .eq('data_type','ohlcv').gte('bar_close_ms',now-lookback).lte('bar_close_ms',now)
      .order('bar_close_ms',{ascending:true}).limit(500),
    client.from('market_bars_live')
      .select('data_type,symbol,timeframe,bar_open_ms,bar_close_ms,payload,received_at')
      .eq('data_type','footprint').eq('timeframe','1m')
      .gte('bar_close_ms',now-fpLookback).lte('bar_close_ms',now)
      .order('bar_close_ms',{ascending:true}).limit(100)
  ]);
  if(!bars.error)state.bars=mergeRows(state.bars,bars.data||[],8000);else console.warn(bars.error);
  if(!fp.error)state.footprints=mergeRows(state.footprints,fp.data||[],500);else console.warn(fp.error);
}
async function refreshAll(){
  if(!state.session)return;
  await Promise.all([
    fetchQuotes(),fetchHealth(),fetchEvents(),
    state.marketBootstrapped?fetchMarketIncremental():fetchMarketBootstrap()
  ]);
  render();
  window.dispatchEvent(new CustomEvent('fm-model-events-updated',{detail:{events:state.events}}));
}
function subscribe(){
  state.channel?.unsubscribe();
  state.channel=client.channel('ema-cci-v29-low-egress')
    .on('postgres_changes',{event:'*',schema:'public',table:'market_quotes_live'},payload=>{
      if(payload?.new)mergeQuoteRow(payload.new);
    })
    .on('postgres_changes',{event:'*',schema:'public',table:'service_health'},payload=>{
      if(payload?.new){mergeHealthRow(payload.new);renderDecisions();}
    })
    .on('postgres_changes',{event:'*',schema:'public',table:'ema_cci_v2_events'},payload=>{
      if(payload?.new){
        mergeEventRow(payload.new);render();
        window.dispatchEvent(new CustomEvent('fm-model-events-updated',{detail:{events:state.events}}));
      }
    })
    .on('postgres_changes',{event:'*',schema:'public',table:'market_bars_live'},payload=>{
      const row=payload?.new;
      if(!row)return;
      if(row.data_type==='ohlcv'){
        state.bars=mergeRows(state.bars,[row],8000);
        renderSupertrend();renderChart();
      }else if(row.data_type==='footprint'){
        state.footprints=mergeRows(state.footprints,[row],500);
        renderDelta();
      }
    }).subscribe();
}

document.addEventListener('click',e=>{
  const t=e.target.closest('.tab');if(t)setTab(t.dataset.tab);
  const r=e.target.closest('[data-event-id],[data-event-card]');if(r){state.selectedEvent=r.dataset.eventId||r.dataset.eventCard;const ev=selected();if(ev){state.symbol=ev.root;state.tf=ev.timeframe;$$('[data-symbol]').forEach(x=>x.classList.toggle('active',x.dataset.symbol===state.symbol));$$('[data-tf]').forEach(x=>x.classList.toggle('active',x.dataset.tf===state.tf));}renderContext();renderQueue();renderChart(true);}
  const s=e.target.closest('[data-symbol]');if(s){state.symbol=s.dataset.symbol;$$('[data-symbol]').forEach(x=>x.classList.toggle('active',x===s));renderChart(true);}
  const tf=e.target.closest('[data-tf]');if(tf){state.tf=tf.dataset.tf;$$('[data-tf]').forEach(x=>x.classList.toggle('active',x===tf));renderChart(true);}
  const ind=e.target.closest('[data-ind]');if(ind){const k=ind.dataset.ind;state.visibility[k]=!state.visibility[k];ind.classList.toggle('active',state.visibility[k]);renderChart();}
  if(e.target.closest('#refresh')||e.target.closest('#historyRefresh'))void refreshAll();
});
$('loginForm').addEventListener('submit',async e=>{e.preventDefault();$('loginError').textContent='';const{data,error}=await client.auth.signInWithPassword({email:$('loginEmail').value.trim(),password:$('loginPassword').value});if(error){$('loginError').textContent=error.message;return;}await show(data.session);});
$('signOut').addEventListener('click',async()=>{await client.auth.signOut();await show(null);});
document.addEventListener('click',e=>{
  if(e.target.closest('#setupQueueToggle')){
    queueUi.hidden=!queueUi.hidden;saveQueueUi();syncQueueControls();
  }
  if(e.target.closest('#queueFilterReset')){
    Object.assign(queueUi,{root:'ALL',tf:'ALL',side:'ALL',decision:'ALL',execState:'ALL'});
    saveQueueUi();renderQueue();
  }
});
document.addEventListener('change',e=>{
  const map={queueFilterRoot:'root',queueFilterTf:'tf',queueFilterSide:'side',queueFilterDecision:'decision',queueFilterState:'execState'};
  const key=map[e.target?.id];
  if(key){queueUi[key]=e.target.value;saveQueueUi();renderQueue();}
});
async function show(s){state.session=s;$('authShell').classList.toggle('hidden',!!s);$('appShell').classList.toggle('hidden',!s);if(s){await refreshAll();subscribe();}else{state.channel?.unsubscribe();state.channel=null;}}
setInterval(()=>{if($('clock'))$('clock').textContent=new Intl.DateTimeFormat('en-US',{timeZone:cfg.timezone||'America/Chicago',hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short'}).format(new Date());},1000);
setInterval(()=>state.session&&void fetchQuotes(),30000);
setInterval(()=>state.session&&void fetchHealth(),60000);
setInterval(()=>state.session&&void fetchEvents().then(()=>{renderDecisions();renderQueue();renderHistory();renderContext();}),300000);
setInterval(()=>state.session&&void fetchMarketIncremental().then(()=>{renderSupertrend();renderDelta();renderChart();}),60000);
window.addEventListener('resize',()=>state.chart?.applyOptions({width:$('marketChart')?.clientWidth||900}));
client.auth.getSession().then(({data})=>show(data.session));client.auth.onAuthStateChange((_e,s)=>show(s));
})();
