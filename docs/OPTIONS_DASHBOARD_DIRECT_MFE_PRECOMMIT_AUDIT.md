# Options Dashboard Direct-MFE PRE-COMMIT Audit

> REVIEW STATUS: local implementation complete and uncommitted. No push, migration, production-service start, website deployment, startup-persistence change, 0DTE collection, model fitting, broker action, or locked-holdout access occurred.

## Executive decision

The reviewed Predictive Live runtime has been adapted to the approved `DIRECT_MFE_MODELS_FROZEN_V2` fleet. It loads four frozen models once, produces all 18 direct time-conditioned MFE probabilities, preserves raw and deterministic two-dimensional monotone display surfaces, grades from `P30_30`, derives three horizon-specific Aim For values, and retains the previously approved sticky thesis/invalidation lifecycle.

The visible product is now **Options Dashboard**. The existing `/predictive/` route is retained for continuity. Production scope is strictly SPY and QQQ actual 1DTE. No 0DTE collection or recommendation path was added.

## Governance boundary

| Control | Result |
|---|---|
| Git base commit | `6ee8286baead001a3b142c19838dae3d82895940` |
| Current work | Uncommitted local working tree |
| Production service | Stopped; verify-only load performed |
| Website | Local demonstration preview only |
| Supabase | Existing applied JSONB current-state schema reused; no additive migration required or applied |
| Startup persistence | Unchanged and uninstalled for this candidate |
| Locked reserve | 2026-08-17 through 2026-09-04 remains `LOCKED_UNACCESSED` |
| 0DTE | Not collected, scored, displayed, or recommended |
| Training | No `fit`, `partial_fit`, Optuna, tuning, recalibration, or online learning in production |

The locked-reserve manifest continues to set feature access and target access to false and records that outcomes were not inspected. Parity work used approved corrected development data through 2026-06-30 only.

## Frozen Direct-MFE model fleet

| Production model | Inputs | Features | Calibration | Model SHA256 |
|---|---|---:|---|---|
| SPY OPTIONS ONLY | corrected option tape | 167 | none | `e0a81ddb547958121ea29fb309577a15b5af0b629205b22c5939ef3a5d65ebc1` |
| SPY OPTIONS + ES | corrected option tape + ES | 246 | none | `688ad9e3e5893223a807be0c56e483cb7e17a8fa448d8ae5ac525897d764ea10` |
| QQQ OPTIONS ONLY | corrected option tape | 167 | isotonic | `6d3a2c06ed5db76470c4d35323f5d47e9f33a50e2775a659c47a2242a7acc103` |
| QQQ OPTIONS + NQ | corrected option tape + NQ | 246 | isotonic | `832666b15ab41065caffba721d5fd36ddb33eac438aed5caebcd98f11abf55a6` |

Startup verifies each model, preprocessor, calibrator, feature list, and source freeze manifest against the production registry. A missing or mismatched artifact fails closed; the runtime has no fitting fallback. Verify-only startup reported all four artifacts `VERIFIED` and zero predictions.

## Direct probability surface contract

Each model evaluates the immutable query grid:

- Targets: +5%, +10%, +15%, +20%, +25%, +30% observed-bid MFE.
- Horizons: 10, 20, and 30 minutes.
- Language: `P(historical proxy observed-bid MFE >= target by horizon)`.

The runtime supplies the frozen feature vector to the frozen preprocessor once, appends each of the 18 query pairs, performs one batched XGBoost inference, and applies the frozen calibrator. It stores:

- `uncalibrated_probability_surface` for model-runtime audit;
- `raw_probability_surface` after the frozen calibrator;
- `display_probability_surface` after the approved deterministic 2D projection.

The display projection uses repeated one-dimensional pooled-adjacent-violators projections across both axes until stable. It constrains target probabilities downward as the target rises and horizon probabilities upward as time increases. It does not mutate raw probabilities.

## Grade and Aim For contracts

Grade is derived only from display `P(+30% by 30m)`:

| Grade | Direct probability |
|---|---|
| A | `P30_30 >= 0.25` |
| B | `0.15 <= P30_30 < 0.25` |
| C | `0.10 <= P30_30 < 0.15` |
| Ungraded | `P30_30 < 0.10` |

For horizon H in 10, 20, 30 minutes, the visible Aim For percentage is `5 * sum(P5_H, P10_H, P15_H, P20_H, P25_H, P30_H)`. Display uses the monotone surface and rounds to the nearest whole percentage point. Raw-surface Aim For is retained separately. Values are bounded from 0% through 30% and suppressed when guidance or quotes are invalid.

## Corrected Quant option-tape contract

Historical and live classification share `QUANT_TRADETYPE_COMPLEX_TIED_V1`, SHA256 `3d537d227ebd2198c99d230dff11b108f18e079570f759f07b2975ceada3296f`.

- Model context is actual 1DTE and `0.55 <= abs(delta) <= 0.75`.
- Actionable candidates are actual 1DTE and `0.60 <= abs(delta) <= 0.70`.
- Live ingestion uses `TRADE_TYPE`; it does not request unavailable `isComplex` or `isTied` projections.
- Unknown trade types remain ambiguous and non-directional.
- Bad, cancel, and out-of-sequence conditions fail closed.
- Complex/tied activity is available as context and never reclassified as outright simple directional flow.
- Individual Greek fields are used rather than the rejected aggregate `GREEKS` projection.
- Same-millisecond causal exclusion, durable pagination/watermarks, deterministic deduplication, warmup, and the exact completed 60-second candidate cadence remain intact.

## Live and research parity

Representative corrected historical events from 2026-06-30 were replayed through the live adapter.

| Parity check | Count | Mismatches | Maximum absolute difference |
|---|---:|---:|---:|
| SPY option features | 167 | 0 | `5.02e-10` |
| QQQ option features | 167 | 0 | `4.15e-10` |
| ES futures features | 79 | 0 | `9.86e-19` |
| NQ futures features | 79 | 0 | `2.42e-18` |
| Four models, direct cells | 72 | 0 | `0.0` |

All four production surfaces matched an independent research-style reconstruction exactly for uncalibrated, calibrated/raw, and projected/display values. The evidence file records the exact candidate IDs and replay counts.

## Live decision path

Provider events update bounded in-memory state. Only completed 60-second candidate decisions become actionable. The local decision path is:

1. incremental option and optional ES/NQ feature snapshot;
2. frozen 18-cell inference and frozen calibration;
3. deterministic monotone display projection;
4. deterministic contract selection;
5. grade and three Aim For values;
6. sticky thesis/invalidation update;
7. coalesced high-priority publish enqueue;
8. asynchronous append-only forward recording.

Options-only models do not depend on futures health. SPY + ES and QQQ + NQ fail closed independently if their required futures source is stale. Model event age, quote age, structure age, and provider health remain separate.

## Sticky thesis and invalidation

The previously reviewed invalidation state machine is unchanged. Active CALL and PUT episodes cannot silently reverse. Selected-contract persistence is separate from the newest completed-cadence same-side and opposite-side evidence. An invalidated setup is terminal for its `setup_episode_id`; quote updates and stronger later scores cannot revive it. A new direction requires an explicit new episode after invalidation/re-arm. Data degradation suppresses guidance without erasing thesis memory or fabricating a reversal.

## Website implementation

The local preview presents:

- Options Dashboard title, metadata, and mobile header;
- session and nine-provider health derived from backend state;
- separate SPY/QQQ gamma regime and deterministic market condition;
- four independent equal-height model cards in a desktop 2x2 grid;
- prominent strike, CALL/PUT, expiration, 1DTE, delta, bid, and ask;
- visible Grade and `P(+30% by 30m)` strength;
- a readable 3x3 +10/+20/+30 by 10m/20m/30m matrix;
- three horizon-specific Aim For values;
- visible invalidation condition, thesis state, data state, and dynamic ages;
- the reviewed GEX 2x2 grid and current 1DTE option ladder.

The ladder retains current contracts, quote/context ages, Greeks including Vanna and Charm, GEX/positioning, corrected simple-directional flow context, model eligibility, selection markers, direct `P30_30`, grade, and three Aim For values. Supabase Realtime remains an authenticated initial read plus row-level changes; it does not poll whole tables once per second.

## Supabase compatibility

No new migration is needed for Direct-MFE V1. The already-applied `predictive_model_state_live.payload` JSONB contract accommodates the compact direct-surface payload while existing identifying and timestamp columns remain unchanged. The runtime publishes the nine reviewed provider IDs. No applied migration history was edited, and no database action was performed in this local phase.

## Forward-data contract

Append-only local records preserve model ID/version, candidate and contract, direction, grade, exact `P30_30`, raw and display 18-cell surfaces, raw and display Aim For values, quotes and ages, market condition, gamma regime, structure/invalidation, ES/NQ state, feature hash, and latency. Writes remain asynchronous and non-finite numbers are normalized. Outcome quote paths are collected for later 1DTE executable forward validation. No forward observation changes model parameters.

> PRODUCTION MODEL PARAMETERS DO NOT UPDATE FROM FORWARD DATA.

## Test and replay evidence

| Check | Result |
|---|---|
| Full pytest suite | 129 passed; 0 failed; 24 dependency deprecation warnings |
| Python compile | PASS |
| Browser JavaScript syntax | PASS |
| Verify-only four-artifact startup | PASS |
| Option and futures feature parity | PASS |
| Four-model 18-cell inference parity | PASS |
| Raw/display surface separation and monotonicity | PASS |
| Grade and three Aim For contracts | PASS |
| Sticky invalidation regressions | PASS |
| Local desktop, degraded, ladder, and 390 x 844 mobile renders | PASS |
| Browser console in local demonstration mode | 0 warnings; 0 errors |

Tests also cover hash failures, no fitting path, one-time model loading, corrected trade classification, pagination/watermark, warmup, 60-second cadence, RTH horizon, deterministic selection, stale dependencies, publisher priority, forward-store safety, GEX persistence, ladder merging, and provider fault isolation.

## Replay latency

Accelerated synthetic live-shaped replay was used; these figures are not live-market latency.

| Model | p50 ms | p95 ms | p99 ms | max ms |
|---|---:|---:|---:|---:|
| SPY OPTIONS ONLY | 17.42 | 20.69 | 22.86 | 23.67 |
| SPY OPTIONS + ES | 18.98 | 22.49 | 24.57 | 25.11 |
| QQQ OPTIONS ONLY | 11.48 | 20.49 | 24.21 | 49.08 |
| QQQ OPTIONS + NQ | 20.58 | 23.31 | 26.01 | 28.79 |

All p95 values met the 25 ms goal and all p99 values met the 50 ms goal. There were zero surface-contract failures. The asynchronous forward recorder wrote 1,447 rows with zero drops/errors. Local publisher p95/p99 acknowledgement was 6.40/7.25 ms. Under simulated 50-150 ms network latency, the high-priority model update acknowledged in 100.78 ms and was not trapped behind the ladder flood; low-priority drain latency is reported separately in the raw evidence.

## Security and failure behavior

The review package is scanned for Quant keys, private keys, JWT-like tokens, AWS keys, and service-role credentials. Browser configuration contains only the intended publishable credential contract. Backend secrets, signatures, local credential files, logs, and forward history are excluded.

Runtime failures remain fail-closed for artifact mismatch, invalid/crossed quotes, wrong DTE, stale required sources, unresolvable feature schema, timestamp disorder, and futures/structure dependency loss. No missing predictive evidence is converted to zero.

## Known limitations

- Historical MFE probabilities use the approved observed-bid proxy and are not guaranteed executable profit probabilities.
- The locked Aug-Sep reserve was deliberately not accessed, so the product states that historical development validation is complete and forward live validation is accumulating.
- Latency evidence is accelerated local replay, not a claim about live provider or Internet latency.
- Screenshots use deterministic local demonstration data and do not imply a live-market smoke test.
- Deployment, production Realtime, owner authentication, and live provider behavior remain post-approval verification items.

## Proposed post-approval deployment sequence

1. Verify the package ZIP and SHA inventory, then selectively stage only reviewed durable source.
2. Confirm no audit directories, screenshots, local model copies, credentials, or forward data are staged.
3. Commit on top of `6ee8286baead001a3b142c19838dae3d82895940` and push the dedicated correction branch.
4. Re-run verify-only startup against the copied frozen registry.
5. Because no additive migration is required, verify the existing owner-only tables, RLS, provider identifiers, and Realtime publication without rewriting migration history.
6. Start one idempotent backend instance, perform a non-trading live smoke test, and keep V1/V2 untouched.
7. Deploy `/predictive/` with the visible Options Dashboard name and verify authenticated desktop/mobile behavior.
8. Install startup persistence only after service, UI, Realtime, health, forward logging, and rollback checks pass.

Rollback stops only the Options Dashboard predictive service, disables only its startup entry, and reverts only the new website/commit if needed. Existing V1/V2 and append-only forward history remain intact.
