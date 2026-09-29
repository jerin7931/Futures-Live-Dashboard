import {readFile,writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {buildTVG2,parseTVG2,TVG2_SYMBOLS} from "../screener/tradingview-gamma.js";

const directory=resolve(process.argv[2]||"");
if(!process.argv[2])throw new Error("OUTPUT_DIRECTORY_REQUIRED");
const live=JSON.parse(await readFile(resolve(directory,"live_supabase_rows_sanitized.json"),"utf8"));
const result=buildTVG2(live.gamma,Date.now());
for(const symbol of TVG2_SYMBOLS)parseTVG2(result.text,symbol);
await writeFile(resolve(directory,"TVG2_REAL_EXAMPLE.txt"),result.text,"utf8");
await writeFile(resolve(directory,"tvg2_packet_summary.json"),JSON.stringify({
  specification:"TVG2\\nSYMBOL|EPOCH_MS|STATUS|REGIME|FLIP|CALL_WALL|PUT_WALL|MAGNET|PROFILE",
  symbolOrder:TVG2_SYMBOLS,
  characterCount:result.characterCount,
  strikeCounts:result.strikeCounts,
  oldestEpoch:result.oldestEpoch,
  oldestGammaAgeMinutes:result.oldestGammaAgeMinutes,
  materialityThresholdMillions:result.materialityThresholdMillions,
  omittedByMateriality:result.omittedByMateriality,
},null,2),"utf8");
