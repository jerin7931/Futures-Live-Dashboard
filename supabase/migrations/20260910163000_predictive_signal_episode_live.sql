-- Additive 1DTE signal-row lifecycle for the Options Dashboard.
-- Existing predictive current-state tables remain unchanged.

create table if not exists public.predictive_signal_episode_live (
    id text primary key,
    signal_key text not null unique,
    model_id text not null check (model_id in (
        'SPY_OPTIONS_ONLY','SPY_OPTIONS_PLUS_ES','QQQ_OPTIONS_ONLY','QQQ_OPTIONS_PLUS_NQ'
    )),
    model_setup_episode_id text,
    symbol text not null check (symbol in ('SPY','QQQ')),
    side text not null check (side in ('CALL','PUT')),
    expiry date not null,
    strike double precision not null,
    dte_class text not null check (dte_class = '1DTE'),
    contract text not null,
    delta_at_entry double precision,
    entry_ask double precision not null check (entry_ask > 0),
    latest_bid double precision check (latest_bid is null or latest_bid >= 0),
    latest_ask double precision check (latest_ask is null or latest_ask > 0),
    current_return double precision,
    model_strength_p30_30 double precision not null check (
        model_strength_p30_30 >= 0 and model_strength_p30_30 <= 1
    ),
    setup_grade text not null check (setup_grade in ('A','B','C')),
    status text not null check (status in ('TRACKING','INVALIDATED','TARGET_HIT','EXPIRED')),
    active boolean not null default true,
    created_at timestamptz not null,
    updated_at timestamptz not null default now(),
    expires_at timestamptz not null,
    terminal_at timestamptz,
    invalidation_reason_code text,
    invalidation_reason_text text,
    model_event_time timestamptz,
    latest_quote_time timestamptz,
    source_timestamps jsonb not null default '{}'::jsonb,
    details_payload jsonb not null default '{}'::jsonb,
    check ((status = 'TRACKING' and active) or (status <> 'TRACKING' and not active))
);

create index if not exists predictive_signal_episode_model_status_created_idx
    on public.predictive_signal_episode_live (model_id, status, created_at desc);

create index if not exists predictive_signal_episode_contract_active_idx
    on public.predictive_signal_episode_live (contract, active)
    where active;

alter table public.predictive_signal_episode_live enable row level security;

drop policy if exists predictive_owner_read on public.predictive_signal_episode_live;
create policy predictive_owner_read
    on public.predictive_signal_episode_live
    for select
    to authenticated
    using ((select auth.uid()) in (select user_id from public.dashboard_readers));

revoke all on public.predictive_signal_episode_live from anon, authenticated;
grant select on public.predictive_signal_episode_live to authenticated;

do $$
begin
    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'predictive_signal_episode_live'
    ) then
        alter publication supabase_realtime add table public.predictive_signal_episode_live;
    end if;
end
$$;

comment on table public.predictive_signal_episode_live is
    'Owner-only 1DTE signal episodes. Deterministic identity is model + symbol + expiry + strike + side; updates never replace other contracts.';

comment on column public.predictive_signal_episode_live.details_payload is
    'Frozen Direct-MFE surfaces, Aim For values, and signal-specific display/audit details; not broker instructions.';
