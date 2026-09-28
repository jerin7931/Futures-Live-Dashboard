import test from "node:test";import assert from "node:assert/strict";
import {createUIState,resetViewport,setViewport,viewportFor} from "../screener/ui-state.js";
test("global UI store owns every persistent control family",()=>{const ui=createUIState({page:"home",demo:false});for(const key of ["efficiencyTimeframes","chainFilters","chartViewports","chartTooltips","aiExpanded","scrollPositions"])assert.ok(key in ui);});
test("live rerender does not reset a user chart viewport",()=>{const ui=createUIState(),d={xMin:0,xMax:10,yMin:-1,yMax:1};viewportFor(ui,"a",d);setViewport(ui,"a",{xMin:2,xMax:8,yMin:-.5,yMax:.5});assert.deepEqual(viewportFor(ui,"a",d),{xMin:2,xMax:8,yMin:-.5,yMax:.5,isUserModified:true});});
test("Reset restores canonical chart viewport",()=>{const ui=createUIState(),d={xMin:0,xMax:10,yMin:-1,yMax:1};setViewport(ui,"a",{xMin:2,xMax:8,yMin:-.5,yMax:.5});assert.deepEqual(resetViewport(ui,"a",d),{...d,isUserModified:false});});
