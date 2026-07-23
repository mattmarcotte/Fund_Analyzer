import { cached, TTL } from "@/lib/cache";
import { companyList, type CompanyIdentity } from "@/lib/sec/tickers";

/**
 * Resolving an N-PORT holding to an SEC registrant.
 *
 * N-PORT identifies holdings by CUSIP/ISIN/LEI, none of which the SEC publishes
 * a free crosswalk for. Names are the only shared key, so we normalize both
 * sides aggressively and match on that. Measured against Vanguard's S&P 500
 * filing this resolves ~97% of portfolio weight; the remainder is mostly cash
 * sweeps, delisted names, and foreign issuers with no SEC registration.
 */

/** Corporate-form and share-class noise that carries no identifying signal. */
const STOPWORDS = new Set([
  "the", "inc", "incorporated", "corp", "corporation", "co", "company",
  "companies", "cos", "ltd", "limited", "plc", "public", "lp", "llc", "llp",
  "sa", "nv", "ag", "se", "spa", "ab", "as", "oyj", "holdings", "holding",
  "group", "grp", "trust", "reit", "class", "cl", "a", "b", "c", "common",
  "stock", "shares", "share", "new", "old", "adr", "ads", "sponsored",
]);

function normalize(raw: string): string {
  return raw
    .toLowerCase()
    // EDGAR appends state/vintage qualifiers: "ENTERGY CORP /DE/", "COSTCO /NEW"
    .replace(/\/[a-z]{2}\/?\s*$/, " ")
    .replace(/\/(new|old|the|fi|de|md|oh|pa|ny|tx|ca)\/?\s*$/g, " ")
    // "Amazon.com" and "AMAZON COM" must collapse to the same token stream
    .replace(/[.]/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[^a-z0-9& ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Normalized string reduced to its meaningful tokens, sorted and de-duped. */
function tokenKey(raw: string): string {
  const tokens = normalize(raw)
    .split(" ")
    .filter((t) => t && !STOPWORDS.has(t));
  return [...new Set(tokens)].sort().join(" ");
}

interface CompanyIndex {
  /** Exact normalized-name lookup. */
  byName: Map<string, CompanyIdentity>;
  /** Order-insensitive token-set lookup, for "Lowe's Cos" vs "Lowes Companies". */
  byTokens: Map<string, CompanyIdentity>;
  byTicker: Map<string, CompanyIdentity>;
}

async function companyIndex(): Promise<CompanyIndex> {
  return cached("match:company-index", TTL.TICKER_MAP, async () => {
    const companies = await companyList();
    const byName = new Map<string, CompanyIdentity>();
    const byTokens = new Map<string, CompanyIdentity>();
    const byTicker = new Map<string, CompanyIdentity>();

    for (const c of companies) {
      const name = normalize(c.title);
      const tokens = tokenKey(c.title);
      // First writer wins: company_tickers.json is ordered by market cap, so
      // ambiguous keys resolve to the larger, more likely issuer.
      if (name && !byName.has(name)) byName.set(name, c);
      if (tokens && !byTokens.has(tokens)) byTokens.set(tokens, c);
      byTicker.set(c.ticker.toUpperCase(), c);
    }

    return { byName, byTokens, byTicker };
  });
}

/**
 * Resolve a holding to an SEC registrant. Tries the reported ticker first
 * (exact and free when present), then exact name, then token-set.
 */
export async function resolveCompany(
  name: string,
  ticker?: string | null,
): Promise<CompanyIdentity | null> {
  if (!name || name === "N/A") return null;

  const index = await companyIndex();

  if (ticker) {
    const byTicker = index.byTicker.get(ticker.trim().toUpperCase());
    if (byTicker) return byTicker;
  }

  const exact = index.byName.get(normalize(name));
  if (exact) return exact;

  const tokens = index.byTokens.get(tokenKey(name));
  if (tokens) return tokens;

  return null;
}
