import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,existsSync} from "node:fs";
import {render,visibleState,geometry,optionMetrics,currentMomentum,momentumLine,concentrationGroups,currentTargetResponse} from "../screener/view.js";
const read=p=>readFileSync(new URL("../"+p,import.meta.url),"utf8");
const now=Date.parse("2026-09-21T13:40:00Z"),date=s=>new Date(now+s*1000).toISOString();
const parent={id:"p",symbol:"FIXTURE",direction:"LONG",status:"AVAILABLE",review:"APPROVED",attempt_id:"a",contract_version:1,availability_valid_until:date(8),entry_deadline:date(60),approval_deadline:date(60),session_close:date(3600),underlying_source_at:date(-1),underlying_price:"100.20",stop:"99.80",target:"101",entry_low:"100.10",entry_high:"100.25",quality_rank:1,main_reason:"Measured direction",three_group_assessments:{WHY_TODAY:"Observed activity",DIRECTION_NOW:"SUPPORTED"}};
function root(){const elements=new Map();return {elements,getElementById(id){if(!elements.has(id))elements.set(id,{innerHTML:"",hasChildNodes(){return Boolean(this.innerHTML);}});return elements.get(id);}};}
test("root opens the authenticated seven-page workstation with no retired root modules",()=>{
 const html=read("index.html");assert.match(html,/src="\.\/screener\/app.js\?v=3\.0\.20"/);
 for(const id of ["auth","dashboard","login","signOut","primaryNav","page","detailOverlay","demoBanner"])assert.ok(html.includes('id="'+id+'"'));
 for(const route of ["home","opportunities","tracking","market","sectors","news","watchlist"])assert.ok(html.includes('data-route="'+route+'"'));
 for(const p of ["app.js","core.js","gamma.js","styles.css"])assert.equal(existsSync(new URL("../"+p,import.meta.url)),false);
 assert.doesNotMatch(html,/gamma|insiderfinance|spyCard|qqqCard/);
 assert.match(html,/frame-src 'none'/);
});
test("reader authentication remains and the only browser write is owner-RLS watchlist persistence",()=>{
 const app=read("screener/app.js");assert.match(app,/dashboard_readers/);assert.match(app,/signInWithPassword/);assert.match(app,/SIGNED_OUT/);
 assert.match(app,/fos_current/);assert.match(app,/fos_watchlist/);assert.match(app,/\.upsert\(\{user_id:userId,symbol,pinned:true\}/);
 assert.match(app,/if\(busy\)\{refreshAgain=true;return;\}/);assert.match(app,/if\(refreshAgain\)\{refreshAgain=false;return refresh\(\);\}/);
 assert.doesNotMatch(app,/intraday_analysis|\.rpc\(|placeOrder|WebSocket|fetch\(/);
 assert.match(read("screener/index.html"),/Opportunity Radar/);
});
test("active/ranked limits and disabled option suppression remain independent",()=>{
 const ps=Array.from({length:12},(_,i)=>({...parent,id:"p"+i}));
 const payload={health:{checked_at:date(0),actionable_enabled:true,options_enabled:false},active:ps,ranked:ps,options:[{parent_id:"p0",result:{parent_attempt_id:"a",parent_contract_version:1,valid_until:date(8),rows:[{valid_until:date(8)}]}}]};
 const state=visibleState(payload,now);assert.equal(state.active.length,3);assert.equal(state.ranked.length,10);assert.equal(state.options[0].result,null);
 payload.health.actionable_enabled=false;assert.equal(visibleState(payload,now).active.length,0);
});
test("gross geometry and quote metrics use actual values without invented zeroes",()=>{
 assert.ok(Math.abs(geometry(parent).r-2)<1e-10);assert.equal(geometry({...parent,underlying_price:null}).r,null);
 assert.deepEqual(optionMetrics({source_at:date(-3),spread_fraction:".02"},parent,now),{age:3,skew:2,spread:2});
});
test("render shows contract, countdown, observed news and separate nonactionable journal",()=>{
 const r=root();const p={...parent,display:{news:[{title:"<img src=x>",source:"Example",published_at:date(-120),first_seen_at:date(-20)}]}};
 render(r,{health:{mode:"PAPER",checked_at:date(0),actionable_enabled:true},active:[p],ranked:[p],history:[p,{...p,id:"old",status:"EXPIRED"}]},now);
 const card=r.elements.get("active").innerHTML;for(const text of ["8s evidence remaining","WHY TODAY","DIRECTION NOW","Invalidation","Gross R","Published","First observed","&lt;img src=x&gt;"])assert.ok(card.includes(text),text);
 assert.doesNotMatch(card,/<img/);assert.equal((r.elements.get("history").innerHTML.match(/<strong>FIXTURE/g)||[]).length,1);
 render(r,{health:{checked_at:date(0),actionable_enabled:false},active:[p],ranked:[p]},now);
 assert.doesNotMatch(r.elements.get("active").innerHTML,/FIXTURE/);
});
test("expiry removes action without a publication and stale rank expires",()=>{
 assert.equal(visibleState({health:{checked_at:date(0),actionable_enabled:true},active:[parent]},now+8000).active.length,0);
 assert.equal(visibleState({health:{checked_at:date(0),actionable_enabled:true},ranked:[{...parent,quality_valid_until:date(-1)}]},now).ranked.length,0);
});
test("CAPTURE_ONLY wins over a contradictory actionable flag",()=>{
 const state=visibleState({health:{mode:"CAPTURE_ONLY",checked_at:date(0),actionable_enabled:true},active:[parent],ranked:[parent]},now);
 assert.equal(state.enabled,false);assert.equal(state.active.length,0);assert.equal(state.ranked.length,0);
});
test("compact momentum is direction-symmetric and expires without a write",()=>{
 const base={descriptive_only:true,parent_id:"p",parent_attempt_id:"a",parent_contract_version:1,valid_until:date(5),directional_efficiency:".78",pace_to_target_minutes:"5"};
 const long={...parent,momentum_context:{...base,six_close_raw_move_pct:".92",raw_velocity_pct_per_min:".184"}};
 const short={...parent,direction:"SHORT",momentum_context:{...base,six_close_raw_move_pct:"-.74",raw_velocity_pct_per_min:"-.148"}};
 assert.match(momentumLine(long,now),/MOVE \+0\.92%.*EFF 0\.78.*SPEED \+0\.18%\/m.*PACE ~5\.0m/);
 assert.match(momentumLine(short,now),/MOVE -0\.74%.*SPEED -0\.15%\/m/);
 assert.equal(currentMomentum(long,now+5000),null);
 assert.equal(currentMomentum({...long,attempt_id:"replacement"},now),null);
 assert.match(momentumLine(long,now+5000),/MOVE —%.*SPEED —%\/m.*PACE —/);
});
test("target response requires current supported evidence and expires locally",()=>{
 const response={supported:true,target_move_pct:".89",estimated_option_low:"1.88",estimated_option_high:"2.03",estimated_return_low_pct:"19",estimated_return_high_pct:"28",valid_until:date(4)};
 assert.equal(currentTargetResponse({target_response:response},now),response);
 assert.equal(currentTargetResponse({target_response:response},now+4000),null);
 assert.equal(currentTargetResponse({target_response:{...response,supported:false}},now),null);
});
test("industry overlap is exact same-direction evidence only and escaped",()=>{
 const same=[{...parent,symbol:"AAA",display:{industry:"Semi<script>"}},{...parent,id:"b",symbol:"BBB",display:{industry:"Semi<script>"}}];
 assert.deepEqual(concentrationGroups(same)[0].symbols,["AAA","BBB"]);
 assert.equal(concentrationGroups([same[0],{...same[1],direction:"SHORT"}]).length,0);
 assert.equal(concentrationGroups([same[0],{...same[1],display:{}}]).length,0);
 const r=root();render(r,{health:{mode:"PAPER",checked_at:date(0),actionable_enabled:true},active:same,ranked:same},now);
 const warning=r.elements.get("concentration").innerHTML;
 assert.match(warning,/INDUSTRY OVERLAP/);assert.match(warning,/Semi&lt;script&gt;/);assert.doesNotMatch(warning,/<script>/);
});
test("renderer shows compact option response and unavailable quote-only state",()=>{
 const r=root(),response={supported:true,target_move_pct:".89",estimated_option_low:"1.88",estimated_option_high:"2.03",estimated_return_low_pct:"19",estimated_return_high_pct:"28",valid_until:date(7)};
 const option={parent_id:"p",result:{state:"QUALIFIED_CONTRACTS",parent_attempt_id:"a",parent_contract_version:1,valid_until:date(8),rows:[{valid_until:date(8),source_at:date(-1),right:"CALL",mode:"SENSITIVITY_ASSISTED",target_response:response}]}};
 render(r,{health:{mode:"PAPER",checked_at:date(0),actionable_enabled:true},active:[parent],ranked:[parent],options:[option]},now);
 assert.match(r.elements.get("options").innerHTML,/TARGET MOVE \+0\.89% · EST RESPONSE \+19–28%/);
 assert.match(r.elements.get("options").innerHTML,/EST\. OPTION AT TARGET \$1\.88–\$2\.03/);
 option.result.rows[0].target_response={...response,supported:false};render(r,{health:{mode:"PAPER",checked_at:date(0),actionable_enabled:true},active:[parent],ranked:[parent],options:[option]},now);
 assert.match(r.elements.get("options").innerHTML,/OPTION RESPONSE — UNAVAILABLE/);
});
test("responsive workstation styles keep the radar table bounded without page-level overflow",()=>{
 const css=read("screener/styles.css");assert.match(css,/\.momentum-line\{[^}]*flex-wrap:wrap/);assert.match(css,/\.option-response\{[^}]*overflow-wrap:anywhere/);
 assert.match(css,/\.radar-table\{[^}]*table-layout:fixed/);assert.match(css,/html,body\{[^}]*overflow-x:hidden/);
 for(const html of [read("index.html"),read("screener/index.html")])assert.match(html,/id="detailOverlay"/);
});
