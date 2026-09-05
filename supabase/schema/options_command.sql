-- Options Command live state for FuturesDashboard.
-- Applied through the connected Supabase project after review; kept here as the
-- canonical, idempotent schema definition because the Supabase CLI is not installed.

create table if not exists public.futures_orderflow_live (
    symbol text primary key check (symbol in ('ES', 'NQ')),
    contract text not null,
    event_time timestamptz not null,
    bid numeric,
    ask numeric,
    last numeric,
    bid_size bigint not null default 0 check (bid_size >= 0),
    ask_size bigint not null default 0 check (ask_size >= 0),
    trade_count_1s integer not null default 0 check (trade_count_1s >= 0),
    volume_1s bigint not null default 0 check (volume_1s >= 0),
    buy_volume_1s bigint not null default 0 check (buy_volume_1s >= 0),
    sell_volume_1s bigint not null default 0 check (sell_volume_1s >= 0),
    delta_1s bigint not null default 0,
    delta_5s bigint not null default 0,
    cumulative_delta bigint not null default 0,
    book_bid_volume bigint not null default 0 check (book_bid_volume >= 0),
    book_ask_volume bigint not null default 0 check (book_ask_volume >= 0),
    book_imbalance double precision not null default 0 check (book_imbalance between -1 and 1),
    microprice numeric,
    spread_ticks double precision,
    session_vwap numeric,
    absorption_side text not null default 'NONE' check (absorption_side in ('BUY', 'SELL', 'NONE')),
    absorption_score double precision not null default 0 check (absorption_score between 0 and 1),
    flow_score double precision not null default 0 check (flow_score between -1 and 1),
    large_trade_count_1s integer not null default 0 check (large_trade_count_1s >= 0),
    source text not null default 'NINJATRADER_OPTIONS_ORDERFLOW',
    latency jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now()
);

create table if not exists public.options_chain_live (
    symbol text not null check (symbol in ('SPY', 'QQQ')),
    expiration date not null,
    dte smallint not null check (dte between 0 and 30),
    option_type text not null check (option_type in ('CALL', 'PUT')),
    strike numeric not null,
    bid numeric,
    ask numeric,
    last numeric,
    mark numeric,
    delta double precision,
    gamma double precision,
    theta double precision,
    vega double precision,
    iv double precision,
    open_interest bigint,
    volume bigint,
    underlying_price numeric not null,
    quote_time timestamptz not null,
    source text not null,
    source_latency_ms double precision,
    updated_at timestamptz not null default now(),
    primary key (symbol, expiration, option_type, strike)
);

create index if not exists options_chain_live_lookup_idx
    on public.options_chain_live (symbol, dte, expiration, strike);

create table if not exists public.options_signal_live (
    symbol text not null check (symbol in ('SPY', 'QQQ')),
    dte smallint not null check (dte in (0, 1)),
    as_of timestamptz not null,
    status text not null check (status in ('READY', 'NO_TRADE', 'WAITING', 'STALE')),
    direction text not null check (direction in ('CALL', 'PUT', 'NONE')),
    expiration date,
    contract_symbol text,
    strike numeric,
    entry_bid numeric,
    entry_ask numeric,
    entry_mid numeric,
    target_price numeric,
    target_underlying numeric,
    required_underlying_move_pct double precision,
    delta double precision,
    gamma double precision,
    iv double precision,
    open_interest bigint,
    volume bigint,
    spread_pct double precision,
    score double precision check (score is null or score between 0 and 100),
    confidence double precision check (confidence is null or confidence between 0 and 1),
    regime text,
    model_read text,
    invalidation numeric,
    structure jsonb not null default '{}'::jsonb,
    orderflow jsonb not null default '{}'::jsonb,
    latency jsonb not null default '{}'::jsonb,
    source_version text not null,
    updated_at timestamptz not null default now(),
    primary key (symbol, dte)
);

alter table public.futures_orderflow_live enable row level security;
alter table public.options_chain_live enable row level security;
alter table public.options_signal_live enable row level security;

drop policy if exists options_command_reader_select on public.futures_orderflow_live;
create policy options_command_reader_select on public.futures_orderflow_live
    for select to authenticated
    using ((select auth.uid()) in (select user_id from public.dashboard_readers));

drop policy if exists options_command_reader_select on public.options_chain_live;
create policy options_command_reader_select on public.options_chain_live
    for select to authenticated
    using ((select auth.uid()) in (select user_id from public.dashboard_readers));

drop policy if exists options_command_reader_select on public.options_signal_live;
create policy options_command_reader_select on public.options_signal_live
    for select to authenticated
    using ((select auth.uid()) in (select user_id from public.dashboard_readers));

revoke all on public.futures_orderflow_live from anon, authenticated;
revoke all on public.options_chain_live from anon, authenticated;
revoke all on public.options_signal_live from anon, authenticated;
grant select on public.futures_orderflow_live to authenticated;
grant select on public.options_chain_live to authenticated;
grant select on public.options_signal_live to authenticated;

do $$
begin
    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'futures_orderflow_live'
    ) then
        alter publication supabase_realtime add table public.futures_orderflow_live;
    end if;
    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'options_chain_live'
    ) then
        alter publication supabase_realtime add table public.options_chain_live;
    end if;
    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'options_signal_live'
    ) then
        alter publication supabase_realtime add table public.options_signal_live;
    end if;
end
$$;

comment on table public.futures_orderflow_live is
    'Latest ES/NQ in-memory order-flow features for Options Command; no raw tick archive.';
comment on table public.options_chain_live is
    'Current nearby SPY/QQQ option rows supplied by a pluggable market-data adapter.';
comment on table public.options_signal_live is
    'Paper decision-support candidates only; never an order instruction.';
