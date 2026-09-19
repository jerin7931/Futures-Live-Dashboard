# Finviz Opportunity Screener

Primary private dashboard: https://jerin7931.github.io/Futures-Live-Dashboard/

Owner authentication/RLS unchanged. `/screener/` opens the same application.
Isolated `/screener/canary.html` and `/screener/qualification.html` remain
engineering-only. No synthetic data is added to normal production.

Old SPY/QQQ model and GEX UI retired September19,2026. Rollback baseline tag:
`pre-spy-qqq-retirement-20260919` (bf4607b). Never publish private archives.

`npm test`, `npm run build`, `npm run typecheck` cover the complete website.
CAPTURE_ONLY remains; deployment cannot activate strategy or options.
