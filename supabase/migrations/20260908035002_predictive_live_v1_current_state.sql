-- Proposed-only Predictive Live V1 namespace. Do not apply before pre-commit approval.
-- Existing V1/V2 tables and policies are intentionally untouched.

create table if not exists public.predictive_model_state_live (
    model_id text primary key check (model_id in (
        'SPY_OPTIONS_ONLY','SPY_OPTIONS_PLUS_ES','QQQ_OPTIONS_ONLY','QQQ_OPTIONS_PLUS_NQ'
    )),
    symbol text not null check (symbol in ('SPY','QQQ')),
    state text not null check (state in ('LIVE','HOLD','WARNING','INVALIDATED','STALE','BLOCKED')),
    guidance_state text not null check (guidance_state in ('LIVE','STALE','BLOCKED')),
    thesis_state text not null check (thesis_state in ('LIVE','HOLD','WARNING','INVALIDATED')),
    setup_episode_id text,
    direction text not null check (direction in ('CALL','PUT','NO SETUP')),
    model_version text not null,
    payload jsonb not null default '{}'::jsonb,
    model_event_time timestamptz,
    updated_at timestamptz not null default now()
);

create table if not exists public.predictive_market_context_live (
    symbol text primary key check (symbol in ('SPY','QQQ')),
    gamma_regime text not null,
    market_condition text not null,
    payload jsonb not null default '{}'::jsonb,
    as_of timestamptz not null,
    updated_at timestamptz not null default now()
);

create table if not exists public.predictive_gex_surface_live (
    symbol text not null check (symbol in ('SPY','QQQ')),
    surface_kind text not null check (surface_kind in ('CURRENT','INTRADAY_DELTA')),
    scope text not null,
    payload jsonb not null default '{}'::jsonb,
    as_of timestamptz not null,
    updated_at timestamptz not null default now(),
    primary key (symbol, surface_kind, scope)
);

create table if not exists public.predictive_option_ladder_live (
    contract_key text primary key,
    symbol text not null check (symbol in ('SPY','QQQ')),
    expiration date not null,
    strike double precision not null,
    contract_type text not null check (contract_type in ('CALL','PUT')),
    payload jsonb not null default '{}'::jsonb,
    quote_time timestamptz,
    active boolean not null default true,
    updated_at timestamptz not null default now()
);

create index if not exists predictive_option_ladder_symbol_expiration_strike_idx
    on public.predictive_option_ladder_live (symbol, expiration, strike, contract_type);

create table if not exists public.predictive_provider_health_live (
    provider text primary key check (provider in (
        'QUANT_DATA','QUANT_CONTEXT','WEBULL','NINJATRADER_ES','NINJATRADER_NQ',
        'V2_STRUCTURE_SPY','V2_STRUCTURE_QQQ','SUPABASE','MODEL_ARTIFACTS'
    )),
    status text not null check (status in ('LIVE','STALE','DEGRADED','UNAVAILABLE','VERIFIED')),
    age_ms double precision check (age_ms is null or age_ms >= 0),
    payload jsonb not null default '{}'::jsonb,
    as_of timestamptz not null,
    updated_at timestamptz not null default now()
);

alter table public.predictive_model_state_live enable row level security;
alter table public.predictive_market_context_live enable row level security;
alter table public.predictive_gex_surface_live enable row level security;
alter table public.predictive_option_ladder_live enable row level security;
alter table public.predictive_provider_health_live enable row level security;

do $$
declare
    table_name text;
begin
    foreach table_name in array array[
        'predictive_model_state_live', 'predictive_market_context_live',
        'predictive_gex_surface_live', 'predictive_option_ladder_live',
        'predictive_provider_health_live'
    ] loop
        execute format('drop policy if exists predictive_owner_read on public.%I', table_name);
        execute format(
            'create policy predictive_owner_read on public.%I for select to authenticated using ((select auth.uid()) in (select user_id from public.dashboard_readers))',
            table_name
        );
        execute format('revoke all on public.%I from anon, authenticated', table_name);
        execute format('grant select on public.%I to authenticated', table_name);
        if not exists (
            select 1 from pg_publication_tables
            where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = table_name
        ) then
            execute format('alter publication supabase_realtime add table public.%I', table_name);
        end if;
    end loop;
end
$$;

comment on table public.predictive_model_state_live is
    'Owner-only current predictive decision state; research probabilities are Silver proxy probabilities, never orders.';
comment on table public.predictive_gex_surface_live is
    'Current signed GEX and same-session RTH-open delta GEX for website transport only.';
comment on table public.predictive_option_ladder_live is
    'Current Webull/Quant option ladder display state; high-volume history remains local.';
