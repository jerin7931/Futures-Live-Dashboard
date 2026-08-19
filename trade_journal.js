(()=>{"use strict";
const $=id=>document.getElementById(id);
let trades=[],events=[],selectedTradeId=null,journalAvailable=true,booted=false;
const POINT_VALUE={MES:5,MNQ:2};
function client(){return window.FM_ORDERFLOW_CLIENT||null}
function appState(){return window.FM_ORDERFLOW_STATE||null}
function esc(v){return String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')}
function fmt(v,d=2){const n=Number(v);return Number.isFinite(n)?n.toFixed(d):'—'}
function signed(v,d=2){const n=Number(v);return Number.isFinite(n)?`${n>0?'+':''}${n.toFixed(d)}`:'—'}
function money(v,d=0){const n=Number(v);if(!Number.isFinite(n))return'—';return`${n>0?'+':n<0?'-':''}$${Math.abs(n).toFixed(d)}`}
function localTime(v){if(!v)return'—';try{return new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(v))}catch{return String(v)}}
function toast(m){const n=$('toast');if(!n)return;n.textContent=m;n.classList.remove('hidden');clearTimeout(n._tj);n._tj=setTimeout(()=>n.classList.add('hidden'),2600)}
function rpc(name,payload){const c=client();if(!c)throw new Error('Supabase client is not ready.');return c.rpc(name,payload).then(({data,error})=>{if(error)throw error;return data})}
function quotePrice(instrument){const s=appState(),base=instrument==='MES'?'ES':'NQ',aliases=base==='ES'?['ES','MES']:['NQ','MNQ'];return Number((s?.quotes||[]).find(x=>aliases.includes(x.symbol))?.last)}
function openPnl(row){const px=quotePrice(row.instrument),entry=Number(row.avg_entry_price),qty=Number(row.open_contracts||0),pv=Number(row.point_value||POINT_VALUE[row.instrument]),side=row.direction==='LONG'?1:-1;if(![px,entry,qty,pv].every(Number.isFinite))return null;return side*(px-entry)*qty*pv}
function targetForTrade(row){const e=events.filter(x=>x.trade_id===row.id).sort((a,b)=>new Date(b.event_time)-new Date(a.event_time)).find(x=>String(x.notes||'').startsWith('TARGET_UPDATE|'));if(!e)return null;const p=Number(String(e.notes).split('|')[1]);return Number.isFinite(p)?p:null}
function setActiveTrade(){const s=appState();if(!s)return;const row=trades.find(x=>x.status==='OPEN')||null;s.activeTrade=row?{id:row.id,active:true,status:row.status,instrument:row.instrument,direction:row.direction,entry:Number(row.initial_entry_price),avgEntry:Number(row.avg_entry_price),initialStop:Number(row.initial_stop_price),currentStop:Number(row.current_stop_price),initialContracts:Number(row.initial_contracts),openContracts:Number(row.open_contracts),contracts:Number(row.open_contracts),maxContracts:Number(row.max_contracts),scaleInCount:Number(row.scale_in_count||0),trimCount:Number(row.trim_count||0),realizedPnlDollars:Number(row.realized_pnl_dollars||0),pointValue:Number(row.point_value||POINT_VALUE[row.instrument])}:null;s.activeTradeLoaded=true}
function injectUi(){
  const nav=document.querySelector('.tabs'),analytics=nav?.querySelector('[data-tab="analytics"]');
  if(nav&&analytics&&!nav.querySelector('[data-tab="trades"]')){const b=document.createElement('button');b.className='tab';b.dataset.tab='trades';b.textContent='Journal';nav.insertBefore(b,analytics);}
  const ap=$('tab-analytics');if(ap&&!$('tab-trades')){const p=document.createElement('section');p.id='tab-trades';p.className='tab-panel';p.innerHTML=`
  <div class="section-head"><div><div class="eyebrow">TRADE JOURNAL · MANUAL FILL RECORD</div><h2>Trades + Live P/L</h2><p class="muted">Records your futures fills in Supabase. This journal does not transmit brokerage orders.</p></div><div class="trade-journal-controls"><select id="tradesStatusFilter"><option value="ALL">All trades</option><option value="OPEN">Open</option><option value="CLOSED">Closed</option><option value="CANCELLED">Cancelled</option></select><button id="tradesRefreshButton">Refresh</button></div></div>
  <article class="panel"><div class="panel-head"><div><div class="eyebrow">NEW TRADE</div><h3>Enter Position</h3></div><small>Entry, SL and TP are planning/journal fields only.</small></div>
    <form id="journalNewTradeForm" class="journal-entry-form">
      <label><span>Instrument</span><select id="journalInstrument"><option>MES</option><option>MNQ</option></select></label>
      <label><span>Side</span><select id="journalDirection"><option>LONG</option><option>SHORT</option></select></label>
      <label><span>Contracts</span><input id="journalContracts" type="number" min="1" step="1" value="1"></label>
      <label><span>Entry</span><input id="journalEntry" type="number" step="0.25" required></label>
      <label><span>Stop Loss</span><input id="journalStop" type="number" step="0.25" required></label>
      <label><span>Take Profit</span><input id="journalTarget" type="number" step="0.25"></label>
      <div class="journal-entry-actions"><button type="button" id="journalUseLiveEntry">Use Live Price</button><button type="submit" class="journal-primary">Open Journal Trade</button></div>
    </form><div id="journalNewTradeError" class="error"></div>
  </article>
  <article class="panel"><div class="panel-head"><div><div class="eyebrow">OPEN POSITIONS</div><h3>Live P/L</h3></div><small>Marks MES from ES and MNQ from NQ live quotes.</small></div><div id="journalOpenTrades" class="journal-open-grid"></div></article>
  <div id="tradeJournalStatCards" class="journal-stat-grid"></div>
  <article class="panel"><div class="panel-head"><h3>Trade Ledger</h3></div><div class="table-wrap"><table id="tradeJournalTable"><thead><tr><th>Opened</th><th>Instrument</th><th>Side</th><th>Status</th><th>Avg Entry</th><th>Live Price</th><th>Open P/L</th><th>Realized</th><th>Open Qty</th><th>Stop</th><th>TP</th><th>Scale / Trim</th></tr></thead><tbody></tbody></table></div></article>
  <div id="tradeJournalDetail"></div>`;ap.parentNode.insertBefore(p,ap);}
}
injectUi();

async function fetchData(){
  const c=client();if(!c)return;
  try{const [tr,ev]=await Promise.all([c.from('trades').select('*').order('opened_at',{ascending:false}).limit(150),c.from('trade_events').select('*').order('event_time',{ascending:false}).limit(1500)]);if(tr.error)throw tr.error;if(ev.error)throw ev.error;trades=tr.data||[];events=ev.data||[];journalAvailable=true;if(!selectedTradeId&&trades.length)selectedTradeId=trades.find(x=>x.status==='OPEN')?.id||trades[0].id;setActiveTrade();}
  catch(e){console.warn('Trade Journal:',e);journalAvailable=false;trades=[];events=[];}
}
function stats(rows){const closed=rows.filter(x=>x.status==='CLOSED'),net=closed.reduce((s,x)=>s+(Number(x.realized_pnl_dollars)||0),0),wins=closed.filter(x=>Number(x.realized_pnl_dollars)>0).length,open=rows.filter(x=>x.status==='OPEN').length;return[['Open',open,'live-marked'],['Closed',closed.length,'saved fills'],['Win Rate',closed.length?`${fmt(100*wins/closed.length,1)}%`:'—','realized P/L > 0'],['Net Realized',money(net),'closed trades']]}
function renderStats(rows){const h=$('tradeJournalStatCards');if(h)h.innerHTML=stats(rows).map(([a,b,c])=>`<div class="journal-stat"><span>${a}</span><strong>${b}</strong><small>${c}</small></div>`).join('')}
function renderOpen(){
  const h=$('journalOpenTrades');if(!h)return;const open=trades.filter(x=>x.status==='OPEN');
  h.innerHTML=open.length?open.map(r=>{const px=quotePrice(r.instrument),pnl=openPnl(r),tp=targetForTrade(r);return`<button class="journal-open-card ${r.id===selectedTradeId?'selected':''}" data-trade-id="${esc(r.id)}"><div><span>${esc(r.instrument)} ${esc(r.direction)}</span><strong data-live-price="${esc(r.id)}">${fmt(px)}</strong></div><div><span>Open P/L</span><strong class="${Number(pnl)>=0?'positive':'negative'}" data-live-pnl="${esc(r.id)}">${money(pnl)}</strong></div><div><span>Qty / Entry</span><strong>${r.open_contracts} @ ${fmt(r.avg_entry_price)}</strong></div><div><span>SL / TP</span><strong>${fmt(r.current_stop_price)} / ${fmt(tp)}</strong></div></button>`}).join(''):'<p class="muted">No open journal trades.</p>';
}
function renderLedger(){
  const body=$('tradeJournalTable')?.querySelector('tbody');if(!body)return;const filter=$('tradesStatusFilter')?.value||'ALL',rows=trades.filter(x=>filter==='ALL'||x.status===filter);renderStats(rows);
  body.innerHTML=rows.length?rows.map(r=>{const px=r.status==='OPEN'?quotePrice(r.instrument):null,pnl=r.status==='OPEN'?openPnl(r):null,tp=targetForTrade(r);return`<tr class="trade-journal-row ${r.id===selectedTradeId?'selected':''}" data-trade-id="${esc(r.id)}"><td>${localTime(r.opened_at)}</td><td><strong>${esc(r.instrument)}</strong></td><td>${esc(r.direction)}</td><td>${esc(r.status)}</td><td>${fmt(r.avg_entry_price)}</td><td data-live-price="${esc(r.id)}">${r.status==='OPEN'?fmt(px):'—'}</td><td class="${Number(pnl)>=0?'positive':'negative'}" data-live-pnl="${esc(r.id)}">${r.status==='OPEN'?money(pnl):'—'}</td><td>${money(r.realized_pnl_dollars)}</td><td>${r.open_contracts}</td><td>${fmt(r.current_stop_price)}</td><td>${fmt(tp)}</td><td>${r.scale_in_count||0} / ${r.trim_count||0}</td></tr>`}).join(''):`<tr><td colspan="12">${journalAvailable?'No trades match this filter.':'Trade Journal unavailable.'}</td></tr>`;
}
function renderDetail(){
  const h=$('tradeJournalDetail');if(!h)return;const r=trades.find(x=>x.id===selectedTradeId);if(!r){h.innerHTML='';return;}const ev=events.filter(x=>x.trade_id===r.id).sort((a,b)=>new Date(a.event_time)-new Date(b.event_time)),tp=targetForTrade(r),isOpen=r.status==='OPEN';
  const ledger=ev.length?ev.map(x=>`<tr><td>${localTime(x.event_time)}</td><td>${esc(x.event_type)}</td><td>${x.quantity??'—'}</td><td>${x.price==null?'—':fmt(x.price)}</td><td>${x.stop_price==null?'—':fmt(x.stop_price)}</td><td>${esc(x.reason||'—')}</td><td>${esc(x.notes||'')}</td></tr>`).join(''):'<tr><td colspan="7">No events.</td></tr>';
  h.innerHTML=`<article class="panel"><div class="panel-head"><div><div class="eyebrow">SELECTED TRADE</div><h3>${esc(r.instrument)} ${esc(r.direction)} · ${esc(r.status)}</h3></div><div><strong data-live-pnl="${esc(r.id)}">${isOpen?money(openPnl(r)):money(r.realized_pnl_dollars)}</strong><small>${isOpen?'Live open P/L':'Realized P/L'}</small></div></div>
  <div class="trade-detail-summary"><div><span>Avg Entry</span><strong>${fmt(r.avg_entry_price)}</strong></div><div><span>Live Price</span><strong data-live-price="${esc(r.id)}">${isOpen?fmt(quotePrice(r.instrument)):'—'}</strong></div><div><span>Open Qty</span><strong>${r.open_contracts}</strong></div><div><span>Current Stop</span><strong>${fmt(r.current_stop_price)}</strong></div><div><span>Current TP</span><strong>${fmt(tp)}</strong></div><div><span>Realized</span><strong>${money(r.realized_pnl_dollars)}</strong></div></div>
  ${isOpen?`<div class="journal-manage-grid">
    <form id="journalPositionActionForm" class="journal-manage-form"><h3>Position Action</h3><label>Action<select id="journalActionType"><option value="SCALE_IN">Scale In</option><option value="TRIM">Trim</option><option value="TAKE_PROFIT">Take Profit</option><option value="EXIT">Exit Remaining</option></select></label><label>Qty<input id="journalActionQty" type="number" min="1" step="1" value="1"></label><label>Fill Price<input id="journalActionPrice" type="number" step="0.25" value="${fmt(quotePrice(r.instrument))}"></label><div class="journal-action-row"><button type="button" id="journalUseLiveAction">Use Live</button><button type="submit" class="journal-primary">Save Action</button></div></form>
    <form id="journalStopForm" class="journal-manage-form"><h3>Change Stop</h3><label>New Stop<input id="journalNewStop" type="number" step="0.25" value="${fmt(r.current_stop_price)}"></label><button type="submit">Save Stop</button></form>
    <form id="journalTargetForm" class="journal-manage-form"><h3>Change Take Profit</h3><label>New TP<input id="journalNewTarget" type="number" step="0.25" value="${tp==null?'':fmt(tp)}"></label><button type="submit">Save TP</button></form>
  </div>`:''}
  <div class="table-wrap"><table><thead><tr><th>Time</th><th>Event</th><th>Qty</th><th>Price</th><th>Stop</th><th>Reason</th><th>Notes</th></tr></thead><tbody>${ledger}</tbody></table></div></article>`;
}
function renderAll(){renderOpen();renderLedger();renderDetail();updateLiveMarks()}
function updateLiveMarks(){for(const r of trades.filter(x=>x.status==='OPEN')){const px=quotePrice(r.instrument),pnl=openPnl(r);document.querySelectorAll(`[data-live-price="${CSS.escape(r.id)}"]`).forEach(n=>n.textContent=fmt(px));document.querySelectorAll(`[data-live-pnl="${CSS.escape(r.id)}"]`).forEach(n=>{n.textContent=money(pnl);n.classList.toggle('positive',Number(pnl)>=0);n.classList.toggle('negative',Number(pnl)<0);});}}
async function refresh(){await fetchData();renderAll()}
function entryContext(instrument,direction,target){const s=appState(),level=(s?.levels||[]).find(x=>x.level_id===s?.selected)||null;return{source:'V28_JOURNAL_MANUAL',instrument,direction,target_price:target,current_es:quotePrice('MES'),current_nq:quotePrice('MNQ'),selected_level:level?{level_id:level.level_id,level_type:level.level_type,level_price:level.level_price,state:level.state,reaction_probability:level.reaction_probability}:null,recorded_at:new Date().toISOString()}}
async function writeTarget(tradeId,target){if(!Number.isFinite(target))return;await rpc('add_trade_event',{p_trade_id:tradeId,p_event_type:'NOTE',p_quantity:null,p_price:null,p_stop_price:null,p_reason:'MANUAL',p_notes:`TARGET_UPDATE|${target}`,p_market_snapshot_id:null,p_context:{target_price:target,source:'V28_JOURNAL'}});}
async function openTrade(){
  const err=$('journalNewTradeError');if(err)err.textContent='';const instrument=$('journalInstrument').value,direction=$('journalDirection').value,contracts=Number($('journalContracts').value),entry=Number($('journalEntry').value),stop=Number($('journalStop').value),target=Number($('journalTarget').value);
  if(!['MES','MNQ'].includes(instrument)||!['LONG','SHORT'].includes(direction)||!Number.isInteger(contracts)||contracts<=0||!Number.isFinite(entry)||!Number.isFinite(stop)){if(err)err.textContent='Enter valid trade details.';return;}
  if(direction==='LONG'&&stop>=entry||direction==='SHORT'&&stop<=entry){if(err)err.textContent=direction==='LONG'?'LONG stop must be below entry.':'SHORT stop must be above entry.';return;}
  if(Number.isFinite(target)&&((direction==='LONG'&&target<=entry)||(direction==='SHORT'&&target>=entry))){if(err)err.textContent=direction==='LONG'?'LONG TP must be above entry.':'SHORT TP must be below entry.';return;}
  try{await rpc('start_trade',{p_instrument:instrument,p_direction:direction,p_entry_price:entry,p_stop_price:stop,p_contracts:contracts,p_market_snapshot_id:null,p_entry_context:entryContext(instrument,direction,target),p_notes:null});await fetchData();const newest=trades.filter(x=>x.status==='OPEN'&&x.instrument===instrument).sort((a,b)=>new Date(b.opened_at)-new Date(a.opened_at))[0];if(newest&&Number.isFinite(target))await writeTarget(newest.id,target);await refresh();if(newest)selectedTradeId=newest.id;renderAll();toast(`${instrument} ${direction} journal trade opened`);}catch(e){console.error(e);if(err)err.textContent=e.message||'Trade could not be saved.';}
}
async function positionAction(){
  const r=trades.find(x=>x.id===selectedTradeId);if(!r||r.status!=='OPEN')return;const type=$('journalActionType').value,qty=Number($('journalActionQty').value),price=Number($('journalActionPrice').value);
  if(!Number.isInteger(qty)||qty<=0||!Number.isFinite(price)){toast('Enter a valid quantity and fill price');return;}
  let eventType=type,reason='MANUAL',effectiveQty=qty;if(type==='TAKE_PROFIT'){eventType=qty>=Number(r.open_contracts)?'EXIT':'TRIM';reason='PRIMARY_TARGET';effectiveQty=eventType==='EXIT'?null:qty;}else if(type==='EXIT'){eventType='EXIT';effectiveQty=null;}else if(type==='TRIM'&&qty>=Number(r.open_contracts)){toast('Trim must leave at least one contract; use Exit Remaining');return;}
  try{await rpc('add_trade_event',{p_trade_id:r.id,p_event_type:eventType,p_quantity:effectiveQty,p_price:price,p_stop_price:null,p_reason:reason,p_notes:type==='TAKE_PROFIT'?'Take profit fill from V28 journal':null,p_market_snapshot_id:null,p_context:{source:'V28_JOURNAL',live_price:quotePrice(r.instrument)}});await refresh();toast(`${type.replaceAll('_',' ')} saved`);}catch(e){console.error(e);toast(e.message||'Trade action failed');}
}
async function updateStop(){
  const r=trades.find(x=>x.id===selectedTradeId);if(!r||r.status!=='OPEN')return;const p=Number($('journalNewStop').value),live=quotePrice(r.instrument);if(!Number.isFinite(p)||!Number.isFinite(live)){toast('Valid stop and live price required');return;}
  const old=Number(r.current_stop_price),tightens=r.direction==='LONG'?p>=old&&p<live:p<=old&&p>live;if(!tightens){toast(r.direction==='LONG'?'LONG stop may tighten upward only and stay below live price':'SHORT stop may tighten downward only and stay above live price');return;}
  try{await rpc('add_trade_event',{p_trade_id:r.id,p_event_type:'STOP_UPDATE',p_quantity:null,p_price:null,p_stop_price:p,p_reason:'STRUCTURE_UPDATE',p_notes:null,p_market_snapshot_id:null,p_context:{source:'V28_JOURNAL',live_price:live}});await refresh();toast(`Stop updated to ${fmt(p)}`);}catch(e){console.error(e);toast(e.message||'Stop update failed');}
}
async function updateTarget(){
  const r=trades.find(x=>x.id===selectedTradeId);if(!r||r.status!=='OPEN')return;const p=Number($('journalNewTarget').value),live=quotePrice(r.instrument);if(!Number.isFinite(p)){toast('Enter a valid TP');return;}if(r.direction==='LONG'&&p<=live||r.direction==='SHORT'&&p>=live){toast(r.direction==='LONG'?'LONG TP should be above live price':'SHORT TP should be below live price');return;}
  try{await writeTarget(r.id,p);await refresh();toast(`TP updated to ${fmt(p)}`);}catch(e){console.error(e);toast(e.message||'TP update failed');}
}
document.addEventListener('click',e=>{
  if(e.target.closest('[data-tab="trades"]'))setTimeout(()=>void refresh(),0);
  if(e.target.closest('#tradesRefreshButton'))void refresh();
  const row=e.target.closest('[data-trade-id]');if(row?.dataset.tradeId){selectedTradeId=row.dataset.tradeId;renderAll();}
  if(e.target.closest('#journalUseLiveEntry')){const i=$('journalInstrument')?.value,p=quotePrice(i);if(Number.isFinite(p))$('journalEntry').value=p.toFixed(2);}
  if(e.target.closest('#journalUseLiveAction')){const r=trades.find(x=>x.id===selectedTradeId),p=r?quotePrice(r.instrument):NaN;if(Number.isFinite(p))$('journalActionPrice').value=p.toFixed(2);}
});
document.addEventListener('change',e=>{if(e.target?.id==='tradesStatusFilter')renderAll();if(e.target?.id==='journalInstrument'){const p=quotePrice(e.target.value);if(Number.isFinite(p)&&$('journalEntry'))$('journalEntry').value=p.toFixed(2);}});
document.addEventListener('submit',e=>{if(e.target?.id==='journalNewTradeForm'){e.preventDefault();void openTrade();}if(e.target?.id==='journalPositionActionForm'){e.preventDefault();void positionAction();}if(e.target?.id==='journalStopForm'){e.preventDefault();void updateStop();}if(e.target?.id==='journalTargetForm'){e.preventDefault();void updateTarget();}},true);
window.addEventListener('fm-market-quotes-updated',()=>updateLiveMarks());
setInterval(updateLiveMarks,500);
setInterval(()=>{if($('tab-trades')?.classList.contains('active'))void fetchData().then(renderAll)},30000);
async function wait(){if(booted)return;const c=client();if(!c){setTimeout(wait,200);return;}try{const {data}=await c.auth.getSession();if(!data?.session){setTimeout(wait,400);return;}booted=true;await refresh();}catch{setTimeout(wait,500);}}
wait();
})();