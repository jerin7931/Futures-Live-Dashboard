(()=>{'use strict';
const $=id=>document.getElementById(id);
const esc=x=>String(x??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
let selectedId='es-reaction-v28';
let statusFilter='ALL';
let instrumentFilter='ALL';

function registry(){return window.FM_MODEL_REGISTRY||[]}
function runtimeFor(m){
  if(!m.runtimeService)return {status:'NOT DEPLOYED',message:'No production service'};
  const h=(window.FM_ORDERFLOW_STATE?.health||[]).find(x=>x.service===m.runtimeService)||{};
  return {status:String(h.status||'WAITING').toUpperCase(),message:h.message||'Service has not reported yet',updated_at:h.updated_at};
}
function tone(status){
  const s=String(status||'').toUpperCase();
  if(s==='READY'||s==='LIVE')return 'ready';
  if(s==='PENDING'||s==='WAITING'||s==='STARTING'||s==='DEGRADED')return 'pending';
  return 'not-ready';
}
function setTab(name){
  document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===name));
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.toggle('active',p.id===`tab-${name}`));
  if(name==='trades')window.dispatchEvent(new CustomEvent('fm-tab-changed',{detail:{tab:'trades'}}));
}
function summary(){
  const all=registry();
  const ready=all.filter(x=>x.readiness==='READY').length;
  const pending=all.filter(x=>x.readiness==='PENDING').length;
  const no=all.filter(x=>x.readiness==='NOT_READY').length;
  return {all:all.length,ready,pending,no};
}
function compactCard(m){
  const r=runtimeFor(m);
  return `<button class="fleet-card" data-model-open="${esc(m.id)}">
    <div class="fleet-card-top"><span class="model-instrument">${esc(m.instrument)}</span><span class="readiness ${tone(m.readiness)}">${esc(m.readinessLabel)}</span></div>
    <h3>${esc(m.shortName)}</h3>
    <p>${esc(m.stage)}</p>
    <div class="fleet-meta"><span>${esc(m.family)}</span><span class="runtime-dot ${tone(r.status)}">${esc(r.status)}</span></div>
  </button>`;
}
function injectCommandCenter(){
  const live=$('tab-live'); if(!live||$('modelFleetOverview'))return;
  const quote=$('quoteGrid');
  const section=document.createElement('section');
  section.id='modelFleetOverview';
  section.className='model-fleet-overview';
  const s=summary();
  section.innerHTML=`<div class="fleet-heading">
    <div><div class="eyebrow">MODEL OPERATIONS</div><h2>Model Fleet</h2><p class="muted">Readiness at a glance. Open Strategy Engines for full model definitions, validation state and promotion gates.</p></div>
    <button id="openStrategyEngines" class="fleet-open-all">Open Strategy Engines</button>
  </div>
  <div class="fleet-summary">
    <div><span>All Models</span><strong>${s.all}</strong></div>
    <div class="ready"><span>Ready</span><strong>${s.ready}</strong></div>
    <div class="pending"><span>Pending</span><strong>${s.pending}</strong></div>
    <div class="not-ready"><span>Not Ready</span><strong>${s.no}</strong></div>
  </div>
  <div id="modelFleetCards" class="model-fleet-grid">${registry().map(compactCard).join('')}</div>`;
  if(quote)quote.insertAdjacentElement('beforebegin',section); else live.prepend(section);
  $('openStrategyEngines')?.addEventListener('click',()=>{setTab('model');renderStrategy();});
}
function filterButton(label,value,type,current){
  return `<button class="engine-filter ${current===value?'active':''}" data-filter-type="${type}" data-filter-value="${value}">${label}</button>`;
}
function renderStrategy(){
  const panel=$('tab-model'); if(!panel)return;
  const models=registry();
  const visible=models.filter(m=>(statusFilter==='ALL'||m.readiness===statusFilter)&&(instrumentFilter==='ALL'||m.instrument===instrumentFilter||m.instrument==='ES/NQ'));
  if(!visible.some(x=>x.id===selectedId))selectedId=visible[0]?.id||models[0]?.id;
  const selected=models.find(x=>x.id===selectedId)||visible[0];
  panel.innerHTML=`<div class="engine-page">
    <div class="section-head engine-head">
      <div><div class="eyebrow">MODEL GOVERNANCE + STRATEGY DEFINITIONS</div><h2>Strategy Engines</h2><p class="muted">Research readiness and runtime availability are separate. A READY research model can still be offline; PENDING models remain visible without being presented as production signals.</p></div>
      <div class="engine-count">${visible.length} / ${models.length} models</div>
    </div>
    <div class="engine-toolbar">
      <div class="engine-filter-group"><span>Status</span>${filterButton('All','ALL','status',statusFilter)}${filterButton('Ready','READY','status',statusFilter)}${filterButton('Pending','PENDING','status',statusFilter)}${filterButton('Not Ready','NOT_READY','status',statusFilter)}</div>
      <div class="engine-filter-group"><span>Instrument</span>${filterButton('All','ALL','instrument',instrumentFilter)}${filterButton('ES','ES','instrument',instrumentFilter)}${filterButton('NQ','NQ','instrument',instrumentFilter)}</div>
    </div>
    <div class="engine-layout">
      <aside class="engine-list">${visible.map(m=>{const r=runtimeFor(m);return `<button class="engine-row ${m.id===selectedId?'selected':''}" data-engine-id="${esc(m.id)}"><div><span class="model-instrument">${esc(m.instrument)}</span><strong>${esc(m.shortName)}</strong><small>${esc(m.family)}</small></div><div class="engine-row-state"><span class="readiness ${tone(m.readiness)}">${esc(m.readinessLabel)}</span><small>${esc(r.status)}</small></div></button>`}).join('')||'<p class="muted">No models match this filter.</p>'}</aside>
      <section id="engineDetail" class="engine-detail">${selected?detail(selected):'<div class="panel">No model selected.</div>'}</section>
    </div>
  </div>`;
}
function detail(m){
  const r=runtimeFor(m);
  return `<article class="engine-hero">
    <div><div class="engine-title-line"><span class="model-instrument">${esc(m.instrument)}</span><span class="readiness ${tone(m.readiness)}">${esc(m.readinessLabel)}</span></div><h2>${esc(m.name)}</h2><p>${esc(m.role)}</p></div>
    <div class="engine-runtime"><span>Runtime</span><strong class="${tone(r.status)}">${esc(r.status)}</strong><small>${esc(r.message)}</small></div>
  </article>
  <div class="engine-detail-grid">
    <article class="panel"><div class="eyebrow">CURRENT USE</div><h3>Production Role</h3><p>${esc(m.productionUse)}</p></article>
    <article class="panel"><div class="eyebrow">NEXT GATE</div><h3>What must happen next</h3><p>${esc(m.currentGate)}</p></article>
  </div>
  <article class="panel"><div class="eyebrow">VALIDATION STATE</div><h3>Research Evidence</h3><p>${esc(m.validation)}</p></article>
  <article class="panel"><div class="eyebrow">MODEL / SETUP SPECIFICATION</div><div class="engine-spec">${(m.spec||[]).map(([k,v])=>`<div><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('')}</div></article>
  <article class="panel"><div class="eyebrow">FROZEN PARAMETERS / POLICY</div><p class="mono-copy">${esc(m.params)}</p><div class="tag-row">${(m.tags||[]).map(x=>`<span class="engine-tag">${esc(x)}</span>`).join('')}</div></article>`;
}
function bind(){
  document.addEventListener('click',ev=>{
    const open=ev.target.closest('[data-model-open]');
    if(open){selectedId=open.dataset.modelOpen;setTab('model');renderStrategy();return}
    const row=ev.target.closest('[data-engine-id]');
    if(row){selectedId=row.dataset.engineId;renderStrategy();return}
    const f=ev.target.closest('[data-filter-type]');
    if(f){if(f.dataset.filterType==='status')statusFilter=f.dataset.filterValue;else instrumentFilter=f.dataset.filterValue;renderStrategy();return}
  });
}
function updateRuntimeOnly(){
  if($('modelFleetCards'))$('modelFleetCards').innerHTML=registry().map(compactCard).join('');
  if(document.querySelector('#tab-model.active'))renderStrategy();
}
function init(){
  injectCommandCenter();
  renderStrategy();
  bind();
  setInterval(updateRuntimeOnly,5000);
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();