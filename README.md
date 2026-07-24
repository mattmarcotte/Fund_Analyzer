# Fund Analyzer

Look up a US or Canadian fund and see what it actually holds — then keep drilling,
through the funds inside it, down to individual companies.

Built on free, official data. No paid market-data APIs.

![Next.js](https://img.shields.io/badge/Next.js-15-black) ![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue) ![Supabase](https://img.shields.io/badge/Supabase-Postgres-3ecf8e)

## What it does

- **US funds** — any SEC-registered ETF or mutual fund, from Form N-PORT.
- **Canadian ETFs** — iShares Canada, refreshed on demand into Supabase.
- **Canadian mutual funds** — IG Wealth Management, from published disclosures.
- **Look-through** — when a fund holds other funds, their holdings are spliced
  in with weights multiplied down the chain. Expand any row to go deeper.
- **Charts** — asset allocation, sector, geography, industry.

### Why look-through is the point

`AOR` is the iShares Core 60/40 Balanced ETF. Its own filing reports nine
holdings, all ETFs, each categorised `Other` — at face value the fund is 100%
unclassifiable. Expanded, it resolves to ~32,000 securities at **61.6% equity /
37.1% fixed income**, which is the fund the name describes.

`XEQT` goes further: iShares publishes its own look-through, so it resolves to
**8,463 securities with 0% unresolved**, with GICS sectors attached and no
EDGAR recursion needed.

## Quick start

```bash
npm install
cp .env.example .env.local   # then fill it in — see Configuration
npm run dev
```

Open <http://localhost:3000> and try `VOO`, `AOR`, `XIU`, or
`ig-mackenzie-canadian-equity-fund`.

## Configuration

Only `SEC_USER_AGENT` is required. Supabase variables enable Canadian ETFs; the
rest of the app works without them.

| Variable | Required | Purpose |
|---|---|---|
| `SEC_USER_AGENT` | **yes** | Contact string the SEC's fair-access policy demands |
| `SUPABASE_URL` | for CA ETFs | Project URL |
| `NEXT_PUBLIC_SUPABASE_URL` | for CA ETFs | Same value, client-visible |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | for CA ETFs | **Read** holdings (RLS-scoped, safe to expose) |
| `SUPABASE_SERVICE_ROLE_KEY` | for refresh | **Write** holdings — bypasses RLS, server only |

### SEC User-Agent

The SEC rejects requests without a User-Agent identifying the application and a
contact address, and IP-bans clients that misbehave. Set it to
`"AppName your@email.com"`.

It's a real contact channel, so use an address you're willing to have attached
to outbound traffic. Requests are rate-limited to 8/sec, under the documented
10/sec ceiling.

### The two Supabase keys

They are not interchangeable:

| | Publishable | Service-role |
|---|---|---|
| Read stored holdings | ✅ | ✅ |
| Fetch from provider and write back | ❌ | ✅ |
| Respects RLS | ✅ | ❌ **bypasses entirely** |
| Safe in the browser | ✅ | 🚫 **never** |

`service_role` is a full-admin credential. It's confined to the write functions
in `lib/ingest/store.ts` and the ingestion CLI, and never reaches the client
bundle. If it leaks, rotate it in the Supabase dashboard.

## Data sources

| Source | Used for | Cost |
|---|---|---|
| [SEC EDGAR Form N-PORT](https://www.sec.gov/) | US holdings, weights, asset class, country | free |
| [SEC series & class report](https://www.sec.gov/data-research/sec-markets-data/investment-company-series-class-information) | fund name → series crosswalk, search | free |
| SEC company registry + SIC codes | sector / industry for US funds | free |
| [GLEIF](https://www.gleif.org/en/lei-data/gleif-api) | LEI → legal names, to resolve renamed funds | free |
| [iShares Canada](https://www.blackrock.com/ca) | Canadian ETF holdings, daily, with GICS sectors | free |
| [IG Wealth Management](https://www.ig.ca/) | Canadian mutual fund holdings and allocations | free |

All published endpoints and datasets. No scraping of rendered pages, no
bot-detection avoidance, and `robots.txt` respected throughout.

## Canadian ETF store (Supabase)

Canadian ETFs file to SEDAR+ rather than EDGAR, so N-PORT never covers them.
SEDAR+ itself is a stateful session-bound app with no public API, so holdings
come from the issuer's own published CSVs into Postgres instead.

| Table | Holds |
|---|---|
| `funds` | one row per ETF — ticker, provider, AUM, derived holdings URL |
| `holdings_snapshots` | one per fund per date per **layer** — history is kept |
| `holdings` | the rows: sector, weight, country, shares, price |

Two decisions worth knowing:

- **Snapshots are immutable and dated.** Issuers publish daily; overwriting in
  place would discard history. Re-ingesting a date replaces that snapshot, so
  re-runs are safe.
- **`layer` separates `direct` from `lookthrough`.** iShares publishes both the
  ETFs a fund-of-funds owns *and* the securities behind them, in one file, each
  totalling ~100%. XEQT sums to ~193% read as a single table.

### Refresh happens per query

Ask for `XEQT` and only XEQT's CSV is fetched — and only if its snapshot is more
than six hours old. Anything fresher is served straight from Postgres:

```
cold   11.8s   fetch 2MB CSV, write 8,470 rows across 2 layers
warm    0.5s   served from Postgres, zero upstream requests
```

Six hours is deliberate: iShares republishes once per business day, so a tighter
window is wasted work. If a refresh fails but a snapshot exists, the stale data
is served with its as-of date rather than an error.

### Bulk ingestion

Optional — for warming the store or backfilling. Nothing depends on it:

```bash
npm run ingest -- --top 100           # 100 largest by AUM (default)
npm run ingest -- --all               # every fund on offer
npm run ingest -- --ticker XEQT,XIU
npm run ingest -- --top 5 --dry-run   # fetch and parse, write nothing
```

Run locally or in CI, **not** in a serverless function: a full pass pulls
hundreds of megabytes (XGRO alone is 5.5MB / 22k rows).

### Database setup

`supabase/migrations/0001_init.sql` creates the schema, RLS policies and the
`latest_snapshots` view. Paste it into the Supabase SQL editor, or
`supabase db push` with the CLI linked.

## Deploying to Vercel

```bash
npx vercel
```

Then set the environment variables under **Settings → Environment Variables**:

| Variable | Environments |
|---|---|
| `SEC_USER_AGENT` | Production, Preview, Development |
| `SUPABASE_URL` | Production, Preview |
| `NEXT_PUBLIC_SUPABASE_URL` | Production, Preview |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Production, Preview |
| `SUPABASE_SERVICE_ROLE_KEY` | Production, Preview — **never** commit |

Then redeploy so the new variables take effect.

Three things to know:

- **Function duration.** `/api/lookthrough/[query]` sets `maxDuration = 60`.
  Hobby plans cap at 60s, and the first uncached load of a large US
  fund-of-funds uses a good chunk of it. Canadian funds are far quicker — the
  look-through is pre-computed in Postgres.
- **Caching is per-instance.** `lib/cache.ts` is in-process and resets on cold
  start. To share it, swap `cacheGet`/`cacheSet` for Vercel KV — no call sites
  change.
- **Ingestion doesn't belong here.** Run the CLI locally or in CI.

## Rate limiting

Every fund lookup reaches sec.gov carrying this deployment's contact address,
and Canadian lookups can pull a multi-megabyte CSV and write to Supabase. A
crawler walking `/fund/<anything>` would do all of that under the operator's
name, so the routes that trigger upstream work are capped per IP:

| Route | Limit / min / IP |
|---|---|
| `/api/search` | 60 |
| `/api/fund/[query]` and `/fund/[query]` | 30 |
| `/api/enrich` | 20 |
| `/api/lookthrough/[query]` | 10 |

Over the limit returns `429` with `Retry-After` and `RateLimit-*` headers; the
page route renders an explanatory card instead of a bare error.

Enforced in the route handlers rather than in middleware — middleware bypass has
been a recurring class of Next.js vulnerability, and a limiter that can be
routed around isn't one.

**Serverless caveat:** counters live in instance memory and reset on cold start,
so the real ceiling is (limit x warm instances). That covers the actual threat —
an unattended crawler — but not a distributed attacker. For that, swap `hit()`
in `lib/rateLimit.ts` for a Vercel KV or Postgres counter; no call sites change.

## Dependency security

The first deployment was refused by Vercel for shipping a Next.js release with
29 open advisories, including a critical RCE. Noticing that at deploy time is
too late, so the repo is configured to surface it earlier:

- **Dependabot alerts and automated security fixes** are enabled, so a patched
  CVE opens a pull request without waiting for the weekly cycle.
- **`.github/dependabot.yml`** batches routine minor/patch bumps into one weekly
  PR, keeps majors separate, and never batches security updates.
- **`.github/workflows/ci.yml`** runs typecheck, build and `npm audit` on every
  PR, so a dependency bump arrives with evidence rather than hope. The audit
  gate fails on high and critical only — a moderate advisory in a dev tool
  shouldn't wedge unrelated work.

Next and React majors are excluded from automatic version PRs: those are
migrations, not bumps. `ignore` rules don't apply to security updates, so a
Next.js CVE still opens a PR regardless.

## Architecture

```
app/
  api/fund/[query]        resolve a ticker to holdings
  api/lookthrough/[query] published look-through, else reconstructed
  api/enrich              sector/industry resolution for US holdings
lib/
  sec/          N-PORT fetching and parsing, SIC lookup, rate-limited client
  providers/    read side — SEC EDGAR, iShares CA (Supabase), IG Wealth
  ingest/       write side — provider adapters, refresh logic, Supabase store
  lookthrough.ts    recursive expansion, weight math, cycle detection
  fundIndex.ts      name → series matching (exact, token-set, then fuzzy)
  gleif.ts          LEI → names, for funds renamed since the register snapshot
components/     dashboard, charts, holdings table
```

Adding a **read** source: implement `fetchSnapshot` and register it in
`lib/providers/index.ts`. Adding an **ingestion** source: implement
`EtfProvider` in `lib/ingest/providers/`. Neither touches the other.

## Known limits

- **US holdings lag.** N-PORT is quarterly with up to a 60-day delay. Canadian
  ETF data is daily. Every page shows its as-of date.
- **Unit investment trusts don't file N-PORT** — `SPY` and `DIA` are UITs, so
  EDGAR has no holdings for them.
- **US sectors are SIC-derived, not GICS.** SIC predates modern sector schemes;
  the largest divergences (Alphabet, Meta, Visa, Mastercard) are corrected
  explicitly, the long tail is approximate, and charts say so. Canadian funds
  are unaffected — their providers publish GICS directly.
- **Sector coverage is partial on large US look-throughs.** Each company is a
  separate rate-limited SEC request, so classification is capped; the chart
  reports its coverage and is normalised to it.
- **Canadian coverage is iShares + IG only.** Vanguard Canada exposes a JSON API
  keyed by `portId` and BMO is unmapped; both are additive.
- **The catalogue is seeded, not complete.** 25 of 173 iShares CA funds are
  catalogued. `npm run ingest -- --all` fills in the rest.

## Disclaimer

Informational tool, not investment advice. Figures come from regulatory filings
and provider disclosures and may contain parsing errors — verify anything you'd
act on against the source, which is linked on every fund page.
