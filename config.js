// ============================================================
// PUBLIC WEBSITE CONFIGURATION
//
// The publishable key is intentionally safe to expose in browser
// code when Row Level Security is enabled correctly.
//
// NEVER put your Supabase secret key in this file.
// ============================================================

window.DASHBOARD_CONFIG = {
  supabaseUrl: "PASTE_YOUR_SUPABASE_PROJECT_URL_HERE",
  supabasePublishableKey: "sb_publishable_1V4TmaAzkfuyuKl2LRXUYg_fJGxgT7w",
  appName: "Futures Market Dashboard",
  timezone: "America/Chicago",
  pollSeconds: 60
};
