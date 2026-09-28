export function createUIState(routeState={page:"home",demo:false}){
  return {
    ...routeState,
    optionsSymbol:"SPX",
    efficiencyTimeframes:{SPX:"M1",QQQ:"M1",IWM:"M1",SPY:"M1"},
    chainFilters:{security:"ALL",right:"ALL",askMin:"",askMax:"",sort:"near-spot",direction:"asc"},
    chartViewports:{},
    chartTooltips:{},
    aiExpanded:{SPX:false,QQQ:false,IWM:false,SPY:false},
    aiHistoryFetchedAt:0,
    scrollPositions:{},
  };
}

const finite=value=>Number.isFinite(Number(value))?Number(value):null;

export function viewportFor(ui,id,defaults){
  const saved=ui.chartViewports[id];
  if(saved&&[saved.xMin,saved.xMax,saved.yMin,saved.yMax].every(value=>finite(value)!==null))return saved;
  const viewport={...defaults,isUserModified:false};
  ui.chartViewports[id]=viewport;
  return viewport;
}

export function setViewport(ui,id,next){
  ui.chartViewports[id]={xMin:Number(next.xMin),xMax:Number(next.xMax),yMin:Number(next.yMin),yMax:Number(next.yMax),isUserModified:true};
  return ui.chartViewports[id];
}

export function resetViewport(ui,id,defaults){
  ui.chartViewports[id]={...defaults,isUserModified:false};
  delete ui.chartTooltips[id];
  return ui.chartViewports[id];
}

export function capturePageState(root,ui){
  const table=root.querySelector?.(".chain-table-wrap");
  if(table)ui.scrollPositions.optionChain={top:table.scrollTop,left:table.scrollLeft};
  for(const panel of root.querySelectorAll?.("[data-ai-history-scroll]")||[]){
    ui.scrollPositions[`ai:${panel.dataset.symbol}`]={top:panel.scrollTop,left:panel.scrollLeft};
  }
}

export function restorePageState(root,ui){
  const table=root.querySelector?.(".chain-table-wrap"),chain=ui.scrollPositions.optionChain;
  if(table&&chain){table.scrollTop=chain.top;table.scrollLeft=chain.left;}
  for(const panel of root.querySelectorAll?.("[data-ai-history-scroll]")||[]){
    const saved=ui.scrollPositions[`ai:${panel.dataset.symbol}`];
    if(saved){panel.scrollTop=saved.top;panel.scrollLeft=saved.left;}
  }
}
