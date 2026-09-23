import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("production cutover reads the clean project's physical tracker state", () => {
  const config = readFileSync(new URL("../config.js", import.meta.url), "utf8");
  const app = readFileSync(new URL("../screener/app.js", import.meta.url), "utf8");
  assert.match(config, /gbtjmhjhqhtnbswsylvd\.supabase\.co/);
  assert.doesNotMatch(config, /ojllysxtmssbvkhklzoe/);
  assert.match(app, /\.from\("fos_tracker_current_state"\)/);
  assert.doesNotMatch(app, /\.from\("fos_tracker_current"\)/);
});
