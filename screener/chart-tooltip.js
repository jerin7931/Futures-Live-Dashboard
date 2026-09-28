function nearestPoint(host,event){
  const svg=host.querySelector("svg");if(!svg)return null;
  const rect=svg.getBoundingClientRect(),viewBox=svg.viewBox.baseVal;
  const px=(event.clientX-rect.left)/rect.width*viewBox.width,py=(event.clientY-rect.top)/rect.height*viewBox.height;
  let best=null,distance=Infinity;
  for(const point of host.querySelectorAll("[data-chart-point]")){
    const dx=Number(point.dataset.px)-px,dy=Number(point.dataset.py)-py,d=dx*dx+dy*dy;
    if(d<distance){distance=d;best=point;}
  }
  return best;
}

function show(host,event){
  const tooltip=host.querySelector(".chart-tooltip"),point=event.target.closest?.("[data-chart-point]")||nearestPoint(host,event);
  if(!tooltip||!point)return;
  tooltip.textContent=point.dataset.tooltip||"";tooltip.hidden=false;
  const bounds=host.getBoundingClientRect();
  tooltip.style.left=`${Math.max(8,event.clientX-bounds.left+10)}px`;
  tooltip.style.top=`${Math.max(8,event.clientY-bounds.top-34)}px`;
}

export function bindChartTooltips(root){
  for(const host of root.querySelectorAll("[data-chart-tooltip-host]")){
    host.addEventListener("pointermove",event=>show(host,event),{passive:true});
    host.addEventListener("pointerup",event=>show(host,event),{passive:true});
    host.addEventListener("pointerleave",()=>{const tooltip=host.querySelector(".chart-tooltip");if(tooltip)tooltip.hidden=true;},{passive:true});
  }
}
