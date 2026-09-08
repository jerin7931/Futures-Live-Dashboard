# Tradytics Predictive Live Production V1 - PRE-COMMIT V4 Audit

Prepared: 2026-09-08 UTC  
Repository base: `d5290dc947513c55229540566e19426045e82ac2`  
Working branch: `predictive-live-dashboard-v1`  
Review state: uncommitted, unstaged, not deployed

## 1. Scope and disposition

This is the final narrow provider-health contract correction requested after PRE-COMMIT V3. The reviewed V3 runtime, frozen model artifacts, feature parity, thesis logic, website design, GEX, option ladder, latency behavior, and model mathematics are unchanged.

The only functional correction is alignment of the provider identifiers accepted by the proposed Supabase table with the identifiers already produced and displayed by the live system. The migration remains proposed-only.

**PRODUCTION MODEL PARAMETERS DO NOT UPDATE FROM FORWARD DATA.**

## 2. One versioned provider-health contract

`PREDICTIVE_PROVIDER_HEALTH_V1` is now explicitly documented in `config/predictive_live/provider_health_contract_v1.json`. Its complete and closed identifier set is:

| Provider ID | Responsibility |
|---|---|
| `QUANT_DATA` | Live approved option-print tape and model-event source |
| `QUANT_CONTEXT` | Slower Quant context refreshes |
| `WEBULL` | Current cash and OPRA quote/reference layer |
| `NINJATRADER_ES` | ES futures dependency for SPY + ES |
| `NINJATRADER_NQ` | NQ futures dependency for QQQ + NQ |
| `V2_STRUCTURE_SPY` | Read-only trusted deterministic SPY structure |
| `V2_STRUCTURE_QQQ` | Read-only trusted deterministic QQQ structure |
| `SUPABASE` | Current-state transport connectivity |
| `MODEL_ARTIFACTS` | Startup SHA256 verification state |

The backend loads this versioned file once and fails closed if code attempts to publish an identifier outside the contract. The backend current-state publisher applies the same allowlist before building a database row. The browser health drawer uses one local `providerHealthIds` list for both demo initialization and rendering.

## 3. Corrected proposed Supabase migration

The `predictive_provider_health_live.provider` CHECK now permits exactly the nine contract identifiers. In particular, it now includes the three previously omitted legitimate rows:

- `QUANT_CONTEXT`
- `V2_STRUCTURE_SPY`
- `V2_STRUCTURE_QQQ`

The migration filename and all unrelated table, RLS, owner-read, Realtime, and grant definitions are unchanged. The migration has not been applied to any Supabase environment. Current Supabase breaking-change guidance and database constraint documentation were checked before this proposed-only edit; no relevant syntax change applies to this explicit Postgres CHECK.

## 4. Mechanical alignment and transport tests

The new contract regression parses and compares four independently executable representations:

1. the versioned JSON contract;
2. the backend-loaded provider tuple;
3. the frontend `providerHealthIds` array;
4. the provider values in the proposed migration CHECK.

All four must equal the exact nine-provider set. The test cannot pass merely because each file happens to contain a provider name somewhere else.

A second regression sends representative `QUANT_CONTEXT`, `V2_STRUCTURE_SPY`, and `V2_STRUCTURE_QQQ` health payloads through `PredictiveCurrentStatePublisher`. It verifies the provider identity, fixed table shape, and complete nested payload for every row.

Targeted result: **2 passed, 61 deselected**.  
Complete repository result: **123 passed, 0 failed**.  
Python compile, JavaScript syntax, PowerShell syntax, and frozen-artifact startup verification also pass.

## 5. Unchanged latency and frozen artifacts

V4 changes only a startup-loaded identifier contract, publisher validation, a frontend constant, the proposed CHECK, and tests. No option event ingestion, feature update, inference, model decision, contract selection, invalidation, or queue algorithm changed. The V3 four-model full-path latency evidence therefore remains applicable and was not rerun solely to manufacture duplicate evidence.

Startup verify-only confirms the unchanged registry SHA256 `048c04e7ed9b147d592797f2ab171e3a95b62ac684e7dd38b19a6906f7a973d2` and all four frozen models with zero predictions performed.

## 6. Files changed for V4

The functional V4 delta is limited to:

- `config/predictive_live/provider_health_contract_v1.json`
- `backend/predictive_live/provider_health.py`
- `backend/predictive_live/service.py`
- `backend/predictive_live/supabase_publish.py`
- `predictive/predictive.js`
- `supabase/migrations/20260908035002_predictive_live_v1_current_state.sql`
- `tests/test_predictive_live.py`
- V4 verification, audit, PDF, and package-builder files

The review ZIP mechanically enumerates and copies the complete current working-tree implementation. It includes the corrected proposed migration, full binary-capable diff, Git status and base commit, test outputs, audit files, and a SHA256 inventory.

## 7. Security and deployment state

At package creation:

- implementation changes are uncommitted and unstaged;
- no push exists;
- the proposed Supabase migration is unapplied;
- `/predictive/` is not deployed;
- the NinjaTrader add-on is not installed;
- startup persistence is unchanged;
- the predictive production service is stopped;
- no broker or order action exists or was performed.

The package secret scan rejects credential-shaped Quant keys, private keys, JWTs, AWS keys, and service-role/secret values. Browser configuration contains no backend service-role key.

## 8. Post-approval sequence

Only after explicit `PRODUCTION PRE-COMMIT APPROVED` may the reviewed implementation be committed and pushed, the namespaced migration applied, the reviewed Level-1 feed installed, verify-only startup repeated, the service started, non-trading health checks performed, and `/predictive/` deployed.

The V3 rollback plan remains unchanged: stop only the new predictive process, remove only its later-approved startup entry, and revert the predictive implementation/route. Existing V1, deterministic V2, and their Supabase objects remain untouched.

## 9. Review conclusion

The backend publisher set, frontend health set, and proposed Supabase CHECK now share the same explicit nine-provider contract. The exact source and verification evidence are ready for independent review. No production action has been taken.
