# FuturesDashboard — SPY / QQQ 0DTE

Private, static production dashboard for the scheduled `SPY–QQQ NY 0DTE State` analyst.

- Supabase Auth plus `dashboard_readers` authorization
- Read-only rendering of `intraday_analysis_current`, meaningful `intraday_analysis_history`, ES/MNQ footprint bars, and Webull provider health
- Browser-side stale detection and 12-second bounded polling
- No trading, model inference, probability generation, or privileged credentials in the browser

Production is published from the existing `jerin7931/Futures-Live-Dashboard` GitHub repository. Run `npm run build`, `npm run typecheck`, `npm run lint`, and `npm test` before deployment.
