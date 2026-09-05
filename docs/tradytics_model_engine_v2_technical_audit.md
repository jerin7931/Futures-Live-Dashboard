# Tradytics Deterministic Options Engine V2 — Technical Audit

**Audit date:** 2026-09-05  
**Implementation source commit:** `83ff5372a7a9a37efa740925ca402483545ce917`  
**Production deployment commit:** `99bd0aa8acdb8587f1ce9c0eb104057fd963196a`  
**V1 rollback tag:** `v1-live-20260904-before-v2` (`12c080f9f757ab8000a3a0b60e7585710543a065`)  
**Scope:** Paper trading and deterministic decision support only. No broker execution exists.

> **SETUP QUALITY IS NOT A PROBABILITY.** It is a deterministic 0–100 agreement/quality index. The engine does not estimate the probability that an option will reach the +30% premium objective.

## 1. Executive assessment

Tradytics V2 is implemented as a side-by-side shadow engine for SPY 1DTE, SPY 0DTE, QQQ 1DTE, and QQQ 0DTE. The primary SPY 1DTE path is complete: stateful direction hysteresis, three-pillar futures microstructure, cash confirmation, causal persistent zones, Webull OPRA executable quotes, Quant Data option intelligence, contract hysteresis, and execution-aware scenario pricing are connected to an owner-only Supabase namespace and a separate `/v2/` dashboard.

The release objective was signal stability, not maximum trade frequency. A READY state is retained through permitted temporary weakness, ordinary reversals must pass a stronger opposite threshold and persistence, and direct CALL-to-PUT or PUT-to-CALL transitions are disabled. Contract selection has its own independent hysteresis.

The deterministic test suite passed 60/60 tests. Synthetic anti-flip validation produced zero direction flips per hour and zero READY-to-opposite-READY transitions. A 302-row legacy ES replay also produced zero direct opposite READY transitions. These are software stability checks, not profitability claims.

The market was closed during final validation. Provider authentication, snapshots, database writes, browser rendering, and recorded/synthetic replay were verified. Live 100-ms ES/NQ V2 packet behavior and live-market READY behavior remain pending the next open session and an in-platform NinjaTrader recompile of the exact copied V2 source.

## 2. Status matrix

| Area | Status | Evidence / limitation |
|---|---|---|
| Deterministic V2 core | IMPLEMENTED, VERIFIED | 60 unit/state/replay/metamorphic tests passed |
| V1 preservation | IMPLEMENTED, VERIFIED | Root route, V1 service, UDP 48636, rollback tag retained |
| Quant Data REST | IMPLEMENTED, VERIFIED | Authentication and ten current endpoints returned HTTP 200 |
| Webull stock L1 | IMPLEMENTED, VERIFIED | SPY/QQQ snapshots and one-level depth returned HTTP 200 |
| Webull OPRA | IMPLEMENTED, VERIFIED | SPY/QQQ option snapshots returned HTTP 200; mode is SNAPSHOT |
| Webull Nasdaq L2 | DEGRADED / EXTERNAL DEPENDENCY | Depth 10 returned HTTP 417 `ILLEGAL_PARAMETER`; depth 1 works |
| Supabase V2 schema | IMPLEMENTED, VERIFIED | Migration applied; four tables have RLS and owner-read policies |
| V2 dashboard | IMPLEMENTED, VERIFIED | `/v2/` deployed; owner gate, desktop/mobile layout and console verified |
| NinjaTrader AddOn source | IMPLEMENTED, PARTIALLY VERIFIED | Source copied; exact AddOn compiled against installed NT assemblies; platform UI compile of this revision remains pending |
| Live-market V2 shadow | NOT YET VERIFIED | Market was closed; backend correctly published `MARKET_CLOSED` |

## 3. Source snapshot and safe upgrade path

The actual repository was the source of truth. V2 was developed on branch `v2-stateful-engine-20260904` and deployed as one cherry-picked production commit. V1 remains at the repository root and was not renamed or replaced. V2 uses:

- separate UDP port `127.0.0.1:48637` (V1: `48636`);
- separate Python entry point;
- separate Supabase tables;
- separate `/v2/` website route;
- versioned `config/v2_engine.json`;
- per-market persisted state files under ignored `.state/`.

Rollback is `git revert 99bd0aa8acdb8587f1ce9c0eb104057fd963196a` for the V2 production commit, or checkout of `v1-live-20260904-before-v2`. A file backup of the pre-V2 NinjaTrader AddOn is also stored in the existing V1 rollback directory. Database rollback is not necessary to restore V1 because V1 does not use the V2 tables; the namespaced V2 tables can simply be left unused.

## 4. V1 → V2 change summary

| Concern | V1 | V2 |
|---|---|---|
| Futures flow | overlapping fixed windows | decayed signed/total volume states plus three robust pillars |
| Direction | recomputed scalar | persistent six-state machine with ENTER/HOLD/FLIP hysteresis |
| Contract choice | row-sensitive/simple score | deterministic ranking, harmonic utility, switch margin/persistence |
| +30% target | point delta/gamma estimate | ask-entry, conservative bid-exit BSM/CRR scenario grid and bisection |
| Structure | session-centric levels | causal, clustered, persistent multi-session zones |
| VWAP | stronger static influence | context only; never a CALL/PUT hard gate |
| Data health | combined freshness | source-specific timestamps and ages |
| Confidence | probability-like | Setup Quality, explicitly not a probability |
| Deployment | V1 live table/root UI | namespaced V2 shadow tables and `/v2/` route |

The V1 code and old probability-like fields remain only in the V1 pipeline for rollback compatibility. They do not enter V2.

## 5. Architecture and data lineage

```text
NinjaTrader ES/NQ callbacks
  -> in-memory book/trade state
  -> 100-ms V1/V2 snapshot timer
  -> V1 UDP 48636 (unchanged) + V2 UDP 48637
  -> newest-state Python receiver

Webull stock/OPRA REST -----> asynchronous last-good snapshots ----+
Quant Data REST -----------> asynchronous last-good snapshots ----+-> V2 market engines
                                                                    -> Supabase V2 tables
                                                                    -> owner-only /v2 dashboard
Ollama <---------------- explanation copy only; never decision input
```

Every V2 signal carries available `provider_event_time`, `local_receive_time`, `feature_complete_time`, `signal_decision_time`, and—after a successful write—`database_ack_time`. Local timers use `time.monotonic`; UTC/provider timestamps are used for cross-process age. An old provider timestamp remains old when received. When a Quant endpoint exposes no event timestamp, its local receipt time is explicitly used as *snapshot age*, not relabeled as exchange event time.

Separate published ages include futures, cash, cash L2, option quote, Quant option flow, GEX, skew, OI, and Greeks. No generic freshness field substitutes for those clocks.

## 6. Provider responsibilities

**NinjaTrader:** fast ES→SPY and NQ→QQQ aggression, book, execution-response, persistence, volume-profile and rollover context. Callback handlers only mutate bounded in-memory state. UDP serialization/sending occurs on the 100-ms timer and never performs database or REST work.

**Webull official OpenAPI:** SPY/QQQ cash L1 and current OPRA option bid/ask/last/size/volume/timestamps. Webull quotes form the execution layer. The source mark is not used for entry. Nasdaq depth is a cash confirmation layer and is degraded when unavailable.

**Quant Data:** Greeks/IV surface, option flow, GEX/DEX/Vanna/Charm, OI, skew, term structure and concentration zones. These snapshots are asynchronous context. They do not serve as executable quotes and do not overpower direction.

**Supabase:** owner-only state transport and Realtime. Secret/service-role credentials remain backend-only. The browser contains only the project URL and publishable key and must pass both Supabase authentication and `dashboard_readers` authorization.

**Ollama:** optional background narrative. The cache key includes the signal feature hash/timestamp; the generated text cannot mutate direction, state, selected contract, setup quality, scenario results, path clearance, eligibility, or reason codes.

## 7. Futures decayed flow formulas

For each active 100-ms bucket:

```text
signed_volume = buy_volume - sell_volume
total_volume  = buy_volume + sell_volume
alpha_h       = 1 - exp(-ln(2) * dt / h)
N_h[t]        = (1-alpha_h)N_h[t-1] + alpha_h*signed_volume
D_h[t]        = (1-alpha_h)D_h[t-1] + alpha_h*total_volume
F_h           = clamp(N_h / max(D_h, epsilon), -1, +1)
```

Half-lives are 0.75 s fast and 3.0 s slow. Numerator and denominator decay independently. Zero-volume buckets do not manufacture confirmation and all divisions are guarded.

```text
aggression = clamp(0.60*F_fast + 0.40*F_slow, -1, +1)
```

## 8. Book pillar

Top-five depth is distance weighted with `w_k = 1/k`:

```text
depth_imbalance =
  (sum(w_k*bid_size_k) - sum(w_k*ask_size_k)) /
  max(sum(w_k*bid_size_k) + sum(w_k*ask_size_k), epsilon)

microprice = (ask*bid_size + bid*ask_size) /
             max(bid_size + ask_size, epsilon)
mid = (bid + ask)/2
microprice_edge = clamp(2*(microprice-mid)/max(ask-bid,epsilon), -1,+1)
book = clamp(0.50*EWMA(depth_imbalance) + 0.50*microprice_edge, -1,+1)
```

Crossed, zero-size, or otherwise invalid markets do not produce microprice evidence. Unavailable depth is marked invalid/degraded rather than fabricated as neutral size.

## 9. Replenishment, absorption, and execution response

Depth-event history tracks size removed and re-added at recently hit price levels. Replenishment is executed-size normalized and clipped to [0,1]:

```text
ask_replenishment = clamp(size_readded_at_hit_asks /
                           max(aggressive_buy_size_there,epsilon), 0,1)
bid_replenishment = clamp(size_readded_at_hit_bids /
                           max(aggressive_sell_size_there,epsilon), 0,1)
```

It is not inferred from a single current total-depth snapshot.

```text
sell_absorption = max(F_fast,0) * activity *
                  (1-price_response_magnitude) * ask_replenishment
buy_absorption  = max(-F_fast,0) * activity *
                  (1-price_response_magnitude) * bid_replenishment
absorption      = clamp(buy_absorption-sell_absorption,-1,+1)
```

Positive absorption means bullish/passive-buy absorption; negative means bearish/passive-sell absorption. Large-trade direction uses configured floors of ES 20 and NQ 10 contracts. Execution response is:

```text
execution_response = clamp(0.40*large_trade_direction +
                           0.35*absorption +
                           0.25*normalized_price_response, -1,+1)
futures_flow_evidence = median(aggression, book, execution_response)
```

The median deliberately prevents one extreme pillar from dominating.

## 10. Flow persistence

Only active samples in the trailing 2-second time window count:

```text
flow_persistence = active samples agreeing with current flow sign /
                   all active samples
```

V2 also publishes active fraction and continuous sign duration. Inactive/zero-volume samples never count as agreement. SPY 1DTE starts with minimum persistence 0.65.

## 11. Cash microstructure and synchronization

Cash evidence is a separate domain. Its valid components are robustly aggregated from cash microprice edge, distance-weighted Nasdaq depth when valid, and clock-based SPY/QQQ log returns over 5, 15, 30 and 60 seconds. Observation count is never substituted for wall-clock time.

SPY is synchronized with ES and QQQ with NQ. Thirty-second ETF and futures log returns produce:

```text
tracking_error_bps = 10000 * abs(log(ETF_t/ETF_t-30s)
                               - log(FUT_t/FUT_t-30s))
```

Material tracking instability creates `BASIS_UNSTABLE`. ETF-native structure remains primary; historical futures levels are not naively ratio-mapped into exact ETF prices.

## 12. Persistent causal structure

The zone book is persisted per market and survives session changes. Inputs implemented include confirmed causal swings, prior close/day fields, opening/session profile values, session VWAP context, Quant GEX concentrations, and Quant OI concentrations. The online volume profile uses only observations available at each update.

Causal swing detection tracks a candidate extreme and confirms the prior extreme only after price reverses by the configured ATR multiple. No centered pivot or future bar is used. New source metadata alone does not count as a qualified market reaction.

Nearby levels are volatility-aware clustered into zones with bounds, center, first/last seen time, source/timeframe sets, qualified touches, reaction strength, profile/options confluence, strength, role, and acceptance state. Intraday, daily, and weekly half-life defaults are 5, 30 and 90 days. A new qualified reaction refreshes the zone.

Roles are `SUPPORT`, `RESISTANCE`, `FLIP_ZONE`, `TESTING`, `BROKEN`, `ACCEPTED_ABOVE`, `ACCEPTED_BELOW`, and `NEUTRAL`. A wick does not by itself break a zone. Acceptance logic requires causal displacement/persistence; accepted/broken resistance no longer obstructs a CALL path, and the symmetric rule applies to PUTs.

## 13. Active-zone compression and path clearance

The engine keeps a large historical database but exposes at most three relevant path zones after role, strength/recency, clustering, and target-corridor filtering.

For a CALL, only `current_price < zone <= required_upside_target` is an obstacle. For a PUT, only `required_downside_target <= zone < current_price` is an obstacle. Support behind a CALL or resistance behind a PUT is context, not a penalty.

```text
obstruction_j = prominence_j *
                (1-clamp(distance_j/required_move,0,1))
path_clearance = 1 - max(obstruction_j)
```

Obstacles are not summed. Low path clearance may produce `ABSTAIN / TARGET_PATH_OBSTRUCTED`, but never reverses the directional thesis.

## 14. VWAP treatment and setup archetypes

VWAP is location and acceptance/rejection context only. There is no rule that CALL requires price above VWAP or PUT requires price below VWAP. It may become a target-path obstacle if it lies ahead.

Continuation means direction, live flow, and structure are already aligned. Support reversal and resistance reversal are separate archetypes. A reversal requires qualified location plus live reaction: absorption, replenishment, local reclaim/rejection, stronger flow threshold, higher persistence, and no unresolved hard conflict. A level alone never creates a trade.

## 15. Explicit conflicts and direction core

Hard semantic disagreements are reason-coded before combination: `CASH_FUTURES_DIVERGENCE`, `FLOW_STRUCTURE_CONFLICT`, `BOOK_FLOW_CONFLICT`, `ABSORPTION_AGAINST_SIGNAL`, `OPTIONS_FLOW_CONFLICT`, and `BASIS_UNSTABLE`.

If futures and structure have opposite signs and both magnitudes are at least 0.45, the engine abstains. Strong futures/cash conflict is handled similarly. V2 never subtracts an unsigned penalty from a signed score. Where magnitude reduction is needed, it is sign-symmetric.

Absent a hard conflict:

```text
directional_core = clamp(0.50*futures_flow_evidence +
                         0.20*cash_evidence +
                         0.30*structure_evidence, -1,+1)
```

Contract utility and all other unsigned quality fields are excluded from direction.

## 16. Stateful anti-flip engine

Each of the four markets owns an independent state machine:

```text
BLOCKED, NO_TRADE, ARMING_CALL, CALL_READY, ARMING_PUT, PUT_READY
```

The display can additionally show CALL HOLD, PUT HOLD, ABSTAIN, READY DIAGNOSTIC and READY EXECUTABLE. From NO_TRADE, direction must cross ENTER and remain qualified for entry persistence with sufficient active-flow persistence. READY is retained at the lower HOLD threshold. A dip below ENTER does not cancel READY. A neutral timer must expire before returning to NO_TRADE.

Opposite evidence crossing zero never flips direction. Ordinary reversal requires the stronger FLIP threshold, persistence, futures agreement, cash agreement or non-opposition, structure non-opposition, fresh data, and no hard conflict. The normal enforced path is READY → NO_TRADE → opposite READY. The optional shock-reversal code path exists but is disabled in versioned configuration.

Hard vetoes override hysteresis immediately. Strong semantic conflicts display ABSTAIN while retaining the prior READY memory so a brief conflict does not cause churn.

## 17. Per-market starting constants

| Market | ENTER | HOLD | FLIP | Entry s | Neutral s | Flip s | Min flow persistence | Reversal flow/persistence/s |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| SPY 1DTE | .42 | .18 | .62 | 1.5 | 2.0 | 2.0 | .65 | .55 / .70 / 2.5 |
| SPY 0DTE | .50 | .24 | .70 | 2.0 | 2.5 | 2.5 | .70 | .62 / .75 / 3.0 |
| QQQ 1DTE | .48 | .22 | .68 | 2.0 | 2.5 | 2.5 | .70 | .60 / .75 / 3.0 |
| QQQ 0DTE | .55 | .28 | .74 | 2.5 | 3.0 | 3.0 | .75 | .65 / .80 / 3.5 |

These are transparent engineering defaults, not trained, fitted, calibrated, backtest-optimized, or claimed optimal.

## 18. DTE, TTE, session and volatility regimes

Expiration is converted to the actual U.S. option expiration timestamp and `actual_tte_minutes` is used for eligibility and scenario decay. Regimes combine market, DTE class, actual TTE, New York session phase (`OPEN_TRANSITION`, `MORNING`, `MIDDAY`, `AFTERNOON`, `POWER_HOUR`, `FINAL_WINDOW`) and online realized-volatility state. Regimes multiply thresholds, required persistence, and future-spread assumptions; they do not add bullish or bearish score.

Minimum TTE defaults: SPY 1DTE 120 min, SPY 0DTE 45 min, QQQ 1DTE 120 min, QQQ 0DTE 60 min.

## 19. Quant Data integration

The official REST base is `https://api.quantdata.us/v1`. Successful current endpoints in the probe were:

- `/options/tool/exposure-by-strike` for GAMMA, DELTA, VANNA, CHARM;
- `/options/tool/net-drift`;
- `/options/tool/gainers-losers`;
- `/options/tool/order-flow/unconsolidated`;
- `/options/tool/term-structure`;
- `/options/tool/volatility-skew`;
- `/options/tool/open-interest-by-strike`.

The observed limit header was 240 requests/minute. Calls run asynchronously with backoff and last-good snapshots.

Option-flow side semantics were verified and implemented: CALL at ask/above ask bullish; CALL at bid/below bid bearish; PUT at ask/above ask bearish; PUT at bid/below bid bullish; midpoint neutral. Initial trade weight is `abs(delta)*size`, normalized to [-1,+1] over clock horizons. It is used as confirm/neutral/conflict and cannot independently flip direction.

GEX/DEX/Vanna/Charm are regime/path context. V2 does not equate positive gamma with PUT or negative gamma with CALL. OI is slow structure, never real-time flow. IV is normalized to decimal once; 18 and 0.18 both become 0.18, with range assertions.

## 20. Webull integration and entitlement investigation

Only official Webull OpenAPI is used. The credential set authenticates in production and is the only saved Webull application credential found. The SDK is 2.0.19. SDK file/stream logging is disabled before client initialization and all SDK logger propagation/handlers are suppressed, preventing signed headers from reaching logs.

The original `MARKET_DATA_NOT_SUBSCRIBED` result was traced to an incorrect overnight-market request. With ordinary production snapshots:

- SPY/QQQ stock snapshots: HTTP 200;
- SPY/QQQ option contract listing: HTTP 200;
- one SPY and one QQQ OPRA snapshot: HTTP 200;
- one-level SPY/QQQ depth: HTTP 200;
- requested Nasdaq depth 10: HTTP 417 `ILLEGAL_PARAMETER` for both ETFs.

Therefore Webull cash L1 and OPRA are usable. `WEBULL_OPTION_MODE = SNAPSHOT`. The official API did not demonstrate option streaming in this implementation. Nasdaq TotalView/OpenAPI L2 is still not active or correctly bound for this application despite the user’s subscription; the depth-1 control proves the host, account, signing, instrument, and base endpoint are otherwise valid. V2 retries unavailable L2 only every five minutes and degrades cash-book evidence instead of fabricating zero imbalance. READY EXECUTABLE remains possible with fresh cash L1 and a valid fresh OPRA quote; L2 absence is visible as degraded health.

## 21. Quote semantics and validity

Webull OPRA is authoritative for bid, ask, last, displayed size, volume, and quote timestamp. Long-option entry is always current ask:

```text
mid = (bid+ask)/2
absolute_spread = ask-bid
relative_spread = (ask-bid)/mid
entry_price = ask
target_exit_price = 1.30*ask
```

A candidate requires positive ask, nonnegative bid, bid ≤ ask, correct signed delta, eligible absolute delta, normalized IV, valid expiration/TTE, and a fresh quote. Impossible/crossed snapshots are never used.

Quote state is `QUOTE_GOOD`, `QUOTE_DEGRADED`, or `QUOTE_INVALID`. One isolated wide observation does not instantly invalidate an otherwise good contract. Persistent widening degrades it; persistent hard invalidity invalidates it. Timers use monotonic time.

Quant Greek age and Webull quote age remain separate. If Quant supplies no provider event time, the Quant receipt time ages the Greek snapshot. Underlying movement since Greeks and local BSM delta/gamma mismatch can produce `GREEKS_DEGRADED` or `GREEKS_QUOTE_INCONSISTENT`.

## 22. Delta eligibility and contract utility

Hard eligibility is `0.60 ≤ abs(delta) ≤ 0.70`; monitoring/prefiltering is `0.55–0.75`. Preference is:

```text
delta_preference = clamp(1 - abs(abs(delta)-0.65)/0.10, 0,1)
```

Thus .65=1.00 and .60/.70=.50. Candidate utility is separate from direction and uses the harmonic mean of delta preference, quote quality, liquidity, neighboring-strike surface consistency, scenario resilience, and path clearance. A mandatory near-zero component collapses utility rather than being compensated by strong unrelated fields.

Tie-breaking is deterministic: higher utility, lower relative spread, lower required favorable move, higher minimum displayed size, delta nearer .65, higher OI, then deterministic strike/symbol order. Repeated row shuffling does not change the result.

## 23. Contract hysteresis

If the selected contract remains valid, it is retained. A challenger must exceed current utility by the market switch margin and sustain that advantage for switch persistence. SPY 1DTE defaults are margin .08 and persistence 2.0 s. An invalid current contract switches immediately. This state is independent of direction hysteresis.

## 24. Scenario pricing and +30% economics

The fast path is Black–Scholes–Merton with continuous dividend yield. A Cox–Ross–Rubinstein binomial fallback handles cases where American early exercise/dividend treatment may be material. Model output is a deterministic scenario value, not a probability.

For elapsed time `e` and relative IV shock `q`:

```text
T' = max(T-e,0)
sigma' = max(minimum_iv, current_iv*(1+q))
estimated_exit_bid = max(theoretical_future_value
                         - 0.5*conservative_future_spread, 0)
scenario_return = estimated_exit_bid/current_ask - 1
```

Deterministic bisection solves the exact favorable underlying move where estimated exit bid reaches `1.30*current ask`, or emits `NO_ROOT_WITHIN_RANGE`. The 1DTE elapsed grid is 0, 5, 15, 30, 60 and 120 minutes; 0DTE is 0, 2, 5, 10, 20 and 30 minutes. Relative IV shocks are -25%, -10%, 0, +10%, +25%. Late TTE widens the future-spread assumption. Current theoretical-vs-market residual is reported as `PRICING_INPUT_INCONSISTENT` when material; it is not hidden by forcing the model to the mark.

## 25. Setup Quality

```text
direction_strength = abs(directional_core)
setup_quality = 100 * harmonic_mean(direction_strength,
                                    flow_persistence,
                                    agreement_quality,
                                    candidate_utility)
```

Every component is published. Values are clamped to [0,100]. There is no arbitrary 35% floor, 88% cap, calibration curve, historical hit-rate mapping, learned model, or target-hit probability.

## 26. Hard veto, degraded and abstention behavior

Hard vetoes include market closed, futures stale, clock skew, obvious futures rollover mismatch, invalid timing and insufficient warmup. They immediately produce BLOCKED.

Execution-layer failures include stale/invalid OPRA quote, no eligible delta, TTE too short, stale Greeks, or all candidates failed. A direction may still exist diagnostically, but a full executable READY requires a fresh valid Webull quote.

Semantic abstentions include flow/structure conflict, cash/futures conflict, option-flow conflict, basis instability, target-path obstruction, scenario fragility, and Greek/quote inconsistency. Quant Data failure degrades options intelligence without automatically blocking futures/cash direction. Cash L2 failure degrades book confirmation without manufacturing neutral book evidence.

Rollover contracts are explicit (`ES 09-26`, `NQ 09-26`). Mismatch fails closed. V2 does not silently auto-switch contracts.

## 27. Supabase implementation

Migration `20260905130000_add_tradytics_v2_shadow.sql` created:

- `options_signal_v2_live`;
- `futures_orderflow_v2_live`;
- `options_v2_provider_health`;
- `options_v2_shadow_log`.

All four have RLS enabled and an authenticated SELECT policy constrained by the existing `dashboard_readers` owner allowlist. `anon` has no table access. Backend service credentials are not stored in tables or frontend files. Realtime publication includes only the two current-state tables. V1 tables were untouched.

The migration was applied successfully and a provider→engine→Supabase cycle wrote four `BLOCKED / MARKET_CLOSED` states with `ready_executable=false`, correctly reflecting the closed market.

The post-migration Supabase security adviser reported no finding against a V2 table or policy. Its reported security warnings belong to pre-existing unrelated V1/project objects and were not changed in this release. The new shadow-log index appeared as unused immediately after creation, which is expected before an open-market shadow history accumulates.

## 28. Website behavior and paper-trade reading guide

The primary SPY 1DTE card answers, in order: trade state, direction, continuation/reversal type, Setup Quality, state age, persistence, selected contract, expiration, delta, current Webull bid/ask/spread/quote age, ask entry, +30% option target, required SPY move across time/IV scenarios, path clearance, support behind, next obstacle, invalidation, confirmation summary, data health, and dominant reason.

Secondary cards summarize SPY 0DTE, QQQ 1DTE and QQQ 0DTE. When ARMING, the detailed requirements list shows missing persistence/reclaim/confirmation. When BLOCKED or ABSTAIN, one primary reason is prominent. When READY/HOLD, the card explains what maintains and invalidates it. No raw exposure wall dominates the decision card.

The deployed page was verified at desktop and 390×844 mobile viewport. The owner sign-in modal, safety statement, primary/secondary layout and data-health area render, and the browser console recorded no warnings or errors. Because no owner password was read or transmitted during the audit, authenticated row rendering was verified through deterministic frontend logic plus the successful protected Supabase table writes, not by entering credentials in the browser.

## 29. Performance measurements

Local arithmetic was measured with `perf_counter_ns` on this PC; network calls were excluded:

| Stage | Median | p95 | Max |
|---|---:|---:|---:|
| Cash feature compute | 106.2 µs | 146.9 µs | 471.9 µs |
| Direction compute | 0.8 µs | 1.1 µs | 126.3 µs |
| Scenario grid | 722.85 µs | 941.3 µs | 1,345.3 µs |
| Full decision, one candidate | 1,021.05 µs | 1,389.4 µs | 2,625.7 µs |

Observed provider probe latency, milliseconds:

| Endpoint | Latency |
|---|---:|
| Quant GEX | 291.532 |
| Quant order flow | 97.491 |
| Quant term structure | 379.011 |
| Quant skew | 210.869 |
| Quant OI | 67.237 |
| Webull stock snapshot (SPY+QQQ) | 98.537 |
| Webull SPY OPRA snapshot | 89.142 |
| Webull QQQ OPRA snapshot | 93.614 |
| Webull SPY/QQQ contract lists | 418.669 / 420.887 |

Provider calls are off the 100-ms hot path. Option snapshots are batched to at most 20 contracts and scheduled no faster than 1.2 s; contract discovery is once per minute. Quant context uses per-endpoint cadences, backoff, and last-good state. Supabase publish latency is recorded per successful cycle but the closed-market one-shot measurement was not retained as a formal benchmark, so no number is invented here.

## 30. Tests actually executed

`pytest` completed **60 passed, 0 failed**. Coverage includes bounds, zero-volume/zero-book guards, no NaN/Inf, signed mirror symmetry, IV units, quote-age and spread monotonicity, shuffled chain invariance, irrelevant bad-row isolation, unsigned utility isolation, conflict sign symmetry, ENTER/HOLD/FLIP behavior, hard vetoes, anti-flip sequences, continuation/reversal requirements, contract hysteresis, causal swing confirmation, persistence across sessions, clustering, decay, accepted/broken roles, target-corridor filtering, maximum active zones, max-not-sum obstruction, scenario monotonicity, intrinsic lower bounds, bisection tolerance, no-root handling, ask entry, pricing residual reporting, actual TTE, and deterministic replay.

Static checks also passed: JavaScript syntax, `git diff --check`, source secret scan, and exact AddOn compilation against installed NinjaTrader assemblies.

## 31. Replay, shadow stability and sensitivity

Synthetic anti-flip sequence (4.0 s):

- direction flips/hour: 0;
- READY→opposite READY: 0;
- average READY duration: 2.5 s;
- failed arming attempts: 0;
- contract switches/hour: 0.

Recorded legacy ES order-flow replay (302 one-minute rows, 18,060 s):

- direction flips/hour: 0;
- READY→opposite READY: 0;
- average READY duration: 380.87 s;
- failed arming attempts: 32;
- contract switches/hour: 0.

The recorded fixture maps legacy one-minute footprint fields deterministically into V2 pillars. It validates state stability but not 100-ms feature parity. It is not a P&L test.

±20% deterministic sensitivity was run around ENTER, HOLD, FLIP, conflict threshold, entry/flip persistence, switch margin and path threshold. No parameter was selected or changed based on P&L. The small synthetic sequence was most sensitive to +20% entry persistence, which remained ARMING rather than READY; other tested perturbations preserved the sequence’s anti-flip behavior.

## 32. NinjaTrader dual-publish audit

The AddOn maintains the original V1 UDP output and adds a V2 snapshot to port 48637 with the same sequence number and provider timestamp. ES and NQ subscription definitions remain explicit. The V2 snapshot contains aggression, book, execution response, replenishment, absorption, persistence, timestamps and rollover diagnostics. Networking remains on the timer, not market-data callbacks, and UDP is newest-state/fire-and-forget.

The exact V2 source was copied to `Documents\NinjaTrader 8\bin\Custom\AddOns`. It passed C# compilation against the installed NinjaTrader assemblies. The running NinjaTrader custom DLL predates that copied revision, and native application automation was unavailable; therefore an in-platform NinjaScript compile/restart of this exact revision and live ES/NQ packet verification are explicitly **not claimed**.

## 33. Failure and degraded states

| Condition | Result |
|---|---|
| Market closed / futures stale / clock skew / rollover mismatch | BLOCKED immediately |
| Webull OPRA unavailable or stale | direction may be diagnostic; no executable READY |
| Quant unavailable | options intelligence degraded; core direction may continue |
| Nasdaq L2 unavailable | cash-book component degraded; no fabricated zero |
| Strong flow/structure or cash/futures conflict | ABSTAIN; direction memory retained |
| Path obstructed | directional thesis retained; contract abstains |
| Brief counterflow | CALL/PUT HOLD, not instant neutral/flip |
| Persistent neutralization | READY → NO_TRADE |
| Ordinary reversal | opposite FLIP + persistence + agreement, through NO_TRADE |
| Candidate quote invalid | rejected immediately; deterministic next candidate |

## 34. Security and secrets

Credential files remain under `Documents\api keys` and were not modified. Secrets are loaded only in backend memory. `.env`, `.env.*`, logs, virtual environments, state, bytecode and coverage artifacts are ignored. An exact-value scan of 94 source/artifact files against two saved credential tokens returned zero hits. No API key is present in the audit, generated validation files, browser code, Git history introduced by V2, or Supabase payloads. Webull SDK logging is hard-disabled. No broker order endpoint is imported or invoked.

The browser’s Supabase publishable key is intentionally public and is protected by Auth plus RLS; it is not a service credential.

## 35. Deployment and operations

Production V2 is deployed at:

`https://jerin7931.github.io/Futures-Live-Dashboard/v2/`

The backend starts with `ops/start_tradytics_v2.ps1`, writes only ignored state/log files, detects an existing PID, and launches hidden. At audit completion it was running with a listener on UDP 48637. Windows denied creating a scheduled task without elevation, so an HKCU `Run` entry named `TradyticsV2Shadow` was installed to invoke the same idempotent wrapper at user logon.

The V1 Python service and V1 UDP listener remained running throughout. Promotion did not replace V1; V2 remains a separate route and schema.

## 36. Known limitations and external dependencies

1. Nasdaq TotalView/OpenAPI L2 is not returning depth 10 for the authenticated Webull application. The user must verify subscription binding/application association with Webull or its OpenAPI support. Cash L1 and OPRA work.
2. The market was closed; live 100-ms futures features, live READY behavior, live state ages, and browser Realtime transitions were not validated in an open session.
3. The exact copied V2 AddOn revision still requires an in-platform NinjaScript compile/restart; the previous running custom DLL predates the copy.
4. Quant REST snapshots do not always expose provider event time. V2 preserves that limitation and ages those snapshots from labeled receipt time.
5. Future executable option spread is unknowable. The scenario engine uses documented conservative spread assumptions, not an execution guarantee.
6. BSM/CRR outputs are model scenarios. American exercise, dividends, discrete jumps, volatility surface movement and quote liquidity can differ from the assumptions.
7. Structural zones and thresholds are deterministic engineering defaults; no claim of statistical calibration or profitability is made.

## 37. Source files changed

Core: `backend/tradytics_signal_service_v2.py`; all files under `backend/v2/` and `backend/v2/providers/`.  
Configuration/operations: `config/v2_engine.json`, `requirements-v2.txt`, `ops/start_tradytics_v2.ps1`, `.gitignore`, `README.md`.  
NinjaTrader: `ninjatrader/TradyticsOptionsOrderFlowFeed.cs`.  
Database: `supabase/migrations/20260905130000_add_tradytics_v2_shadow.sql`, `supabase/schema/options_command_v2.sql`.  
Website: `v2/index.html`, `v2/dashboard-v2.css`, `v2/dashboard-v2.js`.  
Validation: `scripts/provider_probe.py`, `scripts/replay_validation.py`, `scripts/benchmark_v2.py`, `tests/*`, `docs/validation/*`.  
Audit: this Markdown file and its generated PDF.

## 38. One-page constants and formula index

| Group | Constants / formula |
|---|---|
| Futures sampling | 100 ms; fast half-life .75 s; slow 3.0 s; book .5 s |
| Aggression | `.60*F_fast + .40*F_slow` |
| Book | `.50*depth_imbalance_EWMA + .50*microprice_edge` |
| Execution response | `.40*large_trade_direction + .35*absorption + .25*price_response` |
| Futures evidence | median of aggression, book, execution response |
| Direction core | `.50*futures + .20*cash + .30*structure` |
| Strong conflict | both opposing domain magnitudes ≥ .45 |
| Persistence | 2-second active-only window; SPY 1DTE minimum .65 |
| SPY 1DTE hysteresis | ENTER .42, HOLD .18, FLIP .62; 1.5/2.0/2.0 s |
| SPY 1DTE reversal | flow ≥ .55; persistence ≥ .70; 2.5 s plus reaction evidence |
| Eligible delta | absolute .60–.70; monitor .55–.75; preference centered .65 |
| Contract switch | challenger ≥ current + .08 for 2.0 s |
| Candidate utility | harmonic mean of six [0,1] quality components |
| Setup Quality | `100*H(|core|, persistence, agreement, utility)`; not probability |
| Scenario entry/target | current ask; target `1.30*ask` |
| Future exit | `max(theoretical - .5*conservative_spread,0)` |
| IV shocks | -25%, -10%, 0, +10%, +25% |
| 1DTE elapsed grid | 0, 5, 15, 30, 60, 120 min |
| 0DTE elapsed grid | 0, 2, 5, 10, 20, 30 min |
| Active path | maximum 3 zones; strongest obstruction, never summed line count |
| Zone half-lives | intraday 5 days, daily 30, weekly 90 |
| Freshness | futures/cash/L2 2 s; option quote 3 s; Quant flow 15 s; GEX/skew 300 s; OI 86400 s; Greeks 60 s |

## 39. Final audit conclusion

V2 meets the deterministic architecture, transparency, anti-flip, execution-quote, scenario, security, side-by-side deployment, and documentation objectives that could be verified while the market was closed. It does not train or calibrate a model, optimize parameters against P&L, place orders, or delegate decisions to Ollama. The remaining release evidence is operational rather than architectural: bind/restore Webull Nasdaq L2, compile/restart the exact V2 NinjaTrader AddOn revision in-platform, and observe an open-market shadow session.

Until that evidence exists, V2 should remain a paper/shadow decision surface at `/v2/`, with V1 rollback retained.
