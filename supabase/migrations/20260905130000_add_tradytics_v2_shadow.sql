-- Tradytics deterministic V2 shadow namespace. V1 tables are intentionally untouched.

create table if not exists public.options_signal_v2_live (
    market_key text primary key check (market_key in ('SPY_1DTE','SPY_0DTE','QQQ_1DTE','QQQ_0DTE')),
    symbol text not null check (symbol in ('SPY','QQQ')),
    dte smallint not null check (dte in (0,1)),
    state text not null check (state in ('BLOCKED','NO_TRADE','ARMING_CALL','CALL_READY','ARMING_PUT','PUT_READY')),
    display_state text not null check (display_state in ('NO TRADE','ARMING CALL','CALL READY','CALL HOLD','ARMING PUT','PUT READY','PUT HOLD','ABSTAIN','BLOCKED','READY DIAGNOSTIC','READY EXECUTABLE')),
    direction text not null check (direction in ('CALL','PUT','NONE')),
    setup_type text not null check (setup_type in ('CONTINUATION','SUPPORT_REVERSAL','RESISTANCE_REVERSAL')),
    setup_quality double precision not null check (setup_quality between 0 and 100),
    primary_reason text not null,
    ready_executable boolean not null default false,
    payload jsonb not null default '{}'::jsonb,
    as_of timestamptz not null,
    updated_at timestamptz not null default now()
);

create table if not exists public.futures_orderflow_v2_live (
    symbol text primary key check (symbol in ('ES','NQ')),
    contract text not null,
    provider_event_time timestamptz not null,
    sequence bigint not null check (sequence >= 0),
    payload jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now()
);

create table if not exists public.options_v2_provider_health (
    provider text primary key,
    status text not null,
    payload jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now()
);

create table if not exists public.options_v2_shadow_log (
    id bigint generated always as identity primary key,
    market_key text not null check (market_key in ('SPY_1DTE','SPY_0DTE','QQQ_1DTE','QQQ_0DTE')),
    v1_state text,
    v2_state text not null,
    v2_display_state text not null,
    direction text not null,
    setup_type text not null,
    reason_codes jsonb not null default '[]'::jsonb,
    selected_contract text,
    webull_status text not null,
    quantdata_status text not null,
    path_clearance double precision check (path_clearance between 0 and 1),
    shadow_metrics jsonb not null default '{}'::jsonb,
    as_of timestamptz not null
);

create index if not exists options_v2_shadow_log_market_time_idx
    on public.options_v2_shadow_log (market_key, as_of desc);

alter table public.options_signal_v2_live enable row level security;
alter table public.futures_orderflow_v2_live enable row level security;
alter table public.options_v2_provider_health enable row level security;
alter table public.options_v2_shadow_log enable row level security;

drop policy if exists options_v2_owner_read on public.options_signal_v2_live;
create policy options_v2_owner_read on public.options_signal_v2_live
    for select to authenticated
    using ((select auth.uid()) in (select user_id from public.dashboard_readers));

drop policy if exists options_v2_owner_read on public.futures_orderflow_v2_live;
create policy options_v2_owner_read on public.futures_orderflow_v2_live
    for select to authenticated
    using ((select auth.uid()) in (select user_id from public.dashboard_readers));

drop policy if exists options_v2_owner_read on public.options_v2_provider_health;
create policy options_v2_owner_read on public.options_v2_provider_health
    for select to authenticated
    using ((select auth.uid()) in (select user_id from public.dashboard_readers));

drop policy if exists options_v2_owner_read on public.options_v2_shadow_log;
create policy options_v2_owner_read on public.options_v2_shadow_log
    for select to authenticated
    using ((select auth.uid()) in (select user_id from public.dashboard_readers));

revoke all on public.options_signal_v2_live from anon, authenticated;
revoke all on public.futures_orderflow_v2_live from anon, authenticated;
revoke all on public.options_v2_provider_health from anon, authenticated;
revoke all on public.options_v2_shadow_log from anon, authenticated;
grant select on public.options_signal_v2_live to authenticated;
grant select on public.futures_orderflow_v2_live to authenticated;
grant select on public.options_v2_provider_health to authenticated;
grant select on public.options_v2_shadow_log to authenticated;

do $$
begin
    if not exists (
        select 1 from pg_publication_tables
        where pubname='supabase_realtime' and schemaname='public' and tablename='options_signal_v2_live'
    ) then
        alter publication supabase_realtime add table public.options_signal_v2_live;
    end if;
    if not exists (
        select 1 from pg_publication_tables
        where pubname='supabase_realtime' and schemaname='public' and tablename='futures_orderflow_v2_live'
    ) then
        alter publication supabase_realtime add table public.futures_orderflow_v2_live;
    end if;
end
$$;

comment on table public.options_signal_v2_live is
    'Owner-only deterministic V2 paper/shadow state. Setup quality is not a probability.';
comment on table public.futures_orderflow_v2_live is
    'Latest V2 NinjaTrader ES/NQ feature snapshots; V1 feed remains separate.';
comment on table public.options_v2_shadow_log is
    'State-transition diagnostics for stability validation, never broker instructions.';
