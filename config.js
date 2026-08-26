// ============================================================
// PUBLIC WEBSITE CONFIGURATION
//
// The publishable key is intentionally safe to expose in browser
// code when Row Level Security is enabled correctly.
//
// NEVER put your Supabase secret key in this file.
// ============================================================

window.DASHBOARD_CONFIG = {
  supabaseUrl: "https://ojllysxtmssbvkhklzoe.supabase.co",
  supabasePublishableKey: "sb_publishable_1V4TmaAzkfuyuKl2LRXUYg_fJGxgT7w",
  appName: "Futures Market Dashboard",
  timezone: "America/Chicago",
  pollSeconds: 60
};
/* V33_UI_REFINEMENT_V1_0_4_LOADER
   Frontend presentation patch only. Core V33 / server scoring remain unchanged. */
window.addEventListener("DOMContentLoaded", () => {
  if (document.querySelector("script[data-v33-ui-refinement]")) return;
  const script = document.createElement("script");
  script.src = "./ui_v33_patch.js?v=20260826a";
  script.dataset.v33UiRefinement = "1";
  document.body.appendChild(script);
});
/* V33_NY_ASIA_MARKET_SESSION_V1_0_0_LOADER
   Session-market UI/data extension only; frozen model scoring is unchanged. */
window.addEventListener("DOMContentLoaded", () => {
  if (document.querySelector("script[data-v33-asia-market]")) return;
  const script = document.createElement("script");
  script.src = "./asia_market_v33.js?v=20260825i";
  script.dataset.v33AsiaMarket = "1";
  document.body.appendChild(script);
});
