const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const span=view=>({x:view.xMax-view.xMin,y:view.yMax-view.yMin});

export function clampViewport(view,defaults){
  let {xMin,xMax,yMin,yMax}=view;
  const width=Math.min(defaults.xMax-defaults.xMin,Math.max(1e-9,xMax-xMin));
  const height=Math.min(defaults.yMax-defaults.yMin,Math.max(1e-9,yMax-yMin));
  xMin=clamp(xMin,defaults.xMin,defaults.xMax-width);xMax=xMin+width;
  yMin=clamp(yMin,defaults.yMin,defaults.yMax-height);yMax=yMin+height;
  return {xMin,xMax,yMin,yMax,isUserModified:true};
}

export function zoomViewport(view,defaults,anchorX=.5,anchorY=.5,factor=.8){
  const current=span(view),minX=(defaults.xMax-defaults.xMin)/200,minY=(defaults.yMax-defaults.yMin)/200;
  const width=clamp(current.x*factor,minX,defaults.xMax-defaults.xMin);
  const height=clamp(current.y*factor,minY,defaults.yMax-defaults.yMin);
  const x=view.xMin+current.x*anchorX,y=view.yMax-current.y*anchorY;
  return clampViewport({xMin:x-width*anchorX,xMax:x+width*(1-anchorX),yMin:y-height*(1-anchorY),yMax:y+height*anchorY},defaults);
}

export function panViewport(view,defaults,deltaXFraction,deltaYFraction){
  const current=span(view);
  return clampViewport({xMin:view.xMin-current.x*deltaXFraction,xMax:view.xMax-current.x*deltaXFraction,
    yMin:view.yMin+current.y*deltaYFraction,yMax:view.yMax+current.y*deltaYFraction},defaults);
}

export function pinchViewport(view,defaults,startDistance,currentDistance,anchorX=.5,anchorY=.5){
  if(!(startDistance>0&&currentDistance>0))return view;
  return zoomViewport(view,defaults,anchorX,anchorY,startDistance/currentDistance);
}

const attrs=chart=>({
  defaults:{xMin:Number(chart.dataset.defaultXMin),xMax:Number(chart.dataset.defaultXMax),yMin:Number(chart.dataset.defaultYMin),yMax:Number(chart.dataset.defaultYMax)},
  view:{xMin:Number(chart.dataset.xMin),xMax:Number(chart.dataset.xMax),yMin:Number(chart.dataset.yMin),yMax:Number(chart.dataset.yMax)},
});

function showTooltip(chart,event,ui){
  const svg=chart.querySelector("svg"),tooltip=chart.querySelector(".chart-tooltip");
  if(!svg||!tooltip)return;
  const rect=svg.getBoundingClientRect(),viewBox=svg.viewBox.baseVal;
  const px=(event.clientX-rect.left)/rect.width*viewBox.width,py=(event.clientY-rect.top)/rect.height*viewBox.height;
  let best=null,distance=Infinity;
  for(const point of chart.querySelectorAll("[data-chart-point]")){
    const dx=Number(point.dataset.px)-px,dy=Number(point.dataset.py)-py,d=dx*dx+dy*dy;
    if(d<distance){distance=d;best=point;}
  }
  if(!best)return;
  tooltip.textContent=best.dataset.tooltip||"";tooltip.hidden=false;
  tooltip.style.left=`${Math.max(8,event.clientX-chart.getBoundingClientRect().left+10)}px`;
  tooltip.style.top=`${Math.max(8,event.clientY-chart.getBoundingClientRect().top-34)}px`;
  ui.chartTooltips[chart.dataset.chartId]=best.dataset.pointId||best.dataset.tooltip||"selected";
}

export function bindChartInteractions(root,ui,redraw){
  for(const chart of root.querySelectorAll("[data-interactive-chart]")){
    const id=chart.dataset.chartId,pointers=new Map();let drag=null,pinch=null;
    chart.addEventListener("wheel",event=>{
      event.preventDefault();const rect=chart.getBoundingClientRect(),{defaults,view}=attrs(chart);
      const next=zoomViewport(view,defaults,clamp((event.clientX-rect.left)/rect.width,0,1),clamp((event.clientY-rect.top)/rect.height,0,1),event.deltaY<0?.8:1.25);
      ui.chartViewports[id]=next;redraw();
    },{passive:false});
    chart.addEventListener("pointerdown",event=>{
      chart.style.touchAction="none";
      chart.setPointerCapture?.(event.pointerId);pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
      if(pointers.size===1)drag={x:event.clientX,y:event.clientY,view:{...attrs(chart).view}};
      if(pointers.size===2){const [a,b]=[...pointers.values()];pinch={distance:Math.hypot(a.x-b.x,a.y-b.y),view:{...attrs(chart).view}};}
    });
    chart.addEventListener("pointermove",event=>{
      if(!pointers.has(event.pointerId)){showTooltip(chart,event,ui);return;}
      pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});const rect=chart.getBoundingClientRect(),{defaults}=attrs(chart);
      if(pointers.size===2&&pinch){const [a,b]=[...pointers.values()],distance=Math.hypot(a.x-b.x,a.y-b.y);
        ui.chartViewports[id]=pinchViewport(pinch.view,defaults,pinch.distance,distance,clamp(((a.x+b.x)/2-rect.left)/rect.width,0,1),clamp(((a.y+b.y)/2-rect.top)/rect.height,0,1));
      }else if(drag&&ui.chartViewports[id]?.isUserModified){
        ui.chartViewports[id]=panViewport(drag.view,defaults,(event.clientX-drag.x)/rect.width,(event.clientY-drag.y)/rect.height);
      }
    });
    const finish=event=>{if(pointers.has(event.pointerId)){showTooltip(chart,event,ui);pointers.delete(event.pointerId);}if(!pointers.size){chart.style.touchAction="pan-y";drag=null;pinch=null;redraw();}};
    chart.addEventListener("pointerup",finish);chart.addEventListener("pointercancel",finish);
  }
}
