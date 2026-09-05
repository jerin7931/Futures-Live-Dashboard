# Tradytics Options Command

Private paper-trading decision workspace for SPY/QQQ 0DTE and 1DTE options. It combines:

- NinjaTrader ES and NQ Level 1, market-depth, aggressive-volume, cumulative-delta, VWAP, absorption, and flow features.
- An OptionChainLive test adapter with the nearest exact 0DTE/1DTE chain, requested Greeks, open interest, volume, and five strikes on either side of spot.
- A deterministic contract selector constrained to 0.60–0.70 absolute delta.
- A conditional 30% premium target estimated from delta and gamma. Theta and IV changes are not predicted.
- Supabase Auth, RLS-protected current-state tables, and Realtime website updates.
- Ollama explanations on a background worker; the language model cannot alter the selected contract and never runs in the tick path.

The system is decision support only. It has no brokerage credentials and cannot place orders.

## Data path

`NinjaTrader callbacks → in-memory 100 ms buckets → loopback UDP → Python scoring service → Supabase → private website`

NinjaTrader performs no network database writes. The Python process publishes compact current-state rows every 250–500 ms; option-chain polling follows the source's approximately 30-second cadence.

## Components

- `ninjatrader/TradyticsOptionsOrderFlowFeed.cs` — isolated ES/NQ AddOn. It does not replace the existing ES production collector or the MNQ dashboard feed.
- `backend/tradytics_signal_service.py` — UDP receiver, source adapter, feature scorer, fail-closed gates, Supabase publisher, and asynchronous Ollama explanation worker.
- `supabase/schema/options_command.sql` — idempotent tables, constraints, RLS, grants, and Realtime publication setup.
- `index.html`, `options-prototype.css`, `options-prototype.js` — private live dashboard with a clearly labeled demo fallback.

## Local service

The service looks for the existing Futures Dashboard `.env` first. Otherwise copy `.env.example` to an untracked `.env` and provide `SUPABASE_URL` plus a secret/service-role key. Never put that secret in browser code.

```powershell
python .\backend\tradytics_signal_service.py --self-test
python .\backend\tradytics_signal_service.py
```

The website uses only the project URL and publishable browser key. A signed-in user must also exist in `public.dashboard_readers`.

## NinjaTrader activation

Copy the AddOn into `Documents\NinjaTrader 8\bin\Custom\AddOns`, compile NinjaScript, and restart NinjaTrader if prompted. It subscribes to the configured `ES 09-26` and `NQ 09-26` contracts and emits UDP on `127.0.0.1:48636`. Update the two contract constants at rollover.

## Local website preview

```powershell
python -m http.server 4173 --bind 127.0.0.1
```

Open `http://127.0.0.1:4173/`. The deployed site is private and owner-only.
