export const esc=v=>String(v??"—").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const time=v=>Date.parse(v);
export function currentParent(p,now){
  return p?.status==="AVAILABLE" && p.review==="APPROVED" &&
    ["availability_valid_until","entry_deadline","approval_deadline","session_close"].every(k=>Number.isFinite(time(p[k]))&&now<time(p[k]));
}
export function visibleState(payload,now){
  const h=payload?.health??{};
  const age=now-time(h.checked_at);
  const fresh=Number.isFinite(age)&&age>=-2000&&age<15000;
  const enabled=fresh&&h.actionable_enabled===true;
  const active=enabled?(payload.active??[]).filter(p=>currentParent(p,now)).slice(0,3):[];
  const options=(payload?.options??[]).map(o=>{
    const parent=active.find(p=>p.id===o.parent_id);
    const result=o.result;
    const valid=parent&&result&&result.parent_attempt_id===parent.attempt_id&&result.parent_contract_version===parent.contract_version&&now<time(result.valid_until);
    return {...o,result:valid?{...result,rows:result.rows.filter(r=>now<time(r.valid_until))}:null,
      presentation:valid?"CURRENT_COMPARISON":!parent?"PARENT_UNAVAILABLE":result?"EXPIRED":"NO_CURRENT_COMPARISON"};
  });
  return {fresh,enabled,active,options,ranked:enabled?(payload.ranked??[]):[],contenders:enabled?(payload.contenders??[]):[]};
}
export const money=v=>v===null||v===undefined||v===""||typeof v==="boolean"?"—":Number.isFinite(Number(v))?"$"+Number(v).toFixed(2):"—";
const empty=text=>'<p class="empty">'+esc(text)+'</p>';
const badge=v=>'<span class="badge">'+esc(String(v??"UNKNOWN").replaceAll("_"," "))+'</span>';
const rendered=new WeakMap();
export function render(root,payload,now){
  if(!rendered.has(root))rendered.set(root,new Map());
  const cache=rendered.get(root);
  const set=(id,html)=>{const element=root.getElementById(id);if(!element)return;if(cache.get(id)!==html||!element.hasChildNodes()){element.innerHTML=html;cache.set(id,html);}};
  const state=visibleState(payload,now),h=payload?.health??{};
  set("health",'<div class="health-line">'+badge(h.mode??"NOT STARTED")+badge(state.fresh?"WORKER RECENT":"WORKER STALE / STOPPED")+badge(h.session?.state??"SESSION UNKNOWN")+'</div><h2>'+(state.enabled?"Entry availability follows current evidence.":"Live opportunities are not enabled.")+'</h2><p>'+(state.enabled?"No model call is required to confirm an approved candle.":"Capture and engineering validation are separate from live qualification. No stock or option recommendation is being published.")+'</p><details><summary>Activation checks ('+(h.activation_gates?.length??0)+')</summary><ul>'+(h.activation_gates??[]).map(x=>'<li>'+esc(x)+'</li>').join("")+'</ul></details>');
  set("active",state.active.map(p=>'<article class="panel setup"><div>'+badge(p.direction)+badge(p.status)+'</div><h2>'+esc(p.symbol)+'</h2><p>'+esc(p.main_reason)+'</p><dl><dt>Entry band</dt><dd>'+money(p.entry_low)+' – '+money(p.entry_high)+'</dd><dt>Invalidation</dt><dd>'+money(p.stop)+'</dd><dt>Target reference</dt><dd>'+money(p.target)+'</dd><dt>Concern</dt><dd>'+esc(p.main_concern)+'</dd><dt>Evidence expires</dt><dd>'+esc(p.availability_valid_until)+'</dd></dl></article>').join("")||empty("No currently available entry. This is not the same as a bearish or bullish view."));
  set("ranking",state.ranked.length?'<div class="table-wrap"><table><thead><tr><th>Rank</th><th>Symbol / direction</th><th>State</th><th>Main concern</th></tr></thead><tbody>'+state.ranked.map(p=>'<tr><td>'+esc(p.quality_rank)+'</td><td>'+esc(p.symbol)+'<small>'+esc(p.direction)+'</small></td><td>'+badge(currentParent(p,now)?p.status:p.status==="AVAILABLE"?"EXPIRED":p.status)+'</td><td>'+esc(p.main_concern)+'</td></tr>').join("")+'</tbody></table></div>':empty("No qualified ranking yet. Discovery order is not a quality ranking."));
  set("contenders",state.contenders.map(p=>'<div class="row"><strong>'+esc(p.symbol)+'</strong>'+badge(p.status)+'<p>'+esc(p.main_reason)+'</p></div>').join("")||empty("No contenders published."));
  set("options",state.options.map(o=>'<div class="option-group"><h3>'+esc(o.symbol)+' '+badge(o.result?.state??o.presentation)+'</h3><p>'+esc(o.work?.work_status)+' · '+esc(o.work?.reason??"Bounded comparison")+'</p>'+(o.result?.rows?.map(r=>'<div class="option-row"><div><strong>'+esc(r.symbol)+'</strong><small>'+esc(r.right)+' · '+esc(r.expiration)+' · strike '+esc(r.strike)+'</small></div><div>'+badge(r.mode)+'<small>'+esc(r.limitation)+'</small></div><div><strong>'+money(r.debit)+'</strong><small>1 contract, gross ask debit</small></div><div>'+money(r.bid)+' / '+money(r.ask)+'<small>Spread cost '+money(r.spread_cost)+'</small></div><div><small>Source '+esc(r.source_at)+'</small><small>Expires '+esc(r.valid_until)+'</small></div></div>').join("")||empty("No current contract comparison. No liquidity conclusion is implied."))+'</div>').join("")||empty("Options are separately qualified and serviced only for an available parent setup."));
  const discovery=payload?.discovery;
  set("sources",'<dl><dt>Discovery rows</dt><dd>'+esc(discovery?.received_count)+'</dd><dt>Received</dt><dd>'+esc(discovery?.received_at)+'</dd><dt>Source event time</dt><dd>'+esc(discovery?.source_event_meaning??"NOT AVAILABLE")+'</dd><dt>Coverage</dt><dd>'+esc(discovery?.coverage)+'</dd><dt>Quote observation</dt><dd>'+esc(h.observation_basis)+'</dd></dl>'+(payload?.capabilities??[]).map(c=>'<div class="row">'+esc(c.capability_id)+' '+badge(c.status)+'<small>'+esc(c.reason)+'</small></div>').join(""));
  set("history",(payload?.history??[]).map(p=>'<div class="row"><strong>'+esc(p.symbol)+'</strong> '+badge(currentParent(p,now)?p.status:p.status==="AVAILABLE"?"EXPIRED":p.status)+'<small>'+esc(p.reason)+'</small></div>').join("")||empty("No setup history yet."));
  const coverage=payload?.coverage,news=payload?.news_summary;
  set("coverage",'<dl><dt>Acquired / enriched</dt><dd>'+esc(coverage?.acquired)+' / '+esc(coverage?.admitted)+'</dd><dt>Capacity exclusions</dt><dd>'+esc(coverage?.capacity_excluded)+'</dd><dt>Protected tracking symbols</dt><dd>'+esc(coverage?.protected_count)+'</dd><dt>Headlines / grouped events</dt><dd>'+esc(news?.articles)+' / '+esc(news?.events)+'</dd><dt>News scope</dt><dd>'+esc(news?.scope??"Not acquired")+'</dd></dl><p>Capacity exclusion is not a failed trading setup. Headline presence is not a verified catalyst.</p>');
  set("tracking",(payload?.tracking??[]).map(p=>'<div class="row"><strong>'+esc(p.symbol)+'</strong> '+badge(p.status)+'<p>'+esc(p.reason)+'</p><small>Observed entry '+money(p.entry)+' · MFE '+money(p.mfe)+' · MAE '+money(p.mae)+' · costs '+esc(p.costs)+'</small></div>').join("")||empty("No paper positions. Tracking stays disabled until activation review and live qualification."));
  return state;
}
