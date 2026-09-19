import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,existsSync} from "node:fs";
import {render,visibleState,geometry,optionMetrics} from "../screener/view.js";
const read=p=>readFileSync(new URL("../"+p,import.meta.url),"utf8");
const now=Date.parse("2026-09-21T13:40:00Z"),date=s=>new Date(now+s*1000).toISOString();
const parent={id:"p",symbol:"FIXTURE",direction:"LONG",status:"AVAILABLE",review:"APPROVED",attempt_id:"a",contract_version:1,availability_valid_until:date(8),entry_deadline:date(60),approval_deadline:date(60),session_close:date(3600),underlying_source_at:date(-1),underlying_price:"100.20",stop:"99.80",target:"101",entry_low:"100.10",entry_high:"100.25",quality_rank:1,main_reason:"Measured direction",three_group_assessments:{WHY_TODAY:"Observed activity",DIRECTION_NOW:"SUPPORTED"}};
function root(){const elements=new Map();return {elements,getElementById(id){if(!elements.has(id))elements.set(id,{innerHTML:"",hasChildNodes(){return Boolean(this.innerHTML);}});return elements.get(id);}};}
test("root opens screener directly with existing auth and no retired routes/modules",()=>{
 const html=read("index.html");assert.match(html,/src="\.\/screener\/app.js"/);
 for(const id of ["auth","dashboard","login","signOut","opportunities","ranked","journal"])assert.ok(html.includes('id="'+id+'"'));
 for(const p of ["app.js","core.js","gamma.js","styles.css","tests/dashboard.test.mjs"])assert.equal(existsSync(new URL("../"+p,import.meta.url)),false);
 assert.doesNotMatch(html,/SPY|QQQ|gamma|insiderfinance|spyCard|qqqCard/);
 assert.match(html,/frame-src 'none'/);
});
test("reader authentication remains and browser contains no writer calls",()=>{
 const app=read("screener/app.js");assert.match(app,/dashboard_readers/);assert.match(app,/signInWithPassword/);assert.match(app,/SIGNED_OUT/);
 assert.match(app,/fos_current/);assert.doesNotMatch(app,/intraday_analysis|\.rpc\(|\.insert\(|\.upsert\(|\.update\(/);
 assert.match(read("screener/index.html"),/The opportunity desk/);
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
 const r=root();const p={...parent,display:{news:[{title:"<img src=x>",source:"Example",first_seen_at:date(-20)}]}};
 render(r,{health:{mode:"CAPTURE_ONLY",checked_at:date(0),actionable_enabled:true},active:[p],ranked:[p],history:[p,{...p,id:"old",status:"EXPIRED"}]},now);
 const card=r.elements.get("active").innerHTML;for(const text of ["8s evidence remaining","WHY TODAY","DIRECTION NOW","Invalidation","Gross R","First observed","&lt;img src=x&gt;"])assert.ok(card.includes(text),text);
 assert.doesNotMatch(card,/<img/);assert.equal((r.elements.get("history").innerHTML.match(/<strong>FIXTURE/g)||[]).length,1);
 render(r,{health:{checked_at:date(0),actionable_enabled:false},active:[p],ranked:[p]},now);
 assert.doesNotMatch(r.elements.get("active").innerHTML,/FIXTURE/);
});
test("expiry removes action without a publication and stale rank expires",()=>{
 assert.equal(visibleState({health:{checked_at:date(0),actionable_enabled:true},active:[parent]},now+8000).active.length,0);
 assert.equal(visibleState({health:{checked_at:date(0),actionable_enabled:true},ranked:[{...parent,quality_valid_until:date(-1)}]},now).ranked.length,0);
});
