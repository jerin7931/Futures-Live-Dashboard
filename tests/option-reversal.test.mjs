import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {renderReversalDetail,renderReversalHome} from "../screener/option-reversal-view.js";

const rows=[];
for(const symbol of ["SPY","QQQ","IWM"])for(const direction of ["UPSIDE","DOWNSIDE"])rows.push({symbol,direction,signal_state:"INACTIVE",data_quality:"GOOD",core_valid_count:5,core_required_count:5,core_contracts:[]});
rows[0]={...rows[0],signal_state:"CONFIRMED",state_score:81,raw_score:84,context_1m_score:78,context_3m_score:71,move_strength:1.32,atm_z:1.14,skew_z:.84,newest_quote_age_ms:11000,surface_ts:"2026-10-05T15:00:00Z"};

test("desktop homepage is fixed three by two with both directions always visible",()=>{const html=renderReversalHome(rows);assert.equal((html.match(/class="reversal-panel/g)||[]).length,6);for(const symbol of ["SPY","QQQ","IWM"])assert.equal((html.match(new RegExp(`data-symbol="${symbol}"`,"g"))||[]).length,2);assert.match(html,/CONFIRMED → BEARISH REVERSAL RISK/);assert.match(html,/NO ACTIVE DOWNSIDE EXTENSION/);});
test("inactive panel does not display a bogus score",()=>{const html=renderReversalHome(rows);const inactive=html.slice(html.indexOf('data-symbol="QQQ"'),html.indexOf('data-symbol="IWM"'));assert.doesNotMatch(inactive,/reversal-state[^]*?<span>\d+/);});
test("detail includes internally solved IV and provider IV diagnostics",()=>{const row={...rows[0],core_contracts:[{strike:100,option_type:"CALL",bid:1,ask:1.1,mid:1.05,internal_iv:.22,provider_iv:.24,moneyness:.001,delta:.5,gamma:.1,theta:-.2,vega:.03,spread_pct:.095,source_quote_ts:"2026-10-05T15:00:00Z",quote_age_ms:1000}]};const html=renderReversalDetail(row);assert.match(html,/Internal IV/);assert.match(html,/Webull IV/);assert.match(html,/diagnostic only/);});
test("mobile stylesheet preserves symbol pairing order",()=>{const css=readFileSync(new URL("../screener/styles.css",import.meta.url),"utf8");for(const token of ["symbol-spy.upside{order:1","symbol-spy.downside{order:2","symbol-qqq.upside{order:3","symbol-qqq.downside{order:4","symbol-iwm.upside{order:5","symbol-iwm.downside{order:6"])assert.ok(css.includes(token),token);});
test("active website contains no Three-Bot homepage presentation",()=>{const source=["../index.html","../screener/index.html","../screener/cash-open-app.js","../screener/ai-workspace-view.js"].map(file=>readFileSync(new URL(file,import.meta.url),"utf8")).join("\n");for(const token of ["Three-Bot Status","PRIVATE THREE-BOT STATUS","Bot Status","THREE-BOT PRODUCTION ARCHITECTURE"])assert.ok(!source.includes(token),token);assert.match(source,/Gamma Analysis/);});
test("browser reads only compact current rows and subscribes only to current",()=>{const app=readFileSync(new URL("../screener/cash-open-app.js",import.meta.url),"utf8");assert.match(app,/fos_option_reversal_current/);assert.doesNotMatch(app,/fos_option_reversal_(contract|surface)_history/);assert.doesNotMatch(app,/\.insert\(|\.update\(|\.delete\(/);});
