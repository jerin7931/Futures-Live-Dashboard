import test from "node:test";import assert from "node:assert/strict";
import {clampViewport,panViewport,pinchViewport,zoomViewport} from "../screener/chart-interaction.js";
const d={xMin:0,xMax:100,yMin:-1,yMax:1},v={...d,isUserModified:false};
test("wheel-style zoom is centered on pointer anchor",()=>{const z=zoomViewport(v,d,.25,.75,.5);assert.equal(z.xMax-z.xMin,50);assert.equal(z.yMax-z.yMin,1);assert.equal(z.xMin,12.5);});
test("drag pan remains inside canonical bounds",()=>{const z=zoomViewport(v,d,.5,.5,.5),p=panViewport(z,d,.2,-.2);assert.ok(p.xMin>=0&&p.xMax<=100&&p.yMin>=-1&&p.yMax<=1);});
test("pinch uses distance ratio",()=>{const p=pinchViewport(v,d,100,200,.5,.5);assert.equal(p.xMax-p.xMin,50);});
test("clamp prevents zoom or pan outside source domain",()=>{assert.deepEqual(clampViewport({xMin:-9,xMax:50,yMin:-3,yMax:.2},d),{xMin:0,xMax:59,yMin:-1,yMax:1,isUserModified:true});});
