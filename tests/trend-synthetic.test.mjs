import test from "node:test";
import assert from "node:assert/strict";
import {trendVisibleState,trendCardsHTML} from "../screener/view.js";

const now=Date.parse("2026-09-22T14:00:00Z");
const at=s=>new Date(now+s*1000).toISOString();
const payload={trend_shadow:{synthetic:true,test_namespace:"trend-v1-synthetic",scenario_id:"clean-long",
  lifecycles:[{symbol:"SYN<1>",direction:"LONG",status:"AVAILABLE",detector_state:"CONFIRMED",basis_end_at:at(-1),valid_until:at(10)}],
  leading_states:[{symbol:"SYN<1>",source_valid:true,price:"101.20",efficiency:"0.80",displacement:{"5":{raw_pct:"1.20"}},selected_v1_shadow_triggers:[{family:"ROLLING_STRUCTURAL_BREAK",price:"101.10",at:at(-2)}]}],
  ranking:{rows:[{symbol:"SYN<1>",rank:1}]},
  alerts:[{kind:"NEW_OPPORTUNITY",valid_until:at(10)}]}};

test("synthetic trend is isolated and browser-expired without a write",()=>{
  assert.equal(trendVisibleState(payload,now).states[0].status,"AVAILABLE");
  assert.equal(trendVisibleState(payload,now+10000).states[0].status,"EXPIRED");
  assert.equal(trendVisibleState(payload,now+10000).alerts.length,0);
});
test("production payload does not render synthetic cards",()=>assert.equal(trendCardsHTML({trend_shadow:{synthetic:false}},now),""));
test("trend renderer escapes provider strings",()=>{
  const html=trendCardsHTML(payload,now);
  assert.match(html,/SYN&lt;1&gt;/);assert.doesNotMatch(html,/SYN<1>/);assert.match(html,/NOT A SIGNAL/);
  assert.match(html,/ROLLING_STRUCTURAL_BREAK/);assert.match(html,/Current price/);assert.match(html,/WHY NOW/);assert.match(html,/source FRESH/);
});
test("all lifecycle labels render without changing normal signal state",()=>{
  const statuses=["WATCH","CONFIRMING","CONFIRMED","AVAILABLE","DEGRADING","REVERSED","EXPIRED"];
  const copy=structuredClone(payload);copy.trend_shadow.display_limit=10;copy.trend_shadow.lifecycles=statuses.map((status,i)=>({
    symbol:`SYN${i}`,direction:i%2?"SHORT":"LONG",status,detector_state:"CONFIRMED",basis_end_at:at(-1),valid_until:at(10)}));
  const html=trendCardsHTML(copy,now);
  for(const status of statuses)assert.match(html,new RegExp(status));
});
