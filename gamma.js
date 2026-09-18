export const GAMMA_URLS = Object.freeze({
  SPX: "https://www.insiderfinance.io/gamma-exposure/SPX",
  SPY: "https://www.insiderfinance.io/gamma-exposure/SPY",
  QQQ: "https://www.insiderfinance.io/gamma-exposure/QQQ",
});

export const GAMMA_SYMBOLS = Object.freeze(Object.keys(GAMMA_URLS));

export function createGammaFrameManager({ document, host, status, selected, openOriginal, symbolButtons }) {
  const frames = new Map();
  let currentSymbol = "SPX";

  function updateControls(symbol) {
    selected.textContent = symbol;
    openOriginal.href = GAMMA_URLS[symbol];
    for (const button of symbolButtons) {
      const active = button.dataset.gammaSymbol === symbol;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    }
  }

  function createFrame(symbol) {
    const slot = document.createElement("div");
    slot.className = "gamma-frame-slot";
    slot.dataset.gammaFrame = symbol;
    slot.hidden = true;

    const loading = document.createElement("div");
    loading.className = "gamma-loading";
    loading.setAttribute("role", "status");
    loading.textContent = `Loading InsiderFinance ${symbol} Gamma / GEX…`;

    const frame = document.createElement("iframe");
    frame.loading = "lazy";
    frame.title = `InsiderFinance ${symbol} Gamma Exposure`;
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    frame.src = GAMMA_URLS[symbol];
    frame.addEventListener("load", () => {
      loading.hidden = true;
      slot.classList.add("loaded");
      if (currentSymbol === symbol) status.textContent = "InsiderFinance view loaded";
    });

    slot.appendChild(loading);
    slot.appendChild(frame);
    host.appendChild(slot);
    const record = { frame, loading, slot };
    frames.set(symbol, record);
    return record;
  }

  function select(symbol) {
    if (!GAMMA_SYMBOLS.includes(symbol)) return null;
    currentSymbol = symbol;
    const activeRecord = frames.get(symbol) || createFrame(symbol);
    for (const [frameSymbol, record] of frames) record.slot.hidden = frameSymbol !== symbol;
    activeRecord.slot.hidden = false;
    activeRecord.loading.hidden = activeRecord.slot.classList.contains("loaded");
    status.textContent = activeRecord.loading.hidden
      ? "InsiderFinance view loaded"
      : `Loading InsiderFinance ${symbol} Gamma / GEX…`;
    updateControls(symbol);
    return activeRecord.frame;
  }

  function open() {
    return select(currentSymbol);
  }

  function reloadCurrent() {
    const record = frames.get(currentSymbol);
    if (!record) return false;
    record.slot.classList.remove("loaded");
    record.loading.hidden = false;
    status.textContent = `Reloading InsiderFinance ${currentSymbol} Gamma / GEX…`;
    record.frame.src = GAMMA_URLS[currentSymbol];
    return true;
  }

  function destroy() {
    host.replaceChildren();
    frames.clear();
    currentSymbol = "SPX";
    status.textContent = "Open Gamma / GEX to load SPX";
    updateControls(currentSymbol);
  }

  return {
    destroy,
    frameCount: () => frames.size,
    getCurrentSymbol: () => currentSymbol,
    getFrame: (symbol) => frames.get(symbol)?.frame || null,
    open,
    reloadCurrent,
    select,
  };
}
