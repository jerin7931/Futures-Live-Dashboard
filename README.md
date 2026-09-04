# TradyticsBot website

The `prototype/options-command` redesign opens directly on a simulated options
decision workspace for SPY and QQQ. It includes 1DTE/0DTE switching, a dynamic
contract recommendation, 30% target calculation, market structure, futures
order-flow placeholders, pipeline latency, and a ten-strike option ladder.

Start the local prototype from this directory:

```powershell
python -m http.server 4173 --bind 127.0.0.1
```

Then open `http://127.0.0.1:4173/`.

All displayed market data is simulated. The prototype does not authenticate,
read Supabase, or transmit orders. The existing V35 files remain available in
the repository for production integration.

For the production website, `config.js` contains only the Supabase project URL
and publishable browser key. The service-role key must remain in the local
`.env` file and must never be added to browser code.
