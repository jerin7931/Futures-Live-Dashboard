import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {acceptEnvelope,witnessSample} from '../screener/qualification-core.js';
const t=Date.parse('2026-09-19T15:00:00Z'),e={test_only:true,run_id:'test',sequence:1,basis:'HOSTED_SYNTHETIC_WALL_CLOCK',source_is_synthetic:true,generated_at:new Date(t).toISOString(),payload:{health:{mode:'ISOLATED_SYNTHETIC'}}};
test('isolated envelopes distinguish synthetic/live and reject normal records',()=>{
  assert.equal(acceptEnvelope(e,'test',null,t),e);
  for(const altered of [{test_only:false},{run_id:'another'},{source_is_synthetic:false},{basis:'UNKNOWN'},{payload:{health:{mode:'LIVE_PAPER'}}}])assert.throws(()=>acceptEnvelope({...e,...altered},'test',null,t));
});
test('old test sequences and future timestamps cannot refresh cached evidence',()=>{
  assert.equal(acceptEnvelope(e,'test',e,t),null);
  assert.throws(()=>acceptEnvelope({...e,generated_at:new Date(t+2100).toISOString()},'test',null,t));
});
test('redacted witness has real source age and excludes prices and identities',()=>{
  const s=witnessSample(e,{active:[{id:'p',underlying_source_at:new Date(t-1500).toISOString(),price:111}],options:[],fresh:true},new Date(t).toISOString(),t,false);
  assert.equal(s.active[0].age_ms,1500);assert.equal(s.active[0].price,undefined);
});
test('hosted test reads only isolated events and shares production renderer',()=>{
  const code=readFileSync(new URL('../screener/qualification.js',import.meta.url),'utf8');
  assert.match(code,/from '\.\/view.js'/);assert.match(code,/\.eq\('kind','QUALIFICATION_TEST'\)/);
  assert.doesNotMatch(code,/\.from\('fos_current'\)|\.insert\(|\.update\(|\.upsert\(|\.rpc\(/);
  assert.match(code,/SIGNED_OUT/);assert.match(code,/setInterval\(frame,250\)/);
  for(const check of ['momentum_rendered','target_response_rendered','concentration_rendered','target_response_expired_without_write','momentum_expired_without_write'])assert.match(code,new RegExp(check));
  assert.doesNotMatch(readFileSync(new URL('../screener/app.js',import.meta.url),'utf8'),/QUALIFICATION_TEST|qualification.js/);
});
