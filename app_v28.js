(()=>{'use strict';
const cfg=window.DASHBOARD_CONFIG||{}; const $=id=>document.getElementById(id); const $$=s=>[...document.querySelectorAll(s)];
if(!cfg.supabaseUrl||!cfg.supabasePublishableKey){document.body.innerHTML='<div class="auth-shell"><div class="auth-card"><h1>config.js required</h1></div></div>';return;}
const client=window.supabase.createClient(cfg.supabaseUrl,cfg.supabasePublishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});

const FETCH_TFS=['1m','5m','10m','15m','1h','4h','1d'];
const SYMBOL_ALIASES={ES:['ES','MES'],NQ:['NQ','MNQ']};
const TF_ALIASES={'1m':['1m'],'5m':['5m'],'10m':['10m'],'15m':['15m'],'1h':['1h','60m'],'4h':['4h','240m'],'1d':['1d','1D','D','day']};
const ST_TFS=['1m','5m','10m','15m','1h','4h','1d'];
const TF_LABEL={'1m':'1m','5m':'5m','10m':'10m','15m':'15m','1h':'1h','4h':'4h','1d':'Daily'};
const TF_MIN={'1m':1,'5m':5,'10m':10,'15m':15,'1h':60,'4h':240,'1d':1380};
const FALLBACKS={'1m':[],'5m':['1m'],'10m':['5m','1m'],'15m':['5m','1m'],'1h':['15m','10m','5m','1m'],'4h':['1h','15m','10m','5m'],'1d':['4h','1h']};

const state={
  session:null,quotes:[],bars:[],footprints:[],levels:[],events:[],resolutions:[],health:[],
  symbol:'ES',tf:'5m',selected:null,channel:null,fetchTimers:{},quoteSignature:'',
  marketChart:null,marketCandles:null,marketDelta:null,marketIndicators:null,marketPriceLines:[],
  reactionChart:null,reactionCandles:null,reactionDelta:null,reactionPriceLines:[],
  chartZoomLock:{market:true,reaction:true},chartInitialized:{market:false,reaction:false},
  indicatorVisibility:{ema9:true,ema21:true,vwap:true},
  barsFetchSeq:0
};
window.FM_ORDERFLOW_CLIENT=client; window.FM_ORDERFLOW_STATE=state;
window.FM_ACTIVE_TRADE_HELPERS={currentPrice:(symbol)=>currentQuotePrice(symbol)};

const esc=x=>String(x??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const fmt=(x,d=2)=>Number.isFinite(Number(x))?Number(x).toFixed(d):'—';
const hasNum=x=>x!==null&&x!==undefined&&x!==''&&Number.isFinite(Number(x));
const pct=x=>hasNum(x)?`${(100*Number(x)).toFixed(1)}%`:'PENDING';
const zone=()=>cfg.timezone||'America/Chicago';
const ct=x=>{if(!x)return'—';try{return new Intl.DateTimeFormat('en-US',{timeZone:zone(),month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(x));}catch{return String(x)}};
const chartDate=t=>{if(typeof t==='number')return new Date(t*1000);if(typeof t==='string')return new Date(t);if(t&&typeof t==='object'&&Number.isFinite(Number(t.year)))return new Date(Date.UTC(Number(t.year),Number(t.month||1)-1,Number(t.day||1)));return null;};
const chartAxisTime=t=>{const d=chartDate(t);if(!d||Number.isNaN(d.getTime()))return null;try{return new Intl.DateTimeFormat('en-US',{timeZone:zone(),hour:'numeric',minute:'2-digit'}).format(d).replace(' ','');}catch{return null;}};
const chartCrosshairTime=t=>{const d=chartDate(t);if(!d||Number.isNaN(d.getTime()))return'—';try{return new Intl.DateTimeFormat('en-US',{timeZone:zone(),month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(d);}catch{return d.toISOString();}};

function toast(m){const n=$('toast');if(!n)return;n.textContent=m;n.classList.remove('hidden');setTimeout(()=>n.classList.add('hidden'),2200)}
function setTab(name){state.activeTab=name;$$('.tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===name));$$('.tab-panel').forEach(p=>p.classList.toggle('active',p.id===`tab-${name}`));if(name==='trades')window.dispatchEvent(new CustomEvent('fm-tab-changed',{detail:{tab:'trades'}}));setTimeout(()=>{state.marketChart?.applyOptions({width:$('marketChart')?.clientWidth||800});state.reactionChart?.applyOptions({width:$('reactionChart')?.clientWidth||800})},50)}
function health(service){return state.health.find(x=>x.service===service)||{}}
function statusTone(s){s=String(s||'WAITING').toUpperCase();return s==='LIVE'||s==='READY'?'live':s==='DEGRADED'||s==='ERROR'?'error':'waiting'}
// V28_REACTION_DAY_FAILSAFE_V1_0_0
function exchangeTradingDayNow(){
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{
    timeZone:zone(),year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',hourCycle:'h23'
  }).formatToParts(new Date()).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
  const d=new Date(Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day)));
  if(Number(parts.hour)>=17)d.setUTCDate(d.getUTCDate()+1);
  return d.toISOString().slice(0,10);
}
function reactionTradingDay(){
  const d=String(health('es_reaction_model')?.metadata?.trading_day||'');
  return /^\d{4}-\d{2}-\d{2}$/.test(d)?d:exchangeTradingDayNow();
}
function reactionProbText(r,field){
  const v=r?.[field];
  if(hasNum(v))return pct(v);
  const s=String(r?.state||'').toUpperCase();
  if(s==='STRUCTURAL')return'WAIT TOUCH';
  if(s==='APPROACHING')return'WATCHING';
  if(s==='TOUCHED_WAITING_5M')return'WAIT 5M';
  if(s==='SCORED')return'SCORED';
  return'WAITING';
}
function badge(id,h,label){const n=$(id);if(!n)return;const s=String(h.status||'WAITING').toUpperCase();n.className=`badge ${statusTone(s)}`;n.textContent=`${label} ${s}`;}
function selectedLevel(){return state.levels.find(x=>x.level_id===state.selected)||state.levels[0]||null}
function normalizeBaseSymbol(value){
  const s=String(value||'').trim().toUpperCase().replace(/^\//,'').replaceAll('_',' ').replaceAll('-',' ');
  const token=s.split(/\s+/)[0];
  if(token==='ES'||token==='MES'||token.startsWith('ES')||token.startsWith('MES'))return'ES';
  if(token==='NQ'||token==='MNQ'||token.startsWith('NQ')||token.startsWith('MNQ'))return'NQ';
  return token;
}
function quoteFor(base){return state.quotes.find(x=>normalizeBaseSymbol(x.symbol)===base)||{}}
function esQuote(){return quoteFor('ES')}
function currentQuotePrice(symbol){const base=normalizeBaseSymbol(symbol);return Number(quoteFor(base).last)}
function rawPriceAway(r){const level=Number(r?.level_price),last=Number(esQuote().last);return Number.isFinite(level)&&Number.isFinite(last)?Math.abs(level-last):NaN}

function renderCommandReaction(){
  const r=selectedLevel(),last=Number(esQuote().last),mh=health('es_reaction_model'),ms=String(mh.status||'WAITING').toUpperCase();
  if($('cmdEsLast'))$('cmdEsLast').textContent=fmt(last);
  if($('cmdRxModelStatus')){$('cmdRxModelStatus').textContent=ms;$('cmdRxModelStatus').dataset.status=statusTone(ms);}
  const ids=['cmdRxLevel','cmdRxReaction','cmdRxReject','cmdRxBreak','cmdRxAway'];
  if(!ids.every(id=>$(id)))return;
  if(!r){$('cmdRxLevel').textContent='—';$('cmdRxReaction').textContent=ms==='LIVE'?'WAITING CURRENT-DAY LEVELS':'WAITING';$('cmdRxReject').textContent='—';$('cmdRxBreak').textContent='—';$('cmdRxAway').textContent='—';return;}
  $('cmdRxLevel').textContent=fmt(r.level_price);$('cmdRxReaction').textContent=String(r.state||'—').replaceAll('_',' ');
  $('cmdRxReject').textContent=reactionProbText(r,'reaction_probability');$('cmdRxBreak').textContent=reactionProbText(r,'breakout_probability');$('cmdRxAway').textContent=fmt(rawPriceAway(r));
}
function renderQuotes(){
  const es=esQuote();
  if($('rxLast'))$('rxLast').textContent=fmt(es.last);
  if($('rxContract'))$('rxContract').textContent=es.contract||'—';
  renderCommandReaction();renderSelected();
  window.dispatchEvent(new CustomEvent('fm-market-quotes-updated',{detail:{quotes:state.quotes}}));
}
function renderHealth(){const f=health('market_feed'),m=health('es_reaction_model');badge('feedBadge',f,'FEED');badge('modelBadge',m,'MODEL');if($('feedHealth'))$('feedHealth').innerHTML=kv(f);if($('modelHealth'))$('modelHealth').innerHTML=kv(m);if($('rawHealth'))$('rawHealth').textContent=JSON.stringify(state.health,null,2);renderCommandReaction()}
function kv(h){const meta=h.metadata||{};return`<div><span>Status</span><strong>${esc(h.status||'—')}</strong></div><div><span>Updated</span><strong>${ct(h.updated_at)}</strong></div><div><span>Message</span><strong>${esc(h.message||'—')}</strong></div><div><span>Input</span><strong>${esc(meta.input_status||'—')}</strong></div>`}

function deltaFromPayload(p){
  for(const k of ['FP_Delta','delta','delta_volume','volume_delta','bid_ask_delta','net_delta']){const v=Number(p?.[k]);if(Number.isFinite(v))return v;}
  const ask=Number(p?.ask_volume??p?.buy_volume??p?.volume_ask),bid=Number(p?.bid_volume??p?.sell_volume??p?.volume_bid);
  if(Number.isFinite(ask)&&Number.isFinite(bid))return ask-bid;
  return null;
}
function rawFootprintDelta1m(symbol){
  return state.footprints
    .filter(r=>r.data_type==='footprint'&&normalizeBaseSymbol(r.symbol)===symbol&&r.timeframe==='1m'&&Number(r.bar_close_ms)<=Date.now())
    .map(r=>{
      const p=r.payload||{},delta=deltaFromPayload(p),deltaPct=Number(p.FP_Delta_Pct);
      return{
        time:Math.floor(Number(r.bar_open_ms)/1000),
        openMs:Number(r.bar_open_ms),
        closeMs:Number(r.bar_close_ms),
        delta,
        deltaPct:Number.isFinite(deltaPct)?deltaPct:null
      };
    })
    .filter(r=>[r.time,r.openMs,r.closeMs,r.delta].every(Number.isFinite))
    .sort((a,b)=>a.openMs-b.openMs);
}
function deltaBarsFor(symbol,tf,priceBars){
  const raw=rawFootprintDelta1m(symbol),bars=priceBars||[];
  const minuteKey=ms=>Math.floor(Number(ms)/60000);
  const oneMinPrice=rawBars(symbol,'1m');
  const volByMinute=new Map(oneMinPrice.map(x=>[minuteKey(x.openMs),Number(x.volume)]));

  const normalizePct=p=>{
    const n=Number(p);
    if(!Number.isFinite(n))return null;
    const pct=Math.abs(n)<=1?100*n:n;
    return Math.max(-100,Math.min(100,pct));
  };
  const deriveSignedPct=(row)=>{
    const backendPct=normalizePct(row?.deltaPct);
    if(Number.isFinite(Number(backendPct)))return Number(backendPct);

    const d=Number(row?.delta);
    const v=Number(volByMinute.get(minuteKey(row?.openMs)));
    if(Number.isFinite(d)&&Number.isFinite(v)&&v>0){
      return Math.max(-100,Math.min(100,100*d/v));
    }
    return null;
  };
  const impliedVolume=(row,signedPct)=>{
    const d=Math.abs(Number(row?.delta)),p=Math.abs(Number(signedPct));
    if(Number.isFinite(d)&&Number.isFinite(p)&&p>0)return 100*d/p;
    const v=Number(volByMinute.get(minuteKey(row?.openMs)));
    return Number.isFinite(v)&&v>0?v:null;
  };

  // 1m must be driven directly by the footprint stream. V1.1.3 mapped each
  // footprint row back to a price-bar millisecond timestamp; any timestamp
  // convention mismatch silently dropped otherwise-valid later delta rows.
  if(tf==='1m'){
    return raw.map(r=>{
      const signedValue=deriveSignedPct(r);
      if(!Number.isFinite(Number(signedValue)))return null;
      return{
        time:r.time,
        value:Math.abs(Number(signedValue)),
        signedValue:Number(signedValue),
        rawDelta:Number(r.delta),
        count:1,
        expected:1,
        partial:false
      };
    }).filter(Boolean);
  }

  const expected=TF_MIN[tf]||1,groups=new Map;
  for(const r of raw){
    const k=aggregateKey(r.openMs,tf);
    if(!groups.has(k))groups.set(k,[]);
    groups.get(k).push(r);
  }

  // Higher timeframes align by the chart's bucket key, not exact timestamps.
  //
  // IMPORTANT: the plotted bar is GROSS delta magnitude, not absolute NET delta.
  // V1.1.4 did abs(sum(signed delta)), so alternating buy/sell 1m deltas inside a
  // 10m/15m/1h bar cancelled each other and visually collapsed later sessions
  // toward zero even though valid footprint rows were present.
  //
  // Height = 100 * sum(abs(delta_i)) / sum(volume_i)
  // Color  = sign of the corresponding NET signed imbalance.
  return bars.map(b=>{
    const arr=groups.get(aggregateKey(b.openMs,tf))||[];
    if(arr.length){
      let grossAbsDelta=0,netSignedDelta=0,totalVolume=0;
      const fallbackAbsPct=[],fallbackSignedPct=[];

      for(const r of arr){
        const signedPct=deriveSignedPct(r);
        if(!Number.isFinite(Number(signedPct)))continue;

        const v=impliedVolume(r,signedPct);
        if(Number.isFinite(Number(v))&&Number(v)>0){
          const signedDeltaFromPct=(Number(signedPct)/100)*Number(v);
          grossAbsDelta+=Math.abs(signedDeltaFromPct);
          netSignedDelta+=signedDeltaFromPct;
          totalVolume+=Number(v);
        }else{
          fallbackAbsPct.push(Math.abs(Number(signedPct)));
          fallbackSignedPct.push(Number(signedPct));
        }
      }

      let magnitudePct=null,signedValue=null;
      if(totalVolume>0){
        magnitudePct=Math.max(0,Math.min(100,100*grossAbsDelta/totalVolume));
        signedValue=Math.max(-100,Math.min(100,100*netSignedDelta/totalVolume));
      }else if(fallbackAbsPct.length){
        magnitudePct=fallbackAbsPct.reduce((a,x)=>a+x,0)/fallbackAbsPct.length;
        signedValue=fallbackSignedPct.reduce((a,x)=>a+x,0)/fallbackSignedPct.length;
      }

      if(Number.isFinite(Number(magnitudePct))){
        return{
          time:b.time,
          value:Number(magnitudePct),
          signedValue:Number.isFinite(Number(signedValue))?Number(signedValue):0,
          rawDelta:Number(netSignedDelta),
          grossAbsDelta:Number(grossAbsDelta),
          count:arr.length,
          expected,
          partial:arr.length<expected
        };
      }
    }

    if(Number.isFinite(Number(b.delta))&&Number.isFinite(Number(b.volume))&&Number(b.volume)>0){
      const signedValue=Math.max(-100,Math.min(100,100*Number(b.delta)/Number(b.volume)));
      return{
        time:b.time,
        value:Math.abs(signedValue),
        signedValue,
        rawDelta:Number(b.delta),
        grossAbsDelta:Math.abs(Number(b.delta)),
        count:expected,
        expected,
        partial:false
      };
    }
    return null;
  }).filter(Boolean);
}
function rawBars(symbol,tf){
  return state.bars.filter(r=>r.data_type==='ohlcv'&&r.symbol===symbol&&r.timeframe===tf&&Number(r.bar_close_ms)<=Date.now()).map(r=>{
    const p=r.payload||{},delta=deltaFromPayload(p);
    return{time:Math.floor(Number(r.bar_open_ms)/1000),openMs:Number(r.bar_open_ms),closeMs:Number(r.bar_close_ms),open:Number(p.open),high:Number(p.high),low:Number(p.low),close:Number(p.close),volume:Number(p.volume||0),delta,sourceTf:tf};
  }).filter(r=>[r.time,r.openMs,r.open,r.high,r.low,r.close].every(Number.isFinite)).sort((a,b)=>a.openMs-b.openMs);
}
const ctPartsFmt=new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
function ctParts(ms){const parts=Object.fromEntries(ctPartsFmt.formatToParts(new Date(ms)).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));return{year:Number(parts.year),month:Number(parts.month),day:Number(parts.day),hour:Number(parts.hour),minute:Number(parts.minute)}}
function dateKey(y,m,d){return`${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`}
function addCalendarDay(y,m,d,days){const z=new Date(Date.UTC(y,m-1,d+days));return dateKey(z.getUTCFullYear(),z.getUTCMonth()+1,z.getUTCDate())}
function tradingDayKey(ms){const p=ctParts(ms);return p.hour>=17?addCalendarDay(p.year,p.month,p.day,1):dateKey(p.year,p.month,p.day)}
function aggregateKey(ms,targetTf){if(targetTf==='1d')return`${tradingDayKey(ms)}|1d`;if(targetTf==='4h'){const p=ctParts(ms),td=tradingDayKey(ms),offset=p.hour>=17?p.hour-17:p.hour+7;return`${td}|4h|${Math.floor(offset/4)}`;}const mins=TF_MIN[targetTf];return`${targetTf}|${Math.floor(ms/(mins*60000))}`}
function aggregateBars(source,targetTf){
  if(!source.length)return[];const srcTf=source[0].sourceTf||'1m',srcMin=TF_MIN[srcTf]||1,targetMin=TF_MIN[targetTf]||1;if(targetMin<=srcMin)return[];
  const groups=new Map;for(const b of source){const k=aggregateKey(b.openMs,targetTf);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(b);}
  const expected=targetTf==='1d'&&srcTf==='1h'?23:Math.max(1,Math.round(targetMin/srcMin)),out=[];
  for(const arr of groups.values()){arr.sort((a,b)=>a.openMs-b.openMs);if(arr.length<expected)continue;const first=arr[0],last=arr[arr.length-1],d=arr.map(x=>x.delta).filter(Number.isFinite);
    out.push({time:first.time,openMs:first.openMs,closeMs:last.closeMs,open:first.open,high:Math.max(...arr.map(x=>x.high)),low:Math.min(...arr.map(x=>x.low)),close:last.close,volume:arr.reduce((s,x)=>s+(Number.isFinite(x.volume)?x.volume:0),0),delta:d.length===arr.length?d.reduce((a,b)=>a+b,0):null,sourceTf:targetTf});
  }return out.sort((a,b)=>a.openMs-b.openMs);
}
function barsFor(symbol,tf){
  const candidates=[],exact=rawBars(symbol,tf);if(exact.length)candidates.push({bars:exact,exact:true});
  for(const srcTf of FALLBACKS[tf]||[]){const src=rawBars(symbol,srcTf);if(src.length){const agg=aggregateBars(src,tf);if(agg.length)candidates.push({bars:agg,exact:false});}}
  if(!candidates.length)return[];candidates.sort((a,b)=>b.bars.length-a.bars.length||Number(b.exact)-Number(a.exact));return candidates[0].bars;
}
function emaData(bars,period){if(!bars.length)return[];const a=2/(period+1);let e=bars[0].close;return bars.map((b,i)=>{e=i===0?b.close:a*b.close+(1-a)*e;return{time:b.time,value:e}})}
function vwapData(bars){let key=null,pv=0,vol=0;return bars.map(b=>{const k=tradingDayKey(b.openMs);if(k!==key){key=k;pv=0;vol=0;}const v=Number.isFinite(b.volume)?b.volume:0,tp=(b.high+b.low+b.close)/3;pv+=tp*v;vol+=v;return{time:b.time,value:vol>0?pv/vol:b.close}})}
function trueRanges(bars){return bars.map((b,i)=>i===0?b.high-b.low:Math.max(b.high-b.low,Math.abs(b.high-bars[i-1].close),Math.abs(b.low-bars[i-1].close)))}
function atrRma(bars,period=10){const tr=trueRanges(bars),out=new Array(bars.length).fill(null);if(tr.length<period)return out;let a=tr.slice(0,period).reduce((s,x)=>s+x,0)/period;out[period-1]=a;for(let i=period;i<tr.length;i++){a=(a*(period-1)+tr[i])/period;out[i]=a;}return out}
function supertrendData(bars,period=10,factor=3){
  const atr=atrRma(bars,period),bull=[],bear=[];let prevUpper=null,prevLower=null,prevSuper=null,prevClose=null,lastDirection=null;
  for(let i=0;i<bars.length;i++){const b=bars[i],a=atr[i];if(!Number.isFinite(a)){bull.push({time:b.time});bear.push({time:b.time});prevClose=b.close;continue;}
    const hl2=(b.high+b.low)/2,ub0=hl2+factor*a,lb0=hl2-factor*a;let upper=prevUpper===null?ub0:(ub0<prevUpper||prevClose>prevUpper?ub0:prevUpper),lower=prevLower===null?lb0:(lb0>prevLower||prevClose<prevLower?lb0:prevLower),direction;
    if(prevSuper===null)direction=1;else if(prevSuper===prevUpper)direction=b.close>upper?-1:1;else direction=b.close<lower?1:-1;
    const st=direction<0?lower:upper;bull.push(direction<0?{time:b.time,value:st}:{time:b.time});bear.push(direction<0?{time:b.time}:{time:b.time,value:st});prevUpper=upper;prevLower=lower;prevSuper=st;prevClose=b.close;lastDirection=direction;
  }return{bull,bear,direction:lastDirection,state:lastDirection===null?'WAITING':lastDirection<0?'BULL':'BEAR'};
}

function makeChart(hostId,{indicators=true}={}){
  const host=$(hostId);if(!host||!window.LightweightCharts)return{};
  const c=LightweightCharts.createChart(host,{layout:{background:{color:'#0a151e'},textColor:'#8ba5b7'},localization:{timeFormatter:chartCrosshairTime},grid:{vertLines:{color:'#122634'},horzLines:{color:'#122634'}},rightPriceScale:{borderColor:'#284253'},timeScale:{borderColor:'#284253',timeVisible:true,secondsVisible:false,lockVisibleTimeRangeOnResize:true,tickMarkFormatter:chartAxisTime},height:host.clientHeight||500});
  const candles=c.addSeries(LightweightCharts.CandlestickSeries,{upColor:'#42d5a0',downColor:'#f07178',wickUpColor:'#42d5a0',wickDownColor:'#f07178',borderVisible:false,priceLineVisible:false,lastValueVisible:false,priceFormat:{type:'price',precision:2,minMove:.25}});
  const delta=c.addSeries(LightweightCharts.HistogramSeries,{priceScaleId:'delta',priceFormat:{type:'volume'},priceLineVisible:false,lastValueVisible:false});
  c.priceScale('delta').applyOptions({scaleMargins:{top:.78,bottom:.02}});
  let ind=null;if(indicators){const lineBase={lineWidth:2,priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:false,title:''};ind={
    ema9:c.addSeries(LightweightCharts.LineSeries,{...lineBase,color:'#5aa9ff'}),
    ema21:c.addSeries(LightweightCharts.LineSeries,{...lineBase,color:'#f0b65f'}),
    vwap:c.addSeries(LightweightCharts.LineSeries,{...lineBase,color:'#c18cff'})
  };}return{c,candles,delta,indicators:ind};
}
function updateChartData(key,chart,applyData){if(!chart){applyData();return;}const ts=chart.timeScale(),locked=state.chartZoomLock[key]!==false,prior=locked&&state.chartInitialized[key]?ts.getVisibleLogicalRange():null;applyData();if(!state.chartInitialized[key]){ts.fitContent();state.chartInitialized[key]=true;}else if(locked&&prior){ts.setVisibleLogicalRange(prior);}else if(!locked){ts.fitContent();}}
function syncZoomButton(key){const b=document.querySelector(`[data-zoom-lock="${key}"]`);if(!b)return;const locked=state.chartZoomLock[key]!==false;b.classList.toggle('active',locked);b.textContent=`Preserve zoom: ${locked?'ON':'OFF'}`}
function toggleZoomLock(key){state.chartZoomLock[key]=!(state.chartZoomLock[key]!==false);syncZoomButton(key);if(!state.chartZoomLock[key]){const c=key==='market'?state.marketChart:state.reactionChart;c?.timeScale().fitContent();}}
function setIndicatorData(ind,bars){if(!ind)return;const v=state.indicatorVisibility;ind.ema9.setData(v.ema9?emaData(bars,9):[]);ind.ema21.setData(v.ema21?emaData(bars,21):[]);ind.vwap.setData(v.vwap?vwapData(bars):[]);}
function setDeltaData(series,deltaBars,statusId){
  if(!series)return;
  const z=(deltaBars||[]).filter(x=>Number.isFinite(Number(x.value)));
  series.setData(z.map(x=>({
    time:x.time,
    value:Math.abs(Number(x.value)),
    color:x.partial
      ?(Number(x.signedValue)>=0?'rgba(66,213,160,.20)':'rgba(240,113,120,.20)')
      :(Number(x.signedValue)>=0?'rgba(66,213,160,.42)':'rgba(240,113,120,.42)')
  })));
  const n=$(statusId);
  if(n){
    if(!z.length){
      n.textContent='Delta Magnitude % · WAITING FOR FOOTPRINT DELTA';
      n.classList.add('waiting');
    }else{
      const partial=z.filter(x=>x.partial).length;
      const last=z[z.length-1],lastCt=last?.time?chartAxisTime(last.time):null;
      const lastMag=Number.isFinite(Number(last?.value))?`${Number(last.value).toFixed(1)}%`:null;
      n.textContent=`Delta Magnitude % · ${partial?'PARTIAL + ':''}TRUE FOOTPRINT${lastCt?` · through ${lastCt} CT`:''}${lastMag?` · last ${lastMag}`:''}`;
      n.classList.toggle('waiting',partial>0);
    }
  }
}
function resetMarketChart(){
  if(state.marketChart){try{state.marketChart.remove()}catch{}}
  const host=$('marketChart');if(host)host.innerHTML='';
  state.marketChart=null;state.marketCandles=null;state.marketDelta=null;state.marketIndicators=null;
  state.marketPriceLines=[];state.chartInitialized.market=false;
}
function clearPriceLines(candles,arr){for(const l of arr){try{candles.removePriceLine(l)}catch{}}arr.length=0}
function drawStructuralLevels(candles,arr,enabled){clearPriceLines(candles,arr);if(!enabled)return;for(const r of state.levels){const p=Number(r.level_price);if(!Number.isFinite(p))continue;arr.push(candles.createPriceLine({price:p,color:r.level_id===state.selected?'#5aa9ff':hasNum(r.reaction_probability)?(Number(r.reaction_probability)>=.5?'#42d5a0':'#f07178'):'#6e8494',lineWidth:r.level_id===state.selected?3:1,lineStyle:LightweightCharts.LineStyle.Dashed,axisLabelVisible:true,title:String(r.level_type||'LEVEL').slice(0,14)}));}}
function renderMarketChart(){
  if(!state.marketChart){const z=makeChart('marketChart',{indicators:true});state.marketChart=z.c;state.marketCandles=z.candles;state.marketDelta=z.delta;state.marketIndicators=z.indicators;syncZoomButton('market');}
  if(!state.marketCandles)return;const b=barsFor(state.symbol,state.tf),delta=deltaBarsFor(state.symbol,state.tf,b);
  if($('marketChartTitle'))$('marketChartTitle').textContent=state.symbol==='ES'?`ES ${TF_LABEL[state.tf]} + Structural Levels`:`NQ ${TF_LABEL[state.tf]}`;
  if($('marketChartStatus'))$('marketChartStatus').textContent=b.length?`${b.length} completed ${TF_LABEL[state.tf]} bars · Central Time${state.symbol==='ES'?' · all active ES structural levels':''}${delta.length?' · true footprint Delta Magnitude %':' · footprint Delta Magnitude % waiting'}`:`Waiting for ${state.symbol} ${TF_LABEL[state.tf]} bars`;
  updateChartData('market',state.marketChart,()=>{state.marketCandles.setData(b.map(x=>({time:x.time,open:x.open,high:x.high,low:x.low,close:x.close})));setDeltaData(state.marketDelta,delta,'deltaVolumeStatus');setIndicatorData(state.marketIndicators,b);drawStructuralLevels(state.marketCandles,state.marketPriceLines,state.symbol==='ES');});
  renderSupertrendMatrix();
}
function renderSupertrendMatrix(){const host=$('supertrendGrid');if(!host)return;if($('supertrendTitle'))$('supertrendTitle').textContent=`${state.symbol} Multi-Timeframe Direction`;host.innerHTML=ST_TFS.map(tf=>{const b=barsFor(state.symbol,tf),st=supertrendData(b,10,3),klass=st.state==='BULL'?'bull':st.state==='BEAR'?'bear':'waiting';return`<div class="supertrend-cell ${klass}"><span>${TF_LABEL[tf]}</span><strong>${st.state}</strong><small>${b.length?`${b.length} completed bars`:'No completed bars'}</small></div>`;}).join('');}
function probTone(r){if(!hasNum(r.reaction_probability))return'';return Number(r.reaction_probability)>=.5?'good':'bad'}
function renderLevels(){state.levels=[...state.levels].filter(x=>x.is_active!==false).sort((a,b)=>{const da=rawPriceAway(a),db=rawPriceAway(b);return(Number.isFinite(da)?da:Number(a.distance_points??9999))-(Number.isFinite(db)?db:Number(b.distance_points??9999));});if(!state.levels.some(x=>x.level_id===state.selected))state.selected=state.levels[0]?.level_id||null;const host=$('levelList');if(host)host.innerHTML=state.levels.length?state.levels.map(r=>`<button class="level-row ${r.level_id===state.selected?'selected':''}" data-level="${esc(r.level_id)}"><div><strong>${fmt(r.level_price)}</strong><small>${esc(r.level_type)} · ${esc(r.state)}</small></div><span title="Distance away from price">${fmt(rawPriceAway(r))}</span><span class="prob ${probTone(r)}">${reactionProbText(r,'reaction_probability')}</span></button>`).join(''):'<p class="muted">No active structural levels yet.</p>';renderSelected();renderCommandReaction();renderReactionChart();renderMarketChart();}

function levelImportanceReasons(r){
  const t=String(r?.level_type||'').toUpperCase(),f=String(r?.level_family||'').replaceAll('_',' '),reasons=[];
  if(/PDH|PDL|PRIOR.*DAY/.test(t))reasons.push('Prior-day extreme: a widely watched external-liquidity reference where stops, breakout orders, and mean-reversion interest can cluster.');
  else if(/PWH|PWL|PRIOR.*WEEK/.test(t))reasons.push('Prior-week extreme: higher-timeframe external liquidity and a common reference for continuation versus rejection.');
  else if(/OVERNIGHT|ONH|ONL/.test(t))reasons.push('Overnight session extreme: separates overnight inventory from regular-session acceptance or rejection.');
  else if(/LONDON/.test(t))reasons.push('London session extreme: an established intraday liquidity reference before/into New York trading.');
  else if(/ASIA/.test(t))reasons.push('Asia session extreme: overnight liquidity reference that can act as a sweep or expansion objective.');
  else if(/RTH/.test(t))reasons.push('Regular-session structural extreme: a reference created by prior cash-session participation.');
  else if(/EQH|EQL|EQUAL/.test(t))reasons.push('Repeated/equal highs or lows: visible resting-liquidity area that can attract a sweep before rejection or continuation.');
  else if(/SWING/.test(t))reasons.push('Confirmed structural swing: objective prior turning point used to judge acceptance, rejection, and market structure.');
  else reasons.push(`${f||'Structural'} level: objective model-tracked reference rather than a discretionary line.`);
  const d=rawPriceAway(r);if(Number.isFinite(d))reasons.push(`Current ES price is ${fmt(d)} points from the level, so its immediate relevance rises as that distance contracts.`);
  const s=String(r?.state||'').replaceAll('_',' ');if(s)reasons.push(`Current level state: ${s}. This tells you whether the model considers the level merely active, approaching, touched, or already resolved.`);
  for(const [key,label] of [['touch_count','Recorded touches'],['confluence_count','Confluence count'],['level_rank','Level rank'],['strength_score','Strength score']]){if(hasNum(r?.[key]))reasons.push(`${label}: ${fmt(r[key],key.includes('count')?0:2)}.`);}
  return reasons.slice(0,6);
}
function renderSelected(){
  const r=selectedLevel();if(!r){for(const id of ['rxLevel','rxType','rxReject','rxBreak','rxAway'])if($(id))$(id).textContent='—';if($('rxState'))$('rxState').textContent='WAITING';if($('levelDetail'))$('levelDetail').innerHTML='<p class="muted">Waiting for model state.</p>';renderCommandReaction();return;}
  $('rxLevel').textContent=fmt(r.level_price);$('rxType').textContent=`${r.level_type||'—'} · ${r.level_family||'—'}`;$('rxReject').textContent=reactionProbText(r,'reaction_probability');$('rxBreak').textContent=reactionProbText(r,'breakout_probability');$('rxState').textContent=String(r.state||'—').replaceAll('_',' ');$('rxInput').textContent=r.input_status||'—';if($('rxAway'))$('rxAway').textContent=fmt(rawPriceAway(r));
  const reasons=levelImportanceReasons(r),drivers=Array.isArray(r.top_drivers)?r.top_drivers:[];
  $('levelDetail').innerHTML=`<div class="kv"><div><span>Price</span><strong>${fmt(r.level_price)}</strong></div><div><span>Distance Away from Price</span><strong>${fmt(rawPriceAway(r))}</strong></div><div><span>Reject</span><strong>${reactionProbText(r,'reaction_probability')}</strong></div><div><span>Break</span><strong>${reactionProbText(r,'breakout_probability')}</strong></div></div><h3>Why this level matters</h3><ol class="drivers">${reasons.map(x=>`<li>${esc(x)}</li>`).join('')}</ol>${drivers.length?`<h3>Model inference drivers</h3><ol class="drivers">${drivers.map(d=>`<li>${esc(d.name||d.feature||'feature')} <strong>${Number.isFinite(Number(d.contribution))?Number(d.contribution).toFixed(3):''}</strong></li>`).join('')}</ol>`:''}`;
  if($('rawEvent'))$('rawEvent').textContent=JSON.stringify(state.events.find(e=>e.level_id===r.level_id)||r,null,2);
}
function renderReactionChart(){
  if(!state.reactionChart){const z=makeChart('reactionChart',{indicators:false});state.reactionChart=z.c;state.reactionCandles=z.candles;state.reactionDelta=z.delta;syncZoomButton('reaction');}
  if(!state.reactionCandles)return;const b=barsFor('ES','5m'),delta=deltaBarsFor('ES','5m',b);
  updateChartData('reaction',state.reactionChart,()=>{state.reactionCandles.setData(b.map(x=>({time:x.time,open:x.open,high:x.high,low:x.low,close:x.close})));setDeltaData(state.reactionDelta,delta,null);drawStructuralLevels(state.reactionCandles,state.reactionPriceLines,true);});
}
function renderEvents(){const res=new Map(state.resolutions.map(x=>[x.event_id,x]));if($('eventRows'))$('eventRows').innerHTML=state.events.length?state.events.slice(0,40).map(e=>{const r=res.get(e.event_id);return`<tr><td>${ct(e.reaction_decision_timestamp)}</td><td>${fmt(e.level_price)}</td><td>${esc(e.level_type)}</td><td>${pct(e.p_rejection)}</td><td>${esc(e.capture_mode||'LIVE')}</td><td>${esc(r?.outcome||'PENDING')}</td></tr>`}).join(''):'<tr><td colspan="6">No reaction events yet.</td></tr>';renderResearch();}
function renderResearch(){if(!$('researchStats')||!$('calibrationRows'))return;const rm=new Map(state.resolutions.map(x=>[x.event_id,x])),live=state.events.filter(e=>(e.capture_mode||'LIVE')==='LIVE'),done=live.map(e=>({e,r:rm.get(e.event_id)})).filter(x=>['REJECTION','BREAKOUT'].includes(x.r?.outcome));let correct=0,brier=0;done.forEach(x=>{const y=x.r.outcome==='REJECTION'?1:0,p=Number(x.e.p_rejection);correct+=((p>=.5?1:0)===y);brier+=(p-y)**2});$('researchStats').innerHTML=`<div><span>Resolved binary</span><strong>${done.length}</strong></div><div><span>0.5 accuracy</span><strong>${done.length?fmt(100*correct/done.length,1)+'%':'—'}</strong></div><div><span>Brier</span><strong>${done.length?fmt(brier/done.length,3):'—'}</strong></div><div><span>Prospective LIVE events</span><strong>${live.length}</strong></div>`;const bins=[[0,.2],[.2,.4],[.4,.6],[.6,.8],[.8,1.00001]];$('calibrationRows').innerHTML=bins.map(([a,b])=>{const z=done.filter(x=>Number(x.e.p_rejection)>=a&&Number(x.e.p_rejection)<b),mp=z.length?z.reduce((s,x)=>s+Number(x.e.p_rejection),0)/z.length:NaN,obs=z.length?z.filter(x=>x.r.outcome==='REJECTION').length/z.length:NaN;return`<tr><td>${Math.round(a*100)}–${Math.round(Math.min(1,b)*100)}%</td><td>${z.length}</td><td>${pct(mp)}</td><td>${pct(obs)}</td></tr>`}).join('');}

function signature(rows){return JSON.stringify((rows||[]).map(r=>[r.symbol,r.contract,r.last,r.bid,r.ask,r.session_volume,r.updated_at]))}
function scheduleFetch(key,fn,delay){clearTimeout(state.fetchTimers[key]);state.fetchTimers[key]=setTimeout(()=>{delete state.fetchTimers[key];if(state.session)fn()},delay)}
async function fetchQuotes(){if(!state.session)return;const q=await client.from('market_quotes_live').select('*').order('symbol',{ascending:true});if(q.error){console.warn(q.error);return;}const rows=q.data||[],sig=signature(rows);state.quotes=rows;if(sig!==state.quoteSignature){state.quoteSignature=sig;renderQuotes();}}
async function fetchHealth(){if(!state.session)return;const h=await client.from('service_health').select('*');if(h.error){console.warn(h.error);return;}state.health=h.data||[];renderHealth();}
async function fetchExactBarRows(symbol,tf,maxRows){
  const pageSize=1000,rows=[];
  for(let start=0;start<maxRows;start+=pageSize){
    const end=Math.min(start+pageSize,maxRows)-1;
    const q=await client.from('market_bars_live').select('*').eq('data_type','ohlcv').eq('symbol',symbol).eq('timeframe',tf).order('bar_open_ms',{ascending:false}).range(start,end);
    if(q.error){console.warn(`bars exact ${symbol} ${tf}`,q.error);break;}
    rows.push(...(q.data||[]));
    if((q.data||[]).length<(end-start+1))break;
  }
  return rows;
}
async function fetchFrame(symbol,tf){
  const maxRows=tf==='1m'?2000:700;
  const symbolCandidates=[symbol,...(SYMBOL_ALIASES[symbol]||[]).filter(x=>x!==symbol)];
  const tfCandidates=[tf,...(TF_ALIASES[tf]||[]).filter(x=>x!==tf)];
  for(const sourceSymbol of symbolCandidates){
    for(const sourceTf of tfCandidates){
      const rows=await fetchExactBarRows(sourceSymbol,sourceTf,maxRows);
      if(!rows.length)continue;
      return rows.map(x=>({...x,_source_symbol:x.symbol,_source_timeframe:x.timeframe,symbol,timeframe:tf}));
    }
  }
  console.warn(`No market_bars_live rows for ${symbol} ${tf}; tried symbols=${symbolCandidates.join(',')} timeframes=${tfCandidates.join(',')}`);
  return[];
}
async function fetchFootprintSource(table,sourceSymbol,maxRows=3000){
  const pageSize=1000,rows=[];
  for(let start=0;start<maxRows;start+=pageSize){
    const end=Math.min(start+pageSize,maxRows)-1;
    const q=await client.from(table)
      .select('data_type,symbol,timeframe,bar_open_ms,bar_close_ms,payload,received_at')
      .eq('data_type','footprint').eq('symbol',sourceSymbol).eq('timeframe','1m')
      .order('bar_open_ms',{ascending:false}).range(start,end);
    if(q.error){
      console.warn(`footprint ${table} ${sourceSymbol}`,q.error);
      return[];
    }
    rows.push(...(q.data||[]));
    if((q.data||[]).length<(end-start+1))break;
  }
  return rows;
}
async function fetchFootprintRows(symbol){
  const symbolCandidates=[symbol,...(SYMBOL_ALIASES[symbol]||[]).filter(x=>x!==symbol)];
  for(const sourceSymbol of symbolCandidates){
    const [live,legacy]=await Promise.all([
      fetchFootprintSource('market_bars_live',sourceSymbol,3000),
      fetchFootprintSource('tv_market_bars',sourceSymbol,3000)
    ]);
    const merged=new Map;
    for(const x of legacy)merged.set(Number(x.bar_open_ms),x);
    for(const x of live)merged.set(Number(x.bar_open_ms),x); // current table wins on overlap
    if(merged.size){
      const rows=[...merged.values()].sort((a,b)=>Number(b.bar_open_ms)-Number(a.bar_open_ms));
      const latest=rows[0],latestCt=latest?.bar_open_ms?chartAxisTime(Math.floor(Number(latest.bar_open_ms)/1000)):null;
      console.info(`footprint ${symbol}: ${rows.length} rows; latest=${latestCt||'unknown'} CT; live=${live.length}; legacy=${legacy.length}`);
      return rows.map(x=>({...x,symbol}));
    }
  }
  console.warn(`No footprint rows found for ${symbol}; tried market_bars_live + tv_market_bars`);
  return[];
}
async function fetchBars(){
  if(!state.session)return;
  const seq=++state.barsFetchSeq,symbol=state.symbol,specs=FETCH_TFS.map(tf=>[symbol,tf]);
  if(symbol!=='ES')specs.push(['ES','5m']);
  const footprintSymbols=[...new Set([symbol,'ES'])];
  const [barResults,footprintResults]=await Promise.all([
    Promise.all(specs.map(async([s,tf])=>({s,tf,rows:await fetchFrame(s,tf)}))),
    Promise.all(footprintSymbols.map(async s=>({s,rows:await fetchFootprintRows(s)})))
  ]);
  if(seq!==state.barsFetchSeq)return;
  const map=new Map;
  for(const r of barResults)for(const x of r.rows)map.set(`${x.data_type}|${x.symbol}|${x.timeframe}|${x.bar_open_ms}`,x);
  state.bars=[...map.values()].sort((a,b)=>Number(a.bar_open_ms)-Number(b.bar_open_ms));
  const fp=new Map;
  for(const r of footprintResults)for(const x of r.rows)fp.set(`${x.symbol}|${x.timeframe}|${x.bar_open_ms}`,x);
  state.footprints=[...fp.values()].sort((a,b)=>Number(a.bar_open_ms)-Number(b.bar_open_ms));
  renderMarketChart();renderReactionChart();renderSupertrendMatrix();
}
async function fetchReactionState(){
  if(!state.session)return;
  const day=reactionTradingDay(),contract=String(esQuote().contract||health('es_reaction_model')?.metadata?.contract||'').trim();
  let lq=client.from('es_reaction_levels').select('*').eq('is_active',true).eq('trading_day',day);
  if(contract)lq=lq.eq('contract',contract);
  lq=lq.order('updated_at',{ascending:false}).limit(100);
  const [l,e,r]=await Promise.all([lq,client.from('es_reaction_events').select('*').order('reaction_decision_timestamp',{ascending:false}).limit(500),client.from('es_reaction_resolutions').select('*').order('resolved_at',{ascending:false}).limit(500)]);
  for(const x of[l,e,r])if(x.error)console.warn(x.error);
  state.levels=l.data||[];
  if(!state.levels.length)console.warn(`No current-day ES Reaction levels for ${day}${contract?` ${contract}`:''}`);
  state.events=e.data||[];state.resolutions=r.data||[];renderLevels();renderEvents();
}
async function fetchAll(){
  if(!state.session)return;
  await Promise.all([fetchQuotes(),fetchHealth()]);
  await Promise.all([fetchBars(),fetchReactionState()]);
}
function subscribe(){state.channel?.unsubscribe();state.channel=client.channel('v28-live').on('postgres_changes',{event:'*',schema:'public',table:'market_quotes_live'},()=>scheduleFetch('quotes',fetchQuotes,100)).on('postgres_changes',{event:'*',schema:'public',table:'market_bars_live'},()=>scheduleFetch('bars',fetchBars,2500)).on('postgres_changes',{event:'*',schema:'public',table:'es_reaction_levels'},()=>scheduleFetch('reaction',fetchReactionState,400)).on('postgres_changes',{event:'INSERT',schema:'public',table:'es_reaction_events'},()=>scheduleFetch('reaction',fetchReactionState,400)).on('postgres_changes',{event:'INSERT',schema:'public',table:'es_reaction_resolutions'},()=>scheduleFetch('reaction',fetchReactionState,400)).on('postgres_changes',{event:'*',schema:'public',table:'service_health'},()=>scheduleFetch('health',fetchHealth,250)).subscribe();}
async function show(session){state.session=session;$('authShell').classList.toggle('hidden',!!session);$('appShell').classList.toggle('hidden',!session);if(session){await fetchAll();subscribe();}}
$('loginForm').addEventListener('submit',async ev=>{ev.preventDefault();$('loginError').textContent='';const {data,error}=await client.auth.signInWithPassword({email:$('loginEmail').value.trim(),password:$('loginPassword').value});if(error){$('loginError').textContent=error.message;return;}show(data.session)});
$('signOut').addEventListener('click',async()=>{await client.auth.signOut();show(null)});
$('refresh').addEventListener('click',()=>fetchAll());
document.addEventListener('click',ev=>{
  const t=ev.target.closest('.tab');if(t)setTab(t.dataset.tab);
  const s=ev.target.closest('[data-symbol]');if(s){$$('[data-symbol]').forEach(x=>x.classList.toggle('active',x===s));state.symbol=s.dataset.symbol;resetMarketChart();if($('marketChartStatus'))$('marketChartStatus').textContent=`Loading ${state.symbol} ${TF_LABEL[state.tf]} bars…`;fetchBars();}
  const tf=ev.target.closest('[data-tf]');if(tf){$$('[data-tf]').forEach(x=>x.classList.toggle('active',x===tf));state.tf=tf.dataset.tf;state.chartInitialized.market=false;renderMarketChart();}
  const ind=ev.target.closest('[data-indicator]');if(ind){const k=ind.dataset.indicator;state.indicatorVisibility[k]=!state.indicatorVisibility[k];ind.classList.toggle('active',state.indicatorVisibility[k]);renderMarketChart();}
  const zl=ev.target.closest('[data-zoom-lock]');if(zl)toggleZoomLock(zl.dataset.zoomLock);
  const lv=ev.target.closest('[data-level]');if(lv){state.selected=lv.dataset.level;renderLevels();}
});
setInterval(()=>{if($('clock'))$('clock').textContent=new Intl.DateTimeFormat('en-US',{timeZone:zone(),hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short'}).format(new Date())},1000);
setInterval(()=>{if(state.session){fetchQuotes();fetchHealth()}},10000);
setInterval(()=>state.session&&fetchBars(),60000);
setInterval(()=>state.session&&fetchReactionState(),60000);
window.addEventListener('resize',()=>{state.marketChart?.applyOptions({width:$('marketChart')?.clientWidth||800});state.reactionChart?.applyOptions({width:$('reactionChart')?.clientWidth||800})});
client.auth.getSession().then(({data})=>show(data.session));client.auth.onAuthStateChange((_e,s)=>show(s));
})();