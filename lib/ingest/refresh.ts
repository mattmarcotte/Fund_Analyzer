import {
  canWrite,
  getClient,
  markIngested,
  writeSnapshot,
} from "@/lib/ingest/store";
import { providerById } from "@/lib/ingest/providers";
import { cacheGet, cacheSet, TTL } from "@/lib/cache";
import type { HoldingsLayer, ProviderFund } from "@/lib/ingest/types";

/**
 * Read-through refresh.
 *
 * A fund's holdings are refreshed when someone actually asks for it, rather
 * than by rebuilding the whole catalogue: one CSV per query instead of 173.
 * If the stored snapshot is fresh enough it's served straight from Postgres and
 * no upstream request happens at all.
 *
 * The bulk CLI (`npm run ingest`) still exists for warming the store or
 * backfilling, but nothing depends on having run it.
 */

/**
 * How old a snapshot may be before a query triggers a refetch.
 *
 * iShares republishes once per business day, so anything under a day is wasted
 * work. Six hours means a fund queried in the morning picks up that day's file
 * without hammering the provider on every page view.
 */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export interface StoredHolding {
  position: number;
  ticker: string | null;
  name: string;
  sector: string | null;
  asset_class: string | null;
  weight: number | null;
  market_value: number | null;
  shares: number | null;
  price: number | null;
  country: string | null;
  exchange: string | null;
  currency: string | null;
  isin: string | null;
  cusip: string | null;
}

export interface StoredFund {
  id: string;
  provider: string;
  provider_fund_id: string | null;
  ticker: string;
  name: string;
  exchange: string;
  currency: string;
  asset_class: string | null;
  aum: number | null;
  management_fee: number | null;
  holdings_url: string | null;
  last_ingested_at: string | null;
}

export interface StoredSnapshot {
  fund: StoredFund;
  asOf: string;
  layer: HoldingsLayer;
  sourceUrl: string | null;
  holdings: StoredHolding[];
  /** True when this response triggered an upstream fetch. */
  refreshed: boolean;
}

/** Look up a fund in the catalogue by exchange ticker. */
export async function findStoredFund(ticker: string): Promise<StoredFund | null> {
  const { data, error } = await getClient()
    .from("funds")
    .select(
      "id, provider, provider_fund_id, ticker, name, exchange, currency, asset_class, aum, management_fee, holdings_url, last_ingested_at",
    )
    .ilike("ticker", ticker.trim())
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`fund lookup failed: ${error.message}`);
  return (data as StoredFund | null) ?? null;
}

async function isStale(fundId: string): Promise<boolean> {
  const { data, error } = await getClient()
    .from("holdings_snapshots")
    .select("ingested_at")
    .eq("fund_id", fundId)
    .order("ingested_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return true;
  return Date.now() - new Date(data.ingested_at as string).getTime() > STALE_AFTER_MS;
}

/** Rebuild the provider-shaped record needed to refetch a stored fund. */
function toProviderFund(fund: StoredFund): ProviderFund {
  return {
    ticker: fund.ticker,
    name: fund.name,
    providerFundId: fund.provider_fund_id ?? "",
    exchange: fund.exchange,
    currency: fund.currency,
    assetClass: fund.asset_class,
    aum: fund.aum,
    managementFee: fund.management_fee,
    inceptionDate: null,
    holdingsUrl: fund.holdings_url ?? "",
  };
}

/** Pull this fund's current holdings from the provider and store them. */
async function refresh(fund: StoredFund): Promise<void> {
  const provider = providerById(fund.provider);
  if (!provider) throw new Error(`no adapter registered for "${fund.provider}"`);

  const sets = await provider.fetchHoldings(toProviderFund(fund));
  for (const set of sets) {
    await writeSnapshot(fund.id, set);
  }
  await markIngested(fund.id);
}

async function readSnapshot(
  fund: StoredFund,
  layer: HoldingsLayer,
): Promise<{ asOf: string; sourceUrl: string | null; holdings: StoredHolding[] } | null> {
  const db = getClient();

  const { data: snap, error: snapErr } = await db
    .from("holdings_snapshots")
    .select("id, as_of, source_url")
    .eq("fund_id", fund.id)
    .eq("layer", layer)
    .order("as_of", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (snapErr || !snap) return null;

  /*
   * PostgREST caps a response at 1,000 rows by default, and these funds run to
   * 22,000 holdings, so pages are requested explicitly. Without this the tail
   * of every large fund silently disappears.
   */
  const PAGE = 1000;
  const holdings: StoredHolding[] = [];

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("holdings")
      .select(
        "position, ticker, name, sector, asset_class, weight, market_value, shares, price, country, exchange, currency, isin, cusip",
      )
      .eq("snapshot_id", snap.id)
      .order("position", { ascending: true })
      .range(from, from + PAGE - 1);

    if (error) throw new Error(`holdings read failed: ${error.message}`);
    if (!data?.length) break;

    holdings.push(...(data as StoredHolding[]));
    if (data.length < PAGE) break;
  }

  return {
    asOf: snap.as_of as string,
    sourceUrl: (snap.source_url as string | null) ?? null,
    holdings,
  };
}

/**
 * Serve a fund's holdings, refreshing from the provider first if what we have
 * is stale or missing.
 *
 * A refresh failure on an existing snapshot is deliberately swallowed: stale
 * data beats an error page, and the returned `asOf` tells the user how old it
 * is. If there's nothing stored at all, the error propagates.
 */
export async function getHoldings(
  ticker: string,
  layer: HoldingsLayer = "direct",
): Promise<StoredSnapshot | null> {
  const fund = await findStoredFund(ticker);
  if (!fund) return null;

  let refreshed = false;

  // Without the service-role key we can still serve what's stored; only the
  // write-back is unavailable.
  if (canWrite() && (await isStale(fund.id))) {
    try {
      await refresh(fund);
      refreshed = true;
    } catch (err) {
      const existing = await readSnapshot(fund, layer);
      if (!existing) throw err;
    }
  }

  const snapshot = await readSnapshot(fund, layer);
  if (!snapshot) return null;

  return { fund, layer, ...snapshot, refreshed };
}

/** Which layers this fund has stored — `lookthrough` only exists for fund-of-funds. */
export async function availableLayers(fundId: string): Promise<HoldingsLayer[]> {
  const { data, error } = await getClient()
    .from("holdings_snapshots")
    .select("layer")
    .eq("fund_id", fundId);

  if (error || !data) return ["direct"];
  return [...new Set(data.map((r) => r.layer as HoldingsLayer))];
}

/**
 * Every ticker in the catalogue.
 *
 * Used to decide whether a *holding* is itself a fund. Names alone can't carry
 * this: iShares truncates them in the CSV ("ISHARES CORE S&P TOTAL U.S. COM"),
 * so keyword matching on "ETF"/"fund"/"index" misses most of them and flags the
 * odd index future by accident. A ticker match against the catalogue is exact.
 */
export async function knownFundTickers(): Promise<Set<string>> {
  const cached = cacheGet<Set<string>>("ishares:tickers");
  if (cached) return cached;

  const { data, error } = await getClient().from("funds").select("ticker");
  const tickers = new Set(
    error || !data ? [] : data.map((r) => String(r.ticker).toUpperCase()),
  );

  cacheSet("ishares:tickers", tickers, TTL.TICKER_MAP);
  return tickers;
}

/** Ticker search over the stored catalogue, for the app's search box. */
export async function searchStoredFunds(
  query: string,
  limit = 8,
): Promise<StoredFund[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  const { data, error } = await getClient()
    .from("funds")
    .select(
      "id, provider, provider_fund_id, ticker, name, exchange, currency, asset_class, aum, management_fee, holdings_url, last_ingested_at",
    )
    .or(`ticker.ilike.${q}%,name.ilike.%${q}%`)
    .order("aum", { ascending: false, nullsFirst: false })
    .limit(limit);

  if (error) return [];
  return (data as StoredFund[]) ?? [];
}
