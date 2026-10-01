import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {href,route} from "../screener/cash-open-core.js";
import {renderPage} from "../screener/ai-workspace-view.js";
import {renderCompactGamma,renderOptionsAnalysis} from "../screener/options-analysis-view.js";

test("navigation is limited to AI Analysis and Options Analysis",()=>{
  for(const page of ["home","options-analysis"])assert.deepEqual(route(`#/${page}`),{demo:false,page,redirect:false});
  for(const retired of ["option-chain","news","tracking"])
    assert.deepEqual(route(`#/${retired}`),{demo:false,page:"home",redirect:true});
  assert.equal(href("option-chain"),"#/home");
});

test("Home is an SPX-focused AI decision workspace and preserves Copy Gamma Levels for all",()=>{
  const analysis={
    symbol:"SPX",analysis_at:"2026-09-30T15:00:00Z",decision:"TRADE",bias:"BULLISH",market_state:"TRENDING",
    confidence:.74,concise_summary:"ES trend and footprint align.",option_type:"CALL",expiration:"2026-09-30",strike:7700,
    bid:2.1,ask:2.5,premium_reference:2.3,delta:.34,gamma:.02,iv:.21,entry_condition:"SPX reclaims 7696",target:"7710",
    invalidation:"Below 7692",source_ages:{es_state_age_seconds:20,footprint_age_seconds:40,spx_market_age_seconds:60,spx_options_age_seconds:300,spx_gamma_age_seconds:2400},
    warnings:["Gamma 40m old"],full_analysis:"Detailed evidence.",analysis_version:"spx-es-ai-v1",
  };
  const html=renderPage({aiCurrent:[analysis],aiHistory:[],gamma:[]},{page:"home"});
  for(const phrase of ["AI Analysis","TRADE — TRENDING","CALL · 2026-09-30 · 7,700","Gamma 40m old","Copy Gamma Levels for all"])
    assert.match(html,new RegExp(phrase.replaceAll("/","\\/")));
  assert.doesNotMatch(html,/lppc-workstation|price-efficiency-chart|Option Chain/);
});

test("NO TRADE state does not invent an option contract",()=>{
  const html=renderPage({aiCurrent:[{symbol:"SPX",decision:"NO_TRADE",market_state:"CHOPPING",concise_summary:"Mixed evidence.",source_ages:{}}],aiHistory:[],gamma:[]},{page:"home"});
  assert.match(html,/NO TRADE — CHOPPING/);
  assert.match(html,/No contract selected/);
  assert.doesNotMatch(html,/premium_reference/);
});

test("Option Analysis renderer remains unchanged and available",()=>{
  const row={payload:{spot:100,summary:{net_gex:10,call_wall:101,put_wall:99,zero_gamma_status:"CURRENT",zero_gamma:100},strike_profile:[{strike:99,net_gex:-5},{strike:100,net_gex:1},{strike:101,net_gex:8}]}};
  const original=renderCompactGamma(row);
  for(const text of ["Positive net gamma","Negative net gamma","Spot"])assert.match(original,new RegExp(text));
  assert.match(renderOptionsAnalysis([row],"SPX"),/Options Analysis/);
  assert.match(renderPage({gamma:[row]},{page:"options-analysis",optionsSymbol:"SPX"}),/Options Analysis/);
});

test("active browser bundle reads only AI results, gamma, and compact fast-state RPC",async()=>{
  const app=await readFile(new URL("../screener/cash-open-app.js",import.meta.url),"utf8");
  for(const table of ["fos_options_analysis_current","fos_ai_analysis_current","fos_ai_analysis_history"])assert.ok(app.includes(table),table);
  for(const retired of ["fos_lppc_state_current","fos_lppc_event_history","fos_lppc_efficiency_current","fos_lppc_participation_current","fos_lppc_observation_log","fos_option_chain_snapshot_current","fos_option_chain_current","#/option-chain"])
    assert.ok(!app.includes(retired),retired);
  for(const forbidden of [".upsert(",".insert(",".update(",".delete(","placeOrder"])
    assert.ok(!app.includes(forbidden),forbidden);
  assert.equal((app.match(/client\.rpc\(/g)||[]).length,1);
  assert.match(app,/client\.rpc\("get_spx_fast_state",\{p_owner:userId\}\)/);
});

test("published shell removes raw option-chain navigation and LPPC copy",async()=>{
  const html=await readFile(new URL("../screener/index.html",import.meta.url),"utf8");
  assert.match(html,/SPX \/ ES AI Workspace/);
  assert.match(html,/data-route="home"/);
  assert.match(html,/data-route="options-analysis"/);
  assert.doesNotMatch(html,/data-route="option-chain"|LPPC LIVE|Frozen LPPC/);
});
