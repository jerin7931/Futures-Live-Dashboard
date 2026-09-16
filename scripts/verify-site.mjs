import { readFile } from "node:fs/promises";

const requiredFiles = ["index.html", "styles.css", "app.js", "core.js", "config.js"];
const contents = Object.fromEntries(await Promise.all(requiredFiles.map(async (file) => [file, await readFile(new URL(`../${file}`, import.meta.url), "utf8")])));
const forbidden = ["predictive_model_state_live", "market_briefs", "options_signal_v2_live", "options_chain_live", "EMA/CCI", "NinjaTrader", "GEX map", "trade manager"];
for (const [file, content] of Object.entries(contents)) {
  for (const term of forbidden) {
    if (content.toLowerCase().includes(term.toLowerCase())) throw new Error(`${file} still references legacy term: ${term}`);
  }
}
for (const id of ["healthGrid", "spyCard", "qqqCard", "bestOpportunity", "optionContract", "esFootprint", "mnqFootprint", "history", "timing"]) {
  if (!contents["index.html"].includes(`id="${id}"`)) throw new Error(`Missing required dashboard region: ${id}`);
}
if (/service[_-]?role|SUPABASE_SECRET|WEBULL_APP/i.test(Object.values(contents).join("\n"))) throw new Error("Privileged credential marker found in browser files");
console.log("Static production bundle verified:", requiredFiles.join(", "));
