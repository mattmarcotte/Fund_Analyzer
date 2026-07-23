-- Fund Analyzer — holdings store
--
-- Run this once against your Supabase project:
--   Supabase dashboard -> SQL Editor -> paste -> Run
-- or, with the Supabase CLI linked to your project:
--   supabase db push
--
-- Design notes
--
-- Holdings are stored as immutable dated snapshots rather than a mutable
-- current-state table. Providers publish daily, and the whole point of a
-- scheduled refresh is being able to ask "what did this fund hold in March?" —
-- overwriting in place would throw that away. Re-ingesting the same as-of date
-- replaces that snapshot rather than duplicating it.
--
-- Fund-of-funds get two snapshots per date, distinguished by `layer`: the ETFs
-- the fund directly holds, and (where the provider publishes it) the
-- look-through to underlying securities. Keeping them apart matters because
-- summing both double-counts — XEQT's file totals ~193% across the two layers.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- funds ----

create table if not exists funds (
  id                uuid primary key default gen_random_uuid(),
  provider          text not null,
  provider_fund_id  text,
  ticker            text not null,
  exchange          text not null default 'TSX',
  name              text not null,
  asset_class       text,
  currency          text not null default 'CAD',
  aum               numeric,
  management_fee    numeric,
  inception_date    date,
  holdings_url      text,
  last_ingested_at  timestamptz,
  created_at        timestamptz not null default now(),

  constraint funds_provider_ticker_key unique (provider, ticker)
);

comment on column funds.provider_fund_id is
  'The provider''s own id (iShares product id, Vanguard portId). Needed to rebuild holdings URLs.';

create index if not exists funds_ticker_idx on funds (ticker);
create index if not exists funds_aum_idx on funds (aum desc nulls last);

-- ------------------------------------------------------------ snapshots ----

do $$ begin
  create type holdings_layer as enum ('direct', 'lookthrough');
exception
  when duplicate_object then null;
end $$;

create table if not exists holdings_snapshots (
  id            uuid primary key default gen_random_uuid(),
  fund_id       uuid not null references funds (id) on delete cascade,
  as_of         date not null,
  layer         holdings_layer not null default 'direct',
  row_count     integer not null default 0,
  total_weight  numeric,
  source_url    text,
  ingested_at   timestamptz not null default now(),

  constraint holdings_snapshots_unique unique (fund_id, as_of, layer)
);

create index if not exists holdings_snapshots_fund_idx
  on holdings_snapshots (fund_id, as_of desc);

-- ------------------------------------------------------------- holdings ----

create table if not exists holdings (
  id            bigserial primary key,
  snapshot_id   uuid not null references holdings_snapshots (id) on delete cascade,
  position      integer not null,
  ticker        text,
  name          text not null,
  sector        text,
  asset_class   text,
  weight        numeric,
  market_value  numeric,
  shares        numeric,
  price         numeric,
  country       text,
  exchange      text,
  currency      text,
  isin          text,
  cusip         text,
  -- Provider columns that don't fit the shared shape (duration, YTM, coupon,
  -- maturity on bond funds) are kept rather than dropped.
  extra         jsonb
);

create index if not exists holdings_snapshot_idx on holdings (snapshot_id);
create index if not exists holdings_ticker_idx on holdings (ticker) where ticker is not null;
create index if not exists holdings_name_idx on holdings (name);

-- ----------------------------------------------------------------- views ----

-- Most recent snapshot per fund and layer, which is what the app reads.
create or replace view latest_snapshots as
select distinct on (s.fund_id, s.layer)
  s.id,
  s.fund_id,
  s.as_of,
  s.layer,
  s.row_count,
  s.total_weight,
  s.source_url,
  s.ingested_at,
  f.ticker,
  f.name as fund_name,
  f.provider,
  f.currency as fund_currency
from holdings_snapshots s
join funds f on f.id = s.fund_id
order by s.fund_id, s.layer, s.as_of desc;

-- Views default to SECURITY DEFINER, which evaluates RLS as the view's creator
-- rather than the caller. Harmless while reads are public, but it would
-- silently bypass any future restriction on the base tables.
alter view latest_snapshots set (security_invoker = true);

-- ------------------------------------------------------------ row level ----

-- Holdings are public regulatory disclosures, so reads are open and writes are
-- restricted to the service role the ingestion CLI uses. If you'd rather keep
-- the data private, drop the three read policies below.

alter table funds              enable row level security;
alter table holdings_snapshots enable row level security;
alter table holdings           enable row level security;

do $$ begin
  create policy funds_read      on funds              for select using (true);
  create policy snapshots_read  on holdings_snapshots for select using (true);
  create policy holdings_read   on holdings           for select using (true);
exception
  when duplicate_object then null;
end $$;
