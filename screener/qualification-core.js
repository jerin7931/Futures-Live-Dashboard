// Isolated test envelopes only. Normal app.js never imports this module.
export function acceptEnvelope(e,run,previous,now){
  if(e?.test_only!==true||e.run_id!==run||!Number.isSafeInteger(e.sequence)||e.sequence<=0)
    throw Error('INVALID_TEST_ENVELOPE');
  if(!['CONTROLLED_MARKET_OBSERVATION','HOSTED_SYNTHETIC_WALL_CLOCK'].includes(e.basis))throw Error('UNKNOWN_TEST_BASIS');
  if(e.source_is_synthetic!==(e.basis==='HOSTED_SYNTHETIC_WALL_CLOCK'))throw Error('BASIS_MISMATCH');
  if(!e.payload?.health?.mode?.startsWith('ISOLATED_'))throw Error('NORMAL_PROJECTION_REFUSED');
  const created=Date.parse(e.generated_at);
  if(!Number.isFinite(created)||created>now+2000)throw Error('INVALID_TEST_TIME');
  if(previous&&e.sequence<=previous.sequence)return null;
  return e;
}
export function witnessSample(e,state,received,now,paused){
  return {observed_at:new Date(now).toISOString(),sequence:e.sequence,received_at:received,
    generated_at:e.generated_at,basis:e.basis,phase:e.phase??'OBSERVATION',reads_paused:paused,
    active:state.active.map(p=>({id:p.id,attempt_id:p.attempt_id,source_at:p.underlying_source_at,
      checked_at:p.checked_at,expires:p.availability_valid_until,age_ms:now-Date.parse(p.underlying_source_at)})),
    options:state.options.flatMap(o=>(o.result?.rows??[]).map(r=>({symbol:r.symbol,source_at:r.source_at,expires:r.valid_until}))),
    health_fresh:state.fresh};
}
