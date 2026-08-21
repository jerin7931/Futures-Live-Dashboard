(()=>{
'use strict';
const cfg=window.DASHBOARD_CONFIG||{}, $=id=>document.getElementById(id), $$=s=>[...document.querySelectorAll(s)];
if(!cfg.supabaseUrl||!cfg.supabasePublishableKey){document.body.innerHTML='config.js required';return;}
const client=window.supabase.createClient(cfg.supabaseUrl,cfg.supabasePublishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
const TFS=['5m','10m','15m','1h','4h'], ROOTS=['ES','NQ'], CACHE='fc_command_center_v32';
const state={session:null,quotes:[],rootQuotes:[],health:[],events:[],context:{tf_bars:[],mes_bars:[]},briefs:[],selectedEvent:null,selectedBriefId:null,channel:null,chart:null,candles:null,levelLines:[],cached:false,takeTradeEvent:null};
window.FM_ORDERFLOW_CLIENT=client;window.FM_ORDERFLOW_STATE=state;
const queueUi={hidden:false,root:'ALL',tf:'ALL',side:'ALL',decision:'ALL',execState:'ALL'};
try{Object.assign(queueUi,JSON.parse(localStorage.getItem('ema_cci_v29_queue_ui_v1')||'{}'));}catch{}
const saveQueue=()=>{try{localStorage.setItem('ema_cci_v29_queue_ui_v1',JSON.stringify(queueUi));}catch{}};
const fmt=(v,d=2)=>Number.isFinite(Number(v))?Number(v).toFixed(d):'—';
const pct=v=>Number.isFinite(Number(v))?`${(Number(v)*100).toFixed(1)}%`:'—';
const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const ct=v=>{try{return new Intl.DateTimeFormat('en-US',{timeZone:cfg.timezone||'America/Chicago',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(v));}catch{return'—';}};
const rootOf=s=>{s=String(s||'').toUpperCase();return s.startsWith('ES')||s.startsWith('MES')?'ES':s.startsWith('NQ')||s.startsWith('MNQ')?'NQ':s;};
const quote=s=>state.quotes.find(x=>String(x.symbol||'').toUpperCase()===s)||{};
const qprice=s=>Number(quote(s).last);
const rootQuote=s=>state.rootQuotes.find(x=>String(x.symbol||'').toUpperCase()===s)||{};
const rootQprice=s=>Number(rootQuote(s).last);
const microFor=root=>root==='ES'?'MES':'MNQ';
function microBasis(root){const m=qprice(microFor(root)),r=rootQprice(root);return Number.isFinite(m)&&Number.isFinite(r)?m-r:0;}
function microAdjusted(root,v){v=Number(v);return Number.isFinite(v)?v+microBasis(root):NaN;}
function setQuoteSnapshot(rows){
 const raw=rows||[];state.rootQuotes=raw.filter(x=>['ES','NQ'].includes(String(x.symbol||'').toUpperCase()));
 const mes=raw.find(x=>String(x.symbol||'').toUpperCase()==='MES')||{},mnq=raw.find(x=>String(x.symbol||'').toUpperCase()==='MNQ')||{};
 state.quotes=[mes,mnq,{...mes,symbol:'ES',contract:mes.contract||'MES'},{...mnq,symbol:'NQ',contract:mnq.contract||'MNQ'}].filter(x=>x&&x.symbol);
}
function applyQuoteRow(row){
 const sym=String(row?.symbol||'').toUpperCase();if(!sym)return;
 if(['ES','NQ'].includes(sym)){const i=state.rootQuotes.findIndex(x=>String(x.symbol||'').toUpperCase()===sym);if(i>=0)state.rootQuotes[i]={...state.rootQuotes[i],...row};else state.rootQuotes.push(row);return;}
 if(!['MES','MNQ'].includes(sym))return;
 const i=state.quotes.findIndex(x=>String(x.symbol||'').toUpperCase()===sym);if(i>=0)state.quotes[i]={...state.quotes[i],...row};else state.quotes.push(row);
 const root=sym==='MES'?'ES':'NQ',alias={...row,symbol:root};const j=state.quotes.findIndex(x=>String(x.symbol||'').toUpperCase()===root);if(j>=0)state.quotes[j]=alias;else state.quotes.push(alias);
}
const health=n=>state.health.find(x=>x.service===n)||{};
function tone(s){s=String(s||'WAITING').toUpperCase();return ['LIVE','READY'].includes(s)?'live':['ERROR','DEGRADED'].includes(s)?'error':'waiting';}
function badge(id,h,label){const n=$(id);if(!n)return;const s=String(h.status||'WAITING').toUpperCase();n.className=`badge ${tone(s)}`;n.textContent=`${label} ${s}`;}
function toast(m){const n=$('toast');if(!n)return;n.textContent=m;n.classList.remove('hidden');clearTimeout(n._t);n._t=setTimeout(()=>n.classList.add('hidden'),2200);}
function setTab(t){$$('.tab').forEach(x=>x.classList.toggle('active',x.dataset.tab===t));$$('.tab-panel').forEach(x=>x.classList.toggle('active',x.id===`tab-${t}`));if(t==='live')setTimeout(()=>state.chart?.applyOptions({width:$('mesChart')?.clientWidth||900}),50);}
function saveCache(){try{localStorage.setItem(CACHE,JSON.stringify({at:Date.now(),quotes:state.quotes,rootQuotes:state.rootQuotes,health:state.health,events:state.events,context:state.context,briefs:state.briefs}));}catch{}}
function loadCache(){try{const c=JSON.parse(localStorage.getItem(CACHE)||'null');if(!c)return false;Object.assign(state,{quotes:c.quotes||[],rootQuotes:c.rootQuotes||[],health:c.health||[],events:c.events||[],context:c.context||{tf_bars:[],mes_bars:[]},briefs:c.briefs||[],cached:true});return true;}catch{return false;}}

const EVENT_FIELDS=['event_id','root','contract','timeframe','session_scope','signal','direction','signal_close_utc','trading_day','signal_segment','gam_predicted_ev','gam_policy','entry_method','stop_method','target_r','v2_p_tp','v2_decision','base_quality','production_quality','v2_entry_proxy_price','planned_entry_price','planned_stop_price','planned_target_price','risk_points','execution_state','entry_valid_until','actual_fill_price','actual_stop_price','actual_target_price','filled_at','resolved_at','outcome','context_summary','updated_at'].join(',');

function eventStateGroup(e){const s=String(e.execution_state||'').toUpperCase();if(['WAIT_NEXT_BAR','TRADE_CANDIDATE','FILLED','OPEN'].includes(s))return'ACTIVE';if(s==='TP_HIT')return'TP_HIT';if(s==='SL_HIT')return'SL_HIT';if(s==='NO_FILL')return'NO_FILL';if(['V2_SKIP','GAM_SKIP'].includes(s))return'SKIPPED';return'OTHER';}
function eventPresentation(e){
 const s=String(e?.execution_state||'').toUpperCase(),d=String(e?.v2_decision||'SKIP').toUpperCase();
 if(['INVALID_STOP','NON_EVALUABLE_SESSION_BOUNDARY','NO_FILL'].includes(s))return{label:'NO TRADE',cls:'skip'};
 if(s==='WAIT_NEXT_BAR')return{label:'TRADE CANDIDATE',cls:'candidate'};
 if(d==='TRADE'&&['FILLED','OPEN','TP_HIT','SL_HIT','AMBIGUOUS','TIMEOUT'].includes(s))return{label:s.replaceAll('_',' '),cls:'trade'};
 return{label:d==='TRADE'?'TRADE':'NO TRADE',cls:d==='TRADE'?'trade':'skip'};
}
function probabilityClass(v){v=Number(v);return !Number.isFinite(v)?'p-na':v>=.55?'p-aplus':v>=.50?'p-a':v>=.45?'p-bplus':v>=.40?'p-b':'p-skip';}
function latestEvent(root,tf){return state.events.filter(e=>e.root===root&&e.timeframe===tf).sort((a,b)=>new Date(b.signal_close_utc)-new Date(a.signal_close_utc))[0]||null;}
function bars(root,tf){return (state.context.tf_bars||[]).filter(b=>b.symbol===root&&b.timeframe===tf).sort((a,b)=>Number(a.bar_open_ms)-Number(b.bar_open_ms));}
function pineRma(vals,n){const o=Array(vals.length).fill(null);if(vals.length<n)return o;let s=0;for(let i=0;i<n;i++)s+=vals[i];o[n-1]=s/n;for(let i=n;i<vals.length;i++)o[i]=vals[i]/n+(1-1/n)*o[i-1];return o;}
function supertrend(bs,n=10,f=3){
 if(bs.length<n+2)return'WAITING';
 const tr=bs.map((b,i)=>i===0?Number(b.high)-Number(b.low):Math.max(Number(b.high)-Number(b.low),Math.abs(Number(b.high)-Number(bs[i-1].close)),Math.abs(Number(b.low)-Number(bs[i-1].close))));
 const atr=pineRma(tr,n),up=[],lo=[],st=[],dir=[];
 for(let i=0;i<bs.length;i++){if(!Number.isFinite(atr[i])){up[i]=lo[i]=st[i]=dir[i]=null;continue;}let u=(Number(bs[i].high)+Number(bs[i].low))/2+f*atr[i],l=(Number(bs[i].high)+Number(bs[i].low))/2-f*atr[i];const pu=Number.isFinite(up[i-1])?up[i-1]:u,pl=Number.isFinite(lo[i-1])?lo[i-1]:l;if(i>0){l=(l>pl||Number(bs[i-1].close)<pl)?l:pl;u=(u<pu||Number(bs[i-1].close)>pu)?u:pu;}lo[i]=l;up[i]=u;if(i===0||!Number.isFinite(atr[i-1]))dir[i]=1;else if(st[i-1]===up[i-1])dir[i]=Number(bs[i].close)>u?-1:1;else dir[i]=Number(bs[i].close)<l?1:-1;st[i]=dir[i]===-1?l:u;}
 const d=[...dir].reverse().find(Number.isFinite);return d===-1?'BULLISH':d===1?'BEARISH':'WAITING';
}
function deltaFor(root,tf){const b=bars(root,tf);return b.length?Number(b[b.length-1].delta):NaN;}
function entryOf(e){for(const v of [e?.actual_fill_price,e?.planned_entry_price,e?.v2_entry_proxy_price])if(Number.isFinite(Number(v)))return Number(v);return NaN;}
function supportResistance(e){
 if(!e)return{support:NaN,resistance:NaN};const x=entryOf(e),risk=Number(e.risk_points),c=e.context_summary||{},supR=Number(c.v2_sr_geo_same_supportive_distance_r),oppR=Number(c.v2_sr_geo_same_opposing_distance_r);
 if(!Number.isFinite(x)||!Number.isFinite(risk))return{support:NaN,resistance:NaN};
 if(e.direction==='LONG')return{support:Number.isFinite(supR)?x-supR*risk:NaN,resistance:Number.isFinite(oppR)?x+oppR*risk:NaN};
 return{support:Number.isFinite(oppR)?x-oppR*risk:NaN,resistance:Number.isFinite(supR)?x+supR*risk:NaN};
}
function exitText(e){const s=String(e?.execution_state||'');if(s==='TP_HIT')return`TP HIT ${fmt(e.actual_target_price??e.planned_target_price)}`;if(s==='SL_HIT')return`SL HIT ${fmt(e.actual_stop_price??e.planned_stop_price)}`;if(s==='TIMEOUT')return'EXIT · TIMEOUT';if(s==='NO_FILL')return'NO FILL';return null;}
function signalCard(root,tf){
 const e=latestEvent(root,tf),bs=bars(root,tf),trend=supertrend(bs),delta=deltaFor(root,tf),sr=supportResistance(e),micro=microFor(root),live=qprice(micro);
 if(!e)return`<article class="signal-card empty"><div class="signal-card-top"><div><span class="root-label">${root}</span><strong>${tf.toUpperCase()}</strong><small class="micro-live">${micro} LIVE · ${fmt(live)}</small></div><span class="no-signal-pill">NO SIGNAL</span></div><div class="no-signal">No recent model signal</div><div class="context-row"><span>Trend <b>${trend}</b></span><span>Delta <b>${Number.isFinite(delta)?(delta>0?'+':'')+fmt(delta,0):'—'}</b></span></div></article>`;
 const p=eventPresentation(e),entry=entryOf(e),stop=e.actual_stop_price??e.planned_stop_price,target=e.actual_target_price??e.planned_target_price,exit=exitText(e);
 return`<article class="signal-card ${p.cls}">
   <div class="signal-card-top"><div><span class="root-label">${root}</span><strong>${tf.toUpperCase()}</strong><small class="micro-live">${micro} LIVE · ${fmt(live)}</small></div><div class="prob ${probabilityClass(e.v2_p_tp)}"><small>P(TP)</small><b>${pct(e.v2_p_tp)}</b><em>${esc(e.production_quality||'—')}</em></div></div>
   <div class="signal-action ${e.direction==='LONG'?'long':e.direction==='SHORT'?'short':''}">${p.label==='NO TRADE'?'NO TRADE':esc(e.direction)} <small>${esc(e.signal||'')}</small></div>
   <div class="trade-levels">
    <div class="entry"><span>MODEL ENTRY</span><strong>${fmt(entry)}</strong></div>
    <div class="target"><span>MODEL TARGET</span><strong>${fmt(target)}</strong></div>
    <div class="stop"><span>MODEL STOP</span><strong>${fmt(stop)}</strong></div>
   </div>
   ${exit?`<div class="exit-banner ${String(e.execution_state).toLowerCase()}">${esc(exit)}</div>`:''}
   <div class="context-row"><span>Trend <b class="${trend==='BULLISH'?'good':trend==='BEARISH'?'bad':''}">${trend}</b></span><span>Delta <b class="${delta>0?'good':delta<0?'bad':''}">${Number.isFinite(delta)?(delta>0?'+':'')+fmt(delta,0):'—'}</b></span></div>
   <div class="sr-row"><span>Resistance <b>${fmt(sr.resistance)}</b></span><span>Support <b>${fmt(sr.support)}</b></span></div>
   <div class="card-foot">Signal ${ct(e.signal_close_utc)} · ${esc(String(e.execution_state||'').replaceAll('_',' '))}</div>
 </article>`;
}
function renderMatrix(){$('signalMatrix').innerHTML=TFS.map(tf=>`<div class="tf-row"><div class="tf-label"><strong>${tf.toUpperCase()}</strong><small>completed bars</small></div>${signalCard('ES',tf)}${signalCard('NQ',tf)}</div>`).join('');}
function activityLabel(e){
 if(!e)return{label:'NO SIGNAL',cls:'none'};const st=String(e.execution_state||'').toUpperCase(),dir=String(e.direction||'').toUpperCase();
 if(['TP_HIT','SL_HIT','TIMEOUT','AMBIGUOUS'].includes(st))return{label:`${dir} · ${st.replaceAll('_',' ')}`,cls:st==='TP_HIT'?'won':st==='SL_HIT'?'lost':'closed'};
 if(['OPEN','FILLED'].includes(st))return{label:`${dir} · OPEN`,cls:dir==='LONG'?'long':'short'};
 if(st==='WAIT_NEXT_BAR'||st==='TRADE_CANDIDATE')return{label:`${dir} · WAITING`,cls:'waiting'};
 if(['V2_SKIP','GAM_SKIP','INVALID_STOP','NON_EVALUABLE_SESSION_BOUNDARY','NO_FILL'].includes(st))return{label:'NO TRADE',cls:'none'};
 return{label:`${dir||'SIGNAL'} · ${st.replaceAll('_',' ')||'ACTIVE'}`,cls:'waiting'};
}
function renderActivity(){
 const rootRow=root=>`<div class="activity-root"><div class="activity-root-name"><strong>${root}</strong><small>${microFor(root)} ${fmt(qprice(microFor(root)))}</small></div>${TFS.map(tf=>{const e=latestEvent(root,tf),a=activityLabel(e);return`<div class="activity-cell ${a.cls}"><span>${tf.toUpperCase()}</span><strong>${esc(a.label)}</strong><small>${e?ct(e.signal_close_utc):'—'}</small></div>`;}).join('')}</div>`;
 $('activityGrid').innerHTML=rootRow('ES')+rootRow('NQ');
}


function latestBrief(){return [...state.briefs].sort((a,b)=>new Date(b.brief_time)-new Date(a.brief_time))[0]||null;}

function chosenBrief(){return state.briefs.find(x=>x.id===state.selectedBriefId)||latestBrief();}
function inlineMd(s){
 let x=esc(s||'');
 x=x.replace(/\\([~&])/g,'$1');
 x=x.replace(/\[([^\]]+)\]\((https?:\/\/[^\s\)]+)(?:\s+&quot;[^&]*&quot;)?\)/g,'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
 x=x.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
 return x;
}
function markdownTable(lines){
 const cells=line=>line.trim().replace(/^\||\|$/g,'').split('|').map(x=>x.trim());
 const head=cells(lines[0]),rows=lines.slice(2).map(cells);
 return `<div class="market-table-wrap"><table class="market-table"><thead><tr>${head.map(x=>`<th>${inlineMd(x)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(x=>`<td>${inlineMd(x)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function markdownToHtml(md){
 const lines=String(md||'').replace(/\r/g,'').split('\n'),out=[];let i=0;
 while(i<lines.length){
  const l=lines[i];
  if(i+1<lines.length&&l.includes('|')&&/^\s*\|?\s*:?-+/.test(lines[i+1])){let t=[l,lines[i+1]];i+=2;while(i<lines.length&&lines[i].includes('|')&&lines[i].trim()){t.push(lines[i++]);}out.push(markdownTable(t));continue;}
  if(/^---+$/.test(l.trim())){out.push('<hr>');i++;continue;}
  const h=l.match(/^(#{1,3})\s+(.*)$/);if(h){const n=h[1].length;out.push(`<h${n}>${inlineMd(h[2])}</h${n}>`);i++;continue;}
  if(/^\s*-\s+/.test(l)){const items=[];while(i<lines.length&&/^\s*-\s+/.test(lines[i]))items.push(lines[i++].replace(/^\s*-\s+/,''));out.push(`<ul>${items.map(x=>`<li>${inlineMd(x)}</li>`).join('')}</ul>`);continue;}
  if(!l.trim()){i++;continue;}
  const p=[l];i++;while(i<lines.length&&lines[i].trim()&&!/^(#{1,3})\s+/.test(lines[i])&&!/^\s*-\s+/.test(lines[i])&&!/^---+$/.test(lines[i].trim())&&!(i+1<lines.length&&lines[i].includes('|')&&/^\s*\|?\s*:?-+/.test(lines[i+1])))p.push(lines[i++]);
  out.push(`<p>${p.map(inlineMd).join('<br>')}</p>`);
 }
 return out.join('');
}
function renderMarketUpdate(){
 const b=chosenBrief();
 if(!b){$('marketUpdateBody').innerHTML='<div class="empty-state">No market update stored yet.</div>';$('marketUpdateRaw').textContent='No market update stored yet.';$('marketUpdateArchive').innerHTML='';return;}
 $('marketUpdateTime').textContent=ct(b.brief_time);$('marketUpdateBias').textContent=b.daily_bias||'—';$('marketUpdateBias').className=`market-bias-pill ${biasTone(b.daily_bias)}`;$('marketUpdateRegime').textContent=b.regime||'—';
 const isTest=String(b.published_by||'').toLowerCase().includes('test');$('marketUpdateSource').textContent=isTest?'TEST UPDATE':'HOURLY UPDATE';$('marketUpdateSource').className=`source-pill ${isTest?'test':''}`;
 const md=b.full_markdown||b.summary||'';$('marketUpdateBody').innerHTML=markdownToHtml(md);$('marketUpdateRaw').textContent=md;
 $('marketUpdateArchive').innerHTML=[...state.briefs].sort((a,c)=>new Date(c.brief_time)-new Date(a.brief_time)).map(x=>`<button class="market-archive-item ${x.id===b.id?'active':''}" data-brief-id="${esc(x.id)}"><strong>${ct(x.brief_time)}</strong><span>${esc(x.daily_bias||'—')}</span><small>${esc(x.headline||x.regime||'Hourly market update')}</small></button>`).join('')||'<div class="empty-state">No saved updates.</div>';
}

function biasTone(b){b=String(b||'').toUpperCase();return b.includes('BULL')?'bull':b.includes('BEAR')?'bear':b.includes('NEUTRAL')||b.includes('RANGE')?'neutral':'waiting';}
function renderBias(){
 const b=latestBrief(),card=$('biasCard');if(!b){card.className='bias-card waiting';$('dailyBias').textContent='Waiting for market update';$('briefTime').textContent='—';$('briefFreshness').textContent='No hourly brief stored yet';return;}
 const tone=biasTone(b.daily_bias);card.className=`bias-card ${tone}`;$('dailyBias').textContent=b.daily_bias||'—';$('briefTime').textContent=ct(b.brief_time);$('briefFreshness').textContent=state.cached?'Cached view · reconnecting':'Latest hourly update';$('marketRegime').textContent=b.regime||'—';$('biasSummary').textContent=b.summary||b.headline||'—';$('bullScenario').textContent=b.bullish_scenario||'—';$('bearScenario').textContent=b.bearish_scenario||'—';$('fullBrief').textContent=b.full_markdown||b.summary||'No full brief stored.';$('biasChanged').classList.toggle('hidden',!b.bias_changed);
}
function normalizeLevels(){
 const b=latestBrief();if(!b||!Array.isArray(b.levels))return[];
 return b.levels.map((l,i)=>{const lo=Number(l.mes_low??l.mes_level??l.mes_price),hi=Number(l.mes_high??l.mes_level??l.mes_price);return{...l,_lo:lo,_hi:hi,_mid:Number.isFinite(lo)&&Number.isFinite(hi)?(lo+hi)/2:NaN,_i:i};}).filter(l=>Number.isFinite(l._mid));
}
function chartDate(time){if(typeof time==='number')return new Date(time*1000);if(time&&typeof time==='object'&&time.year)return new Date(Date.UTC(time.year,time.month-1,time.day));return new Date(time);}
function chartTime(time,withDate=true){try{const d=chartDate(time);return new Intl.DateTimeFormat('en-US',{timeZone:cfg.timezone||'America/Chicago',...(withDate?{month:'short',day:'numeric'}:{}),hour:'numeric',minute:'2-digit',hour12:true,timeZoneName:withDate?'short':undefined}).format(d);}catch{return'—';}}
function chartTick(time){try{return new Intl.DateTimeFormat('en-US',{timeZone:cfg.timezone||'America/Chicago',hour:'numeric',minute:'2-digit',hour12:true}).format(chartDate(time));}catch{return null;}}
function ensureMesChart(){
 if(state.chart||!$('mesChart')||!window.LightweightCharts)return;
 state.chart=LightweightCharts.createChart($('mesChart'),{height:470,width:$('mesChart').clientWidth||900,layout:{background:{color:'#0b1218'},textColor:'#8fa7b8'},grid:{vertLines:{color:'#17232d'},horzLines:{color:'#17232d'}},localization:{timeFormatter:t=>chartTime(t,true)},timeScale:{timeVisible:true,secondsVisible:false,tickMarkFormatter:t=>chartTick(t)},rightPriceScale:{borderColor:'#263945'}});
 state.candles=state.chart.addSeries(LightweightCharts.CandlestickSeries,{upColor:'#39c995',downColor:'#f06f78',borderVisible:false,wickUpColor:'#39c995',wickDownColor:'#f06f78'});
}
function levelColor(l){const t=String(l.type||l.status||'').toUpperCase();return t.includes('RESIST')?'#f06f78':t.includes('SUPPORT')||t.includes('RECLAIM')?'#39c995':'#e7b75b';}
function renderMesChart(fit=false){
 ensureMesChart();if(!state.candles)return;const mb=(state.context.mes_bars||[]).sort((a,b)=>Number(a.bar_open_ms)-Number(b.bar_open_ms));
 state.candles.setData(mb.map(b=>({time:Math.floor(Number(b.bar_open_ms)/1000),open:Number(b.open),high:Number(b.high),low:Number(b.low),close:Number(b.close)})));
 for(const l of state.levelLines)try{state.candles.removePriceLine(l);}catch{}state.levelLines=[];
 const levels=normalizeLevels();for(const l of levels){const color=levelColor(l),title=l.label||l.type||l.status||'AI level';for(const price of [...new Set([l._lo,l._hi].filter(Number.isFinite))])state.levelLines.push(state.candles.createPriceLine({price,color,lineWidth:2,lineStyle:l._lo!==l._hi?2:0,axisLabelVisible:true,title}));}
 $('levelList').innerHTML=levels.length?levels.sort((a,b)=>b._mid-a._mid).map(l=>`<div class="level-item" style="--level:${levelColor(l)}"><div><strong>${Number.isFinite(l._lo)&&l._lo!==l._hi?`${fmt(l._lo)}–${fmt(l._hi)}`:fmt(l._mid)}</strong><span>${esc(l.label||l.type||'Level')}</span></div><small>${esc(l.status||'ACTIVE')}</small></div>`).join(''):'<div class="empty-state">Waiting for the next hourly MES level map.</div>';
 const b=latestBrief();$('mesChartStatus').textContent=b?`Hourly map ${ct(b.brief_time)} · MES/SPX basis ${Number.isFinite(Number(b.mes_spx_basis))?(Number(b.mes_spx_basis)>=0?'+':'')+fmt(b.mes_spx_basis):'—'}`:'MES 5m candles · hourly AI levels not stored yet';
 if(fit||!state._fit){state.chart.timeScale().fitContent();state._fit=true;}
}
function renderHealth(){badge('feedBadge',health('market_feed'),'FEED');badge('modelBadge',health('ema_cci_v2_model'),'MODEL');const h=health('ema_cci_v2_model'),meta=h.metadata||{},evalt=meta.evaluated_through_utc;const age=h.updated_at?(Date.now()-new Date(h.updated_at))/1000:NaN;$('modelThrough').textContent=`${String(h.status||'').toUpperCase()==='LIVE'&&age<=90?'LIVE':'CHECKING'}${evalt?' · through '+ct(evalt):''}`;$('rawHealth').textContent=JSON.stringify(state.health,null,2);}
function takeTradeAllowed(e){return String(e?.v2_decision||'').toUpperCase()==='TRADE'&&!['INVALID_STOP','NON_EVALUABLE_SESSION_BOUNDARY','NO_FILL'].includes(String(e?.execution_state||'').toUpperCase());}
function renderQueue(){
 const rows=state.events.filter(e=>(queueUi.root==='ALL'||e.root===queueUi.root)&&(queueUi.tf==='ALL'||e.timeframe===queueUi.tf)&&(queueUi.side==='ALL'||e.direction===queueUi.side)&&(queueUi.decision==='ALL'||String(e.v2_decision).toUpperCase()===queueUi.decision)&&(queueUi.execState==='ALL'||eventStateGroup(e)===queueUi.execState));
 $('setupQueueCount').textContent=`${rows.length} of ${state.events.length} recent signals`;
 $('setupRows').innerHTML=rows.map(e=>`<tr data-event-id="${esc(e.event_id)}"><td>${ct(e.signal_close_utc)}</td><td>${e.root}</td><td>${e.timeframe}</td><td class="${e.direction==='LONG'?'good':'bad'}">${e.direction}</td><td>${eventPresentation(e).label}</td><td>${e.production_quality||'—'}</td><td class="${probabilityClass(e.v2_p_tp)}">${pct(e.v2_p_tp)}</td><td>${fmt(entryOf(e))}</td><td>${fmt(e.actual_stop_price??e.planned_stop_price)}</td><td>${fmt(e.actual_target_price??e.planned_target_price)}</td><td>${String(e.execution_state||'').replaceAll('_',' ')}</td><td>${takeTradeAllowed(e)?`<button class="take-trade-btn" data-take-trade="${esc(e.event_id)}">Took Trade</button>`:'—'}</td></tr>`).join('');
 $('setupQueueBody').classList.toggle('hidden',queueUi.hidden);$('setupQueueToggle').textContent=queueUi.hidden?'Show Queue':'Hide Queue';$('setupQueueToggle').setAttribute('aria-expanded',String(!queueUi.hidden));
 const map={queueFilterRoot:'root',queueFilterTf:'tf',queueFilterSide:'side',queueFilterDecision:'decision',queueFilterState:'execState'};for(const [id,k] of Object.entries(map))if($(id))$(id).value=queueUi[k];
}
function openTakeTrade(eventId){
 const e=state.events.find(x=>x.event_id===eventId);if(!e)return;state.takeTradeEvent=e;const micro=microFor(e.root),basis=microBasis(e.root),modelEntry=entryOf(e),modelStop=Number(e.actual_stop_price??e.planned_stop_price),modelTarget=Number(e.actual_target_price??e.planned_target_price),live=qprice(micro);
 $('takeTradeTitle').textContent=`${micro} ${e.direction} · ${e.root} ${e.timeframe} model signal`;
 $('takeTradeMeta').textContent=`P(TP) ${pct(e.v2_p_tp)} · ${e.production_quality||'—'} · current ${micro} ${fmt(live)} · micro/E-mini basis ${(basis>=0?'+':'')+fmt(basis)}`;
 $('takeInstrument').value=micro;$('takeDirection').value=e.direction;$('takeContracts').value='1';
 $('takeEntry').value=Number.isFinite(live)?live.toFixed(2):Number.isFinite(modelEntry)?microAdjusted(e.root,modelEntry).toFixed(2):'';
 $('takeStop').value=Number.isFinite(modelStop)?microAdjusted(e.root,modelStop).toFixed(2):'';
 $('takeTarget').value=Number.isFinite(modelTarget)?microAdjusted(e.root,modelTarget).toFixed(2):'';
 $('takeTradeHint').textContent=`Model levels: Entry ${fmt(modelEntry)} · SL ${fmt(modelStop)} · TP ${fmt(modelTarget)}. Execution fields are prefilled for ${micro}; edit them to your actual trade before saving.`;
 $('takeTradeError').textContent='';$('takeTradeModal').classList.remove('hidden');
}
function closeTakeTrade(){state.takeTradeEvent=null;$('takeTradeModal').classList.add('hidden');}
async function saveTakenTrade(){
 const e=state.takeTradeEvent;if(!e)return;const instrument=$('takeInstrument').value,direction=$('takeDirection').value,contracts=Number($('takeContracts').value),entry=Number($('takeEntry').value),stop=Number($('takeStop').value),targetRaw=$('takeTarget').value.trim(),target=targetRaw===''?NaN:Number(targetRaw),err=$('takeTradeError');err.textContent='';
 if(!Number.isInteger(contracts)||contracts<=0||![entry,stop].every(Number.isFinite)){err.textContent='Enter a valid entry, stop and contract count.';return;}
 if(direction==='LONG'?stop>=entry:stop<=entry){err.textContent='Stop must be on the correct side of the actual entry.';return;}
 try{
  const {data:dupe,error:de}=await client.from('trades').select('id,status').contains('entry_context',{model_event_id:e.event_id}).limit(1);if(de)throw de;if((dupe||[]).length){err.textContent='This model signal is already linked to a Journal trade.';return;}
  const {data:trade,error}=await client.rpc('start_trade',{p_instrument:instrument,p_direction:direction,p_entry_price:entry,p_stop_price:stop,p_contracts:contracts,p_market_snapshot_id:null,p_entry_context:{source:'COMMAND_CENTER_TAKE_TRADE',model_event_id:e.event_id,model_root:e.root,model_timeframe:e.timeframe,model_signal:e.signal,v2_p_tp:e.v2_p_tp,production_quality:e.production_quality,recorded_at:new Date().toISOString()},p_notes:`Taken from ${e.root} ${e.timeframe} ${e.signal||''} model signal`});if(error)throw error;
  if(Number.isFinite(target)&&trade?.id){const {error:te}=await client.rpc('add_trade_event',{p_trade_id:trade.id,p_event_type:'NOTE',p_quantity:null,p_price:null,p_stop_price:null,p_reason:'MANUAL',p_notes:`TARGET_UPDATE|${target}`,p_market_snapshot_id:null,p_context:{target_price:target,source:'COMMAND_CENTER_TAKE_TRADE',model_event_id:e.event_id}});if(te)throw te;}
  closeTakeTrade();toast(`${instrument} trade added to Journal`);window.dispatchEvent(new CustomEvent('fm-journal-refresh-request',{detail:{trade,event:e}}));
 }catch(x){err.textContent=String(x?.message||x).replace('ACTIVE_TRADE_ALREADY_EXISTS','An open Journal trade already exists. Close it before starting another.');}
}
function renderHistory(){$('historyRows').innerHTML=state.events.map(e=>`<tr data-event-id="${esc(e.event_id)}"><td>${ct(e.signal_close_utc)}</td><td>${e.root}</td><td>${e.timeframe}</td><td>${e.signal}</td><td>${eventPresentation(e).label}</td><td>${pct(e.v2_p_tp)}</td><td>${e.production_quality||'—'}</td><td>${fmt(entryOf(e))}</td><td>${fmt(e.actual_stop_price??e.planned_stop_price)}</td><td>${fmt(e.actual_target_price??e.planned_target_price)}</td><td>${String(e.execution_state||'').replaceAll('_',' ')}</td><td>${e.outcome||'—'}</td></tr>`).join('');}
function render(){renderBias();renderMarketUpdate();renderHealth();renderActivity();renderMatrix();renderMesChart();renderQueue();renderHistory();const s=state.events.find(e=>e.event_id===state.selectedEvent)||state.events[0];$('rawEvent').textContent=s?JSON.stringify(s,null,2):'No event selected.';}

async function fetchAll(){
 if(!state.session)return;const [q,h,e,c,b]=await Promise.all([
  client.from('market_quotes_live').select('symbol,contract,last,bid,ask,updated_at').in('symbol',['ES','NQ','MES','MNQ']),
  client.from('service_health').select('service,status,message,updated_at,metadata').in('service',['market_feed','ema_cci_v2_model']),
  client.from('ema_cci_v2_events').select(EVENT_FIELDS).order('signal_close_utc',{ascending:false}).limit(150),
  client.rpc('get_command_center_context'),
  client.from('market_briefs').select('*').order('brief_time',{ascending:false}).limit(8)
 ]);
 if(!q.error)setQuoteSnapshot(q.data||[]);else console.warn(q.error);
 if(!h.error)state.health=h.data||[];else console.warn(h.error);
 if(!e.error)state.events=e.data||[];else console.warn(e.error);
 if(!c.error)state.context=c.data||{tf_bars:[],mes_bars:[]};else console.warn(c.error);
 if(!b.error){state.briefs=b.data||[];if(!state.selectedBriefId&&state.briefs[0])state.selectedBriefId=state.briefs[0].id;}else console.warn(b.error);
 state.cached=false;if(!state.selectedEvent&&state.events[0])state.selectedEvent=state.events[0].event_id;saveCache();render();
 window.dispatchEvent(new CustomEvent('fm-market-quotes-updated',{detail:{quotes:state.quotes}}));window.dispatchEvent(new CustomEvent('fm-model-events-updated',{detail:{events:state.events}}));
}
function mergeBy(arr,row,key){const i=arr.findIndex(x=>x[key]===row[key]);if(i>=0)arr[i]={...arr[i],...row};else arr.unshift(row);}
function subscribe(){
 state.channel?.unsubscribe();state.channel=client.channel('command-center-v30')
 .on('postgres_changes',{event:'*',schema:'public',table:'market_quotes_live'},p=>{if(p.new&&['ES','NQ','MES','MNQ'].includes(p.new.symbol)){applyQuoteRow(p.new);renderActivity();renderMatrix();saveCache();window.dispatchEvent(new CustomEvent('fm-market-quotes-updated',{detail:{quotes:state.quotes}}));}})
 .on('postgres_changes',{event:'*',schema:'public',table:'service_health'},p=>{if(p.new&&['market_feed','ema_cci_v2_model'].includes(p.new.service)){mergeBy(state.health,p.new,'service');renderHealth();saveCache();}})
 .on('postgres_changes',{event:'*',schema:'public',table:'ema_cci_v2_events'},p=>{if(p.new){mergeBy(state.events,p.new,'event_id');state.events.sort((a,b)=>new Date(b.signal_close_utc)-new Date(a.signal_close_utc));state.events=state.events.slice(0,150);renderActivity();renderMatrix();renderQueue();renderHistory();saveCache();window.dispatchEvent(new CustomEvent('fm-model-events-updated',{detail:{events:state.events}}));}})
 .on('postgres_changes',{event:'*',schema:'public',table:'market_briefs'},p=>{if(p.new){mergeBy(state.briefs,p.new,'id');state.briefs.sort((a,b)=>new Date(b.brief_time)-new Date(a.brief_time));state.briefs=state.briefs.slice(0,8);state.selectedBriefId=state.briefs[0]?.id||null;renderBias();renderMarketUpdate();renderMesChart();saveCache();}})
 .subscribe();
}
async function show(s){state.session=s;$('authShell').classList.toggle('hidden',!!s);$('appShell').classList.toggle('hidden',!s);if(s){if(loadCache())render();await fetchAll();subscribe();}else{state.channel?.unsubscribe();state.channel=null;}}

document.addEventListener('click',e=>{
 const tab=e.target.closest('.tab');if(tab){setTab(tab.dataset.tab);if(tab.dataset.tab==='market')renderMarketUpdate();}
 const row=e.target.closest('[data-event-id]');if(row){state.selectedEvent=row.dataset.eventId;const ev=state.events.find(x=>x.event_id===state.selectedEvent);$('rawEvent').textContent=ev?JSON.stringify(ev,null,2):'—';}
 if(e.target.closest('#refresh')||e.target.closest('#historyRefresh'))void fetchAll();
 const briefBtn=e.target.closest('[data-brief-id]');if(briefBtn){state.selectedBriefId=briefBtn.dataset.briefId;renderMarketUpdate();}
 if(e.target.closest('#marketUpdateLatest')){state.selectedBriefId=latestBrief()?.id||null;renderMarketUpdate();}
 if(e.target.closest('#setupQueueToggle')){queueUi.hidden=!queueUi.hidden;saveQueue();renderQueue();}
 if(e.target.closest('#queueFilterReset')){Object.assign(queueUi,{root:'ALL',tf:'ALL',side:'ALL',decision:'ALL',execState:'ALL'});saveQueue();renderQueue();}
 const take=e.target.closest('[data-take-trade]');if(take){e.stopPropagation();openTakeTrade(take.dataset.takeTrade);}
 if(e.target.closest('#takeTradeCancel')||e.target.classList.contains('trade-modal-backdrop'))closeTakeTrade();
});
document.addEventListener('change',e=>{const m={queueFilterRoot:'root',queueFilterTf:'tf',queueFilterSide:'side',queueFilterDecision:'decision',queueFilterState:'execState'},k=m[e.target?.id];if(k){queueUi[k]=e.target.value;saveQueue();renderQueue();}});
document.addEventListener('submit',e=>{if(e.target.id==='takeTradeForm'){e.preventDefault();void saveTakenTrade();}},true);
$('loginForm').addEventListener('submit',async e=>{e.preventDefault();$('loginError').textContent='';const{data,error}=await client.auth.signInWithPassword({email:$('loginEmail').value.trim(),password:$('loginPassword').value});if(error){$('loginError').textContent=error.message;return;}await show(data.session);});
$('signOut').addEventListener('click',async()=>{await client.auth.signOut();await show(null);});
setInterval(()=>{if($('clock'))$('clock').textContent=new Intl.DateTimeFormat('en-US',{timeZone:cfg.timezone||'America/Chicago',hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short'}).format(new Date());},1000);
setInterval(()=>state.session&&void fetchAll(),60000);
window.addEventListener('resize',()=>state.chart?.applyOptions({width:$('mesChart')?.clientWidth||900}));
client.auth.getSession().then(({data})=>show(data.session));client.auth.onAuthStateChange((_e,s)=>{if(s?.access_token!==state.session?.access_token)show(s);});
})();