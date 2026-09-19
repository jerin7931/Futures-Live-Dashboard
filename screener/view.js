export const esc=v=>String(v??"—").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const time=v=>Date.parse(v);
const num=v=>v===null||v===undefined||v===""||typeof v==="boolean"?NaN:Number(v);
export const money=v=>Number.isFinite(num(v))?"$"+num(v).toFixed(2):"—";
const number=(v,d=2)=>Number.isFinite(num(v))?num(v).toFixed(d):"—";
const clock=v=>Number.isFinite(time(v))?new Intl.DateTimeFormat("en-US",{timeZone:"America/Chicago",month:"short",day:"numeric",hour:"numeric",minute:"2-digit",second:"2-digit",timeZoneName:"short"}).format(time(v)):"Not observed";
const empty=t=>'<p class="empty">'+esc(t)+'</p>';
const badge=(v,w=false)=>'<span class="badge'+(w?' warn':'')+'">'+esc(v??"UNKNOWN")+'</span>';
const pair=(k,v)=>'<dt>'+esc(k)+'</dt><dd>'+v+'</dd>';
const brief=p=>p.three_group_assessments??{};
export function currentParent(p,now){
  return p?.status==="AVAILABLE"&&p.review==="APPROVED"&&
    ["availability_valid_until","entry_deadline","approval_deadline","session_close"].every(k=>Number.isFinite(time(p[k]))&&now<time(p[k]))&&
    (!p.underlying_valid_until||now<time(p.underlying_valid_until));
}
export function visibleState(payload,now){
  const h=payload?.health??{},age=now-time(h.checked_at);
  const fresh=Number.isFinite(age)&&age>=-2000&&age<15000;
  const enabled=fresh&&h.actionable_enabled===true&&h.mode!=="CAPTURE_ONLY";
  const active=enabled?(payload.active??[]).filter(p=>currentParent(p,now)).slice(0,3):[];
  const options=(payload?.options??[]).map(o=>{
    const parent=active.find(p=>p.id===o.parent_id),result=o.result;
    const valid=h.options_enabled!==false&&parent&&result&&result.parent_attempt_id===parent.attempt_id&&result.parent_contract_version===parent.contract_version&&now<time(result.valid_until);
    return {...o,result:valid?{...result,rows:result.rows.filter(r=>now<time(r.valid_until))}:null,
      presentation:valid?"CURRENT_COMPARISON":h.options_enabled===false?"OPTIONS_DISABLED":!parent?"PARENT_UNAVAILABLE":result?"EXPIRED":"NO_CURRENT_COMPARISON"};
  });
  const ranked=enabled?(payload.ranked??[]).filter(p=>!p.quality_valid_until||now<time(p.quality_valid_until)).slice(0,10):[];
  return {fresh,enabled,active,options,ranked,contenders:enabled?(payload.contenders??[]).filter(p=>!p.quality_valid_until||now<time(p.quality_valid_until)).slice(0,3):[]};
}
export function geometry(p){
  const price=num(p.underlying_price),stop=num(p.stop),target=num(p.target),sign=p.direction==="LONG"?1:p.direction==="SHORT"?-1:NaN;
  const risk=sign*(price-stop),reward=sign*(target-price);
  return {r:price>0&&risk>0&&reward>0?reward/risk:null,riskPct:price>0&&Number.isFinite(stop)?Math.abs(price-stop)/price*100:null};
}
export function optionMetrics(row,parent,now){
  const age=(now-time(row.source_at))/1000,skew=Math.abs(time(row.source_at)-time(parent?.underlying_source_at))/1000;
  return {age:Number.isFinite(age)?age:null,skew:Number.isFinite(skew)?skew:null,spread:Number.isFinite(num(row.spread_fraction))?num(row.spread_fraction)*100:null};
}
const shownStatus=(p,now)=>p.status==="AVAILABLE"&&!currentParent(p,now)?"EXPIRED":p.status;
function details(p){
  const d=p.display??{},m=d.confirmation_diagnostics??p.machine_values??{},b=p.confirming_candle??{},t=d.target_reference??{},g=geometry(p);
  const rows=[
    pair("OR5 high / low",money(d.or5?.high)+" / "+money(d.or5?.low)),
    pair("Confirming candle close time",esc(clock(p.candle_market_cutoff_at))),
    pair("Confirming H / L / C",[b.high,b.low,b.close].map(money).join(" / ")),
    pair("Same-window RVOL",number(m.window_relative_volume)+"×"),
    pair("Baseline sessions",esc(m.baseline_sessions)),
    pair("Directional efficiency",number(m.direction_efficiency,3)),
    pair("Assessment basis",esc(d.confirmation_diagnostics?"CONFIRMING CANDLE":"LATEST RANK ASSESSMENT")),
    pair("Raw entry band",money(p.raw_low)+" – "+money(p.raw_high)),
    pair("Final entry band",money(p.entry_low)+" – "+money(p.entry_high)),
    pair("Target reference",esc(t.type??p.target_reference_id)),
    pair("Target source / session",esc(t.source??"Not recorded")+" / "+esc(t.session??t.session_date??"Not recorded")),
    pair("Target available at",esc(clock(t.available_at))),
    pair("Current underlying risk",number(g.riskPct)+"%"),
    pair("Gross reward / risk",number(g.r)+"R · costs separate"),
    pair("Attempt / prior lineage",esc(p.attempt_number??1)+" / "+esc(p.lineage??"Original")),
    pair("Historical references",esc(d.historical_reference_count)),
    pair("Finviz first received",esc(clock(d.discovery_received_at))),
    pair("Underlying source timestamp",esc(clock(p.underlying_source_at))),
    pair("Entry / approval deadline",esc(clock(p.entry_deadline))+" / "+esc(clock(p.approval_deadline))),
    pair("Reason / concern",esc(p.reason)+" / "+esc(p.main_concern))
  ];
  const news=(d.news??[]).map(n=>'<div class="row"><p>'+esc(n.title)+'</p><small>'+esc(n.source)+' · First observed '+esc(clock(n.first_seen_at))+'</small></div>').join("");
  return '<details data-key="'+esc(p.id)+'"><summary>Evidence &amp; entry contract</summary><dl>'+rows.join("")+'</dl><small>News is optional context. First observed is not publication time; no causal claim is implied.</small>'+news+'</details>';
}
const rendered=new WeakMap();
export function render(root,payload,now){
  if(!rendered.has(root))rendered.set(root,new Map());
  const cache=rendered.get(root);
  const set=(id,html)=>{
    const el=root.getElementById(id);if(!el)return;
    if(cache.get(id)!==html||!el.hasChildNodes()){
      const opened=new Set(Array.from(el.querySelectorAll?.("details[open][data-key]")??[]).map(x=>x.dataset.key));
      el.innerHTML=html;cache.set(id,html);
      for(const item of el.querySelectorAll?.("details[data-key]")??[])if(opened.has(item.dataset.key))item.open=true;
    }
  };
  const state=visibleState(payload,now),h=payload?.health??{},dh=payload?.display_health??{},discovery=payload?.discovery;
  const mode=h.mode==="LIVE_PAPER"?"PAPER":h.mode??"NOT STARTED";
  const cell=(title,value)=>'<div class="health-cell"><small>'+esc(title)+'</small><strong>'+value+'</strong></div>';
  set("health",'<div class="health-grid">'+[
    cell("Session",badge(h.session?.state??"UNKNOWN")),
    cell("Screener",badge(state.fresh?"WORKER RECENT":"STALE / STOPPED",!state.fresh)),
    cell("Finviz discovery",esc(clock(discovery?.received_at))),
    cell("Webull quote update",esc(clock(dh.webull_received_at))),
    cell("Model",esc(dh.model_state??(state.enabled?"CAPACITY UNVERIFIED":"DISABLED"))),
    cell("Mode",badge(mode,mode!=="ACTIVE"))
  ].join("")+'</div><div class="health-message"><strong>'+(state.enabled?"Entry permission expires with its evidence.":"Signals disabled · qualification preparation")+'</strong><span>'+esc((h.activation_gates??[]).length)+' pending activation checks · '+esc((payload?.capabilities??[]).filter(c=>c.status==="VERIFIED").length)+' recorded verified capabilities (see validity below)</span></div>');
  set("active",state.active.map(p=>{
    const g=geometry(p),rank=state.ranked.find(r=>r.id===p.id)?.quality_rank??p.quality_rank;
    const expires=Math.min(...["availability_valid_until","entry_deadline","approval_deadline","session_close"].map(k=>time(p[k])));
    return '<article class="panel setup"><div class="card-title"><h2>'+esc(p.symbol)+'</h2><span class="price">'+money(p.underlying_price)+'</span></div><div>'+badge(p.direction)+' '+badge(p.status)+' <span class="countdown">'+Math.max(0,Math.ceil((expires-now)/1000))+'s evidence remaining</span></div><dl>'+
      pair("Entry band",money(p.entry_low)+" – "+money(p.entry_high))+pair("Invalidation",money(p.stop))+pair("Target",money(p.target))+pair("Gross R / setup rank",number(g.r)+"R / #"+esc(rank))+pair("Trigger candle",esc(clock(p.candle_market_cutoff_at)))+'</dl><div class="summary"><small>WHY TODAY</small><p>'+esc(brief(p).WHY_TODAY??"Context not recorded")+'</p><small>DIRECTION NOW</small><p>'+esc(brief(p).DIRECTION_NOW??"Not assessed")+' · '+esc(p.main_reason)+'</p></div>'+details(p)+'</article>';
  }).join("")||empty(state.enabled?"No currently available entry. Direction alone is not entry permission.":"No live opportunities are published while signals are disabled. Discovery and qualification preparation can continue."));
  set("ranking",state.ranked.length?'<div class="table-wrap"><table><thead><tr><th>Rank</th><th>Opportunity</th><th>Evidence</th><th>Entry / options</th></tr></thead><tbody>'+state.ranked.map(p=>{
    const currentOption=state.options.find(o=>o.parent_id===p.id)?.result?.rows?.length>0;
    return '<tr><td class="rank">'+esc(p.quality_rank)+'</td><td><strong>'+esc(p.symbol)+'</strong><small>'+esc(p.direction)+'</small></td><td><p>'+esc(brief(p).WHY_TODAY)+'</p><small>'+esc(brief(p).DIRECTION_NOW)+'</small>'+details(p)+'</td><td>'+badge(shownStatus(p,now))+'<small>Options: '+(currentOption?"current comparison":"not available")+'</small></td></tr>';
  }).join("")+'</tbody></table></div>':empty("No qualified ranking yet. Discovery order is not quality rank."));
  set("contenders",state.contenders.map(p=>'<div class="row"><strong>'+esc(p.symbol)+'</strong>'+badge(p.direction)+'<p>'+esc(brief(p).DIRECTION_NOW??p.main_reason)+'</p><small>'+esc(shownStatus(p,now))+' · '+esc(p.main_concern)+'</small></div>').join("")||empty("No developing contenders published."));
  set("options",state.options.map(o=>{
    const p=state.active.find(p=>p.id===o.parent_id);
    return '<div class="option-group"><h3>'+esc(o.symbol)+' '+badge(o.result?.state??o.presentation)+'</h3><p class="section-note">'+esc(o.work?.reason??"Bounded comparison; no execution")+'</p>'+(o.result?.rows?.map(r=>{
      const metrics=optionMetrics(r,p,now);
      return '<div class="option-row"><div><strong>'+esc(r.right)+'</strong><small>'+esc(r.expiration)+' · '+money(r.strike)+'</small><small>'+esc(r.symbol)+'</small></div><div>'+badge(r.mode)+'<small>'+esc(r.limitation)+'</small></div><div><strong>'+money(r.debit)+'</strong><small>1 contract · gross ask debit</small></div><div>'+money(r.bid)+' / '+money(r.ask)+'<small>Spread '+number(metrics.spread)+'% · '+money(r.spread_cost)+'</small></div><div><small>Quote age '+number(metrics.age,1)+'s</small><small>Underlying skew '+number(metrics.skew,1)+'s</small><small>Expires '+esc(clock(r.valid_until))+'</small></div></div>';
    }).join("")||empty("No current qualified comparison. No liquidity conclusion is implied."))+'</div>';
  }).join("")||empty("No current qualified option comparison. Options require a currently available underlying and independently qualified quote evidence."));
  set("sources",'<dl>'+pair("Discovery rows",esc(discovery?.received_count))+pair("Source event time",esc(discovery?.source_event_meaning??"NOT AVAILABLE"))+pair("Underlying source time",esc(clock(dh.webull_source_at)))+pair("Observation basis",esc(h.observation_basis))+'</dl><details><summary>Activation checks ('+(h.activation_gates?.length??0)+')</summary><ul>'+(h.activation_gates??[]).map(x=>'<li>'+esc(x)+'</li>').join("")+'</ul></details>'+(payload?.capabilities??[]).map(c=>'<div class="row">'+esc(c.capability_id)+' '+badge(c.status)+'<small>'+esc(c.reason)+' · valid until '+esc(clock(c.valid_until))+'</small></div>').join(""));
  const activeIds=new Set(state.active.map(p=>p.id));
  set("history",(payload?.history??[]).filter(p=>!activeIds.has(p.id)).map(p=>'<div class="row"><strong>'+esc(p.symbol)+'</strong>'+badge(shownStatus(p,now))+'<small>'+esc(clock(p.checked_at??p.triggered_at))+' · '+esc(p.reason)+'</small>'+details(p)+'</div>').join("")||empty("No historical setup events published."));
  const coverage=payload?.coverage,news=payload?.news_summary;
  set("coverage",'<dl>'+pair("Acquired / enriched",esc(coverage?.acquired)+' / '+esc(coverage?.admitted))+pair("Capacity exclusions",esc(coverage?.capacity_excluded))+pair("Monitoring commitments",esc(coverage?.protected_count))+pair("Headlines / events",esc(news?.articles)+' / '+esc(news?.events))+'</dl><p class="section-note">Capacity exclusion is not a rejected setup. Headline presence is not a verified catalyst. Unsupported publication timestamps are not displayed.</p>');
  set("tracking",(payload?.tracking??[]).map(p=>'<div class="row"><strong>'+esc(p.symbol)+'</strong>'+badge(p.status)+'<p>'+esc(p.reason)+'</p><small>Observed entry '+money(p.entry)+' · MFE '+money(p.mfe)+' · MAE '+money(p.mae)+' · costs '+esc(p.costs)+'</small></div>').join("")||empty("No paper positions. Execution remains disabled pending qualification and separate activation."));
  return state;
}
