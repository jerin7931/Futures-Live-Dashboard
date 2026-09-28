import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {renderOptionChain} from "../screener/option-chain-view.js";
import {createUIState} from "../screener/ui-state.js";

test("UI store preserves all non-chart control families",()=>{const ui=createUIState({page:"home",demo:false});for(const key of ["optionsSymbol","optionsZoom","efficiencyTimeframes","chainFilters","aiExpanded","scrollPositions"])assert.ok(key in ui);assert.ok(!("chartViewports" in ui));assert.ok(!("chartTooltips" in ui));});
test("M1 and M5 selections persist independently through a simulated refresh",()=>{const ui=createUIState();ui.efficiencyTimeframes.SPX="M5";ui.efficiencyTimeframes.QQQ="M1";Object.assign({},ui);assert.equal(ui.efficiencyTimeframes.SPX,"M5");assert.equal(ui.efficiencyTimeframes.QQQ,"M1");});
test("AI expansion persists per symbol",()=>{const ui=createUIState();ui.aiExpanded.SPY=true;ui.aiExpanded.QQQ=false;assert.equal(ui.aiExpanded.SPY,true);assert.equal(ui.aiExpanded.QQQ,false);});
test("option-chain filter and sort state survives live-data rendering",()=>{const ui=createUIState();Object.assign(ui.chainFilters,{security:"SPY",right:"CALL",askMin:"1",askMax:"5",sort:"gamma",direction:"desc"});const model={optionChain:[],chainPointers:[]};const first=renderOptionChain(model,ui),second=renderOptionChain({...model,optionChain:[]},ui);for(const html of [first,second]){assert.match(html,/data-value="SPY" aria-pressed="true"/);assert.match(html,/data-value="CALL" aria-pressed="true"/);assert.match(html,/value="1"/);assert.match(html,/value="5"/);assert.match(html,/<option value="gamma" selected>/);assert.match(html,/Descending/);}});
test("active app has no obsolete viewport state or interaction import",async()=>{const source=(await Promise.all(["../screener/cash-open-app.js","../screener/lppc-view.js","../screener/ui-state.js"].map(file=>readFile(new URL(file,import.meta.url),"utf8")))).join("\n");for(const token of ["chartViewports","chartTooltips","chart-interaction","resetViewport","bindChartInteractions"])assert.ok(!source.includes(token),token);});
