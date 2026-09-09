# Options Dashboard Telegram Mirror V1

Telegram is an asynchronous notification mirror of the approved Options Dashboard state. It does not score models, select contracts, assign grades, calculate Direct-MFE surfaces, change Aim For values, or mutate thesis/invalidation state. It has no broker or order capability.

## Episode contract

Each new `setup_episode_id` may create one root message. The root includes the model, strike, side, grade, selected 1DTE contract, delta, bid/ask, underlying price, displayed 3x3 Direct-MFE surface, Aim For values, invalidation condition, Central Time timestamp, and setup ID. Every subsequent event replies to the persisted root message ID.

Allowed follow-ups are a warning transition, one message for each AIM10/AIM20/AIM30 milestone, optional HOLD messages near 10 and 20 minutes, immediate invalidation, and a 30-minute exit/reassess message. Invalidation and 30-minute completion close Telegram tracking for the episode. A later setup uses a new root.

Option return always uses `current option bid / original setup ask - 1`. Underlying movement is the actual current minus original underlying move and is never direction-inverted for PUTs. Stale quotes cannot trigger milestones, HOLD, or window-completion messages.

## Delivery and persistence

The bounded priority worker orders invalidation/window-complete, warning, take-profit, root, and HOLD work without entering the inference hot path. Telegram errors degrade only Telegram delivery; model inference and website guidance continue.

Durable state is stored outside Git under the production root. It contains episode IDs, root message IDs, sent/inflight dedupe keys, setup reference values, and closed state. It does not contain the bot token or destination. Credentials remain in the pre-existing external Telegram configuration and are loaded only by the backend process.

## No-refit and safety guarantee

The mirror imports no training or tuning implementation. It never invokes `fit`, `partial_fit`, Optuna, recalibration, broker APIs, or order APIs. It mirrors the four frozen Direct Time-Conditioned MFE model states only.
