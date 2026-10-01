export function createUIState(routeState={page:"home",demo:false}){
  return {
    ...routeState,
    optionsSymbol:"SPX",
    optionsZoom:"NEAR",
    efficiencyTimeframes:{SPX:"M1",QQQ:"M1",IWM:"M1",SPY:"M1"},
    efficiencyModes:{SPX:"RECENT",QQQ:"RECENT",IWM:"RECENT",SPY:"RECENT"},
    efficiencyRecentOffsets:{SPX:0,QQQ:0,IWM:0,SPY:0},
    expandedPriceEfficiency:null,
    chainFilters:{security:"ALL",right:"ALL",askMin:"",askMax:"",sort:"near-spot",direction:"asc"},
    aiExpanded:{SPX:false,QQQ:false,IWM:false,SPY:false},
    aiDetailOpen:{},
    aiHistoryFetchedAt:0,
    scrollPositions:{},
  };
}

export function capturePageState(root,ui){
  const table=root.querySelector?.(".chain-table-wrap");
  if(table)ui.scrollPositions.optionChain={top:table.scrollTop,left:table.scrollLeft};
  for(const panel of root.querySelectorAll?.("[data-ai-history-scroll]")||[]){
    ui.scrollPositions[`ai:${panel.dataset.symbol}`]={top:panel.scrollTop,left:panel.scrollLeft};
  }
  for(const detail of root.querySelectorAll?.("details[data-ai-detail-key]")||[]){
    ui.aiDetailOpen[detail.dataset.aiDetailKey]=detail.open;
  }
}

export function restorePageState(root,ui){
  const table=root.querySelector?.(".chain-table-wrap"),chain=ui.scrollPositions.optionChain;
  if(table&&chain){table.scrollTop=chain.top;table.scrollLeft=chain.left;}
  for(const panel of root.querySelectorAll?.("[data-ai-history-scroll]")||[]){
    const saved=ui.scrollPositions[`ai:${panel.dataset.symbol}`];
    if(saved){panel.scrollTop=saved.top;panel.scrollLeft=saved.left;}
  }
  for(const detail of root.querySelectorAll?.("details[data-ai-detail-key]")||[]){
    if(Object.hasOwn(ui.aiDetailOpen,detail.dataset.aiDetailKey))detail.open=ui.aiDetailOpen[detail.dataset.aiDetailKey];
  }
}
