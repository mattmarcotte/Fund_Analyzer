import { looksLikeFund } from "@/lib/fundDetect";
import { findSeriesByTicker } from "@/lib/fundIndex";
import {
  availableLayers,
  findStoredFund,
  getHoldings,
  knownFundTickers,
  type StoredFund,
  type StoredHolding,
} from "@/lib/ingest/refresh";
import { canRead, canWrite } from "@/lib/ingest/store";
import { toAssetClass } from "@/lib/sec/assetClass";
import {
  FundLookupError,
  type AssetCategory,
  type FundSnapshot,
  type Holding,
} from "@/lib/types";

/**
 * Canadian ETFs, served from the Supabase store.
 *
 * Unlike the SEC path — which parses a filing on every request — this reads
 * from Postgres and only hits the provider when the stored snapshot has gone
 * stale. That's what keeps a query cheap: one CSV for the fund you asked about,
 * not a rebuild of the catalogue.
 *
 * iShares also publishes the look-through layer itself, so for XEQT and friends
 * we get the underlying securities directly and never need the recursive SEC
 * expansion.
 */

/** iShares' own asset-class labels -> the N-PORT codes the app is built around. */
const ASSET_CAT_BY_LABEL: Record<string, AssetCategory> = {
  equity: "EC",
  "fixed income": "DBT",
  cash: "STIV",
  "money market": "STIV",
  "cash and/or derivatives": "STIV",
  "cash collateral and margins": "STIV",
  futures: "DE",
  fx: "DE",
  option: "DE",
  swap: "DE",
  "real estate": "RE",
  commodity: "COMM",
};

function toAssetCategory(label: string | null): AssetCategory {
  if (!label) return "OTHER";
  return ASSET_CAT_BY_LABEL[label.trim().toLowerCase()] ?? "OTHER";
}

function toHolding(row: StoredHolding, fundTickers: Set<string>): Holding {
  const assetCat = toAssetCategory(row.asset_class);

  // Sector arrives as GICS straight from the provider, so unlike the SEC path
  // there's no SIC lookup and no enrichment round-trip. "Other" is iShares'
  // placeholder and carries no meaning, so it's dropped rather than charted.
  const sector =
    row.sector && row.sector.trim().toLowerCase() !== "other"
      ? row.sector.trim()
      : null;

  return {
    id: row.cusip ?? row.isin ?? row.ticker ?? `name:${row.name.toLowerCase().trim()}`,
    name: row.name,
    title: null,
    cusip: row.cusip,
    isin: row.isin,
    lei: null,
    ticker: row.ticker,
    pct: row.weight ?? 0,
    valueUsd: row.market_value ?? 0,
    balance: row.shares,
    units: "NS",
    currency: row.currency,
    assetCat,
    assetClass: toAssetClass(assetCat),
    issuerCat: "CORP",
    country: row.country,
    payoffProfile: (row.weight ?? 0) < 0 ? "Short" : "Long",
    /*
     * A ticker present in the catalogue is definitive. The name heuristic is
     * only a fallback, and a poor one here: iShares truncates names in the CSV
     * ("ISHARES CORE S&P TOTAL U.S. COM"), so most fund holdings carry no
     * "ETF"/"fund" keyword at all. Restricted to equity rows either way, or
     * index futures get flagged on the word "index".
     */
    isFund:
      assetCat === "EC" &&
      ((row.ticker !== null &&
        (fundTickers.has(row.ticker.toUpperCase()) ||
          // Canadian wrappers routinely hold US-listed ETFs (XEQT owns ITOT),
          // which live in the SEC register rather than this catalogue. Checking
          // both is what makes drilling across the border work.
          findSeriesByTicker(row.ticker) !== null)) ||
        looksLikeFund(row.name, "CORP")),
    sector,
    industry: null,
    sicCode: null,
  };
}

function toSnapshot(
  fund: StoredFund,
  asOf: string,
  sourceUrl: string | null,
  rows: StoredHolding[],
  hasLookThrough: boolean,
  fundTickers: Set<string>,
): FundSnapshot {
  const holdings = rows
    .map((r) => toHolding(r, fundTickers))
    .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));

  return {
    meta: {
      ticker: fund.ticker,
      registrantName: "iShares Canada (BlackRock)",
      seriesName: fund.name,
      seriesId: fund.id,
      cik: "",
      classId: null,
      asOf,
      filedAt: null,
      accession: null,
      filingUrl: sourceUrl,
      totalAssets: fund.aum,
      netAssets: fund.aum,
      source: "ishares-ca",
      currency: "CAD",
      sourceLabel: hasLookThrough
        ? "iShares Canada daily holdings (with published look-through)"
        : "iShares Canada daily holdings",
    },
    holdings,
    totalPct: holdings.reduce((sum, h) => sum + Math.abs(h.pct), 0),
    holdingsArePartial: false,
  };
}

/**
 * Whether stored holdings can be served. Only the publishable key is needed —
 * refreshing from the provider additionally needs the service-role key, and
 * degrades gracefully without it.
 */
export function storeConfigured(): boolean {
  return canRead();
}

export async function fetchIsharesCaSnapshot(
  ticker: string,
): Promise<FundSnapshot | null> {
  if (!storeConfigured()) return null;

  const stored = await getHoldings(ticker, "direct");

  if (!stored) {
    /*
     * Distinguish "we've never heard of this ticker" from "we know this fund
     * but have nothing stored and can't fetch it". Reporting the second as
     * not-found sends people off checking a symbol that is perfectly valid.
     */
    const known = await findStoredFund(ticker);
    if (known && !canWrite()) {
      throw new FundLookupError(
        `${known.ticker} — ${known.name} is in the catalogue, but its holdings haven't been fetched yet`,
        "UPSTREAM_ERROR",
        "Set SUPABASE_SERVICE_ROLE_KEY in .env.local so holdings can be fetched on demand, or warm the store with `npm run ingest`.",
      );
    }
    return null;
  }

  const [layers, fundTickers] = await Promise.all([
    availableLayers(stored.fund.id),
    knownFundTickers(),
  ]);

  return toSnapshot(
    stored.fund,
    stored.asOf,
    stored.sourceUrl,
    stored.holdings,
    layers.includes("lookthrough"),
    fundTickers,
  );
}

/**
 * The provider's own look-through, where it publishes one. Preferred over the
 * recursive SEC expansion for these funds: it's the manager's own figures and
 * needs no upstream requests.
 */
export async function fetchIsharesCaLookThrough(
  ticker: string,
): Promise<{ holdings: Holding[]; asOf: string } | null> {
  if (!storeConfigured()) return null;

  const stored = await getHoldings(ticker, "lookthrough");
  if (!stored || !stored.holdings.length) return null;

  const fundTickers = await knownFundTickers();

  return {
    holdings: stored.holdings
      .map((r) => toHolding(r, fundTickers))
      .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)),
    asOf: stored.asOf,
  };
}

export function isharesCaNotConfiguredError(): FundLookupError {
  return new FundLookupError(
    "The Canadian ETF store isn't configured",
    "UPSTREAM_ERROR",
    "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local to enable Canadian ETFs.",
  );
}
