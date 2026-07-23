import {
  findSeriesById,
  findSeriesByName,
  searchFunds,
  type FundSuggestion,
} from "@/lib/fundIndex";
import { allIgFunds, fetchIgSnapshot, findIgFund, searchIgFunds } from "@/lib/providers/ig";
import { searchStoredFunds } from "@/lib/ingest/refresh";
import {
  fetchIsharesCaSnapshot,
  storeConfigured,
} from "@/lib/providers/isharesCaStore";
import { fetchSnapshotBySeries, fetchSnapshotByTicker } from "@/lib/sec/nport";
import { lookupFundTicker } from "@/lib/sec/tickers";
import { FundLookupError, type FundSnapshot } from "@/lib/types";

/**
 * Provider registry.
 *
 * Two sources today: SEC EDGAR for US-registered funds, and IG Wealth
 * Management for Canadian unit trusts. Adding a third (a paid API covering
 * TSX-listed ETFs, say) means implementing `fetchSnapshot` and adding it to the
 * resolution order below — nothing upstream needs to change.
 */

export type ProviderId = "sec-edgar" | "ig-wealth" | "ishares-ca";

export interface SearchResult {
  /** What to put in the URL to look this fund up. */
  query: string;
  label: string;
  sublabel: string;
  provider: ProviderId;
}

/**
 * Resolve a user query to a snapshot.
 *
 * SEC is tried first: its keys are tickers, which are unambiguous, whereas IG
 * matches on fund names and could otherwise shadow a legitimate ticker.
 */
export async function fetchSnapshot(query: string): Promise<FundSnapshot> {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new FundLookupError("No fund specified", "UNKNOWN_TICKER");
  }

  const secIdentity = await lookupFundTicker(trimmed).catch(() => undefined);
  if (secIdentity) return fetchSnapshotByTicker(trimmed);

  /*
   * Canadian ETFs come from the Supabase store, which refreshes the single
   * queried fund from iShares when its snapshot has gone stale. Tried after
   * SEC because TSX and US tickers share a namespace and a US match is the
   * safer default; no overlap is known today, but the order makes the
   * precedence explicit rather than accidental.
   */
  if (storeConfigured()) {
    // A FundLookupError here is a deliberate, specific message (e.g. the fund
    // is known but unfetched) and must reach the user. Anything else is an
    // infrastructure failure, which falls through to the remaining providers.
    const canadian = await fetchIsharesCaSnapshot(trimmed).catch((err) => {
      if (err instanceof FundLookupError) throw err;
      return null;
    });
    if (canadian) return canadian;
  }

  if (findIgFund(trimmed)) return fetchIgSnapshot(trimmed);

  // Drill-down passes fund *names*, since that's all an N-PORT reports for the
  // funds inside a fund-of-funds.
  const byName = findSeriesByName(trimmed) ?? findSeriesById(trimmed);
  if (byName) {
    return fetchSnapshotBySeries(byName.id, byName.tickers[0] ?? byName.name);
  }

  throw new FundLookupError(
    `Couldn't find a fund matching "${trimmed}"`,
    "UNKNOWN_TICKER",
    "Supported: any US-registered ETF or mutual fund ticker (VOO, VTI, AOR), Canadian iShares ETFs (XEQT, XIU, XIC), and IG Wealth Management funds by name.",
  );
}

/** Combined autocomplete across every provider. */
export async function search(
  query: string,
  limit = 10,
): Promise<SearchResult[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  const sec: SearchResult[] = searchFunds(q, limit).map(
    (s: FundSuggestion) => ({
      query: s.ticker ?? s.seriesId,
      label: s.ticker ?? s.name,
      sublabel: s.ticker ? s.name : s.entity,
      provider: "sec-edgar" as const,
    }),
  );

  const ig: SearchResult[] = searchIgFunds(q, limit).map((f) => ({
    query: f.slug,
    label: f.name,
    sublabel: "IG Wealth Management",
    provider: "ig-wealth" as const,
  }));

  // Canadian ETFs live in Supabase rather than a vendored index, so this is the
  // one source that needs a round trip. A failure here degrades the suggestion
  // list rather than breaking search.
  const canadian: SearchResult[] = storeConfigured()
    ? await searchStoredFunds(q, limit)
        .then((funds) =>
          funds.map((f) => ({
            query: f.ticker,
            label: f.ticker,
            sublabel: f.name,
            provider: "ishares-ca" as const,
          })),
        )
        .catch(() => [])
    : [];

  // Interleave so a Canadian match isn't buried under ten US tickers.
  const out: SearchResult[] = [];
  const longest = Math.max(sec.length, ig.length, canadian.length);
  for (let i = 0; i < longest && out.length < limit; i++) {
    if (canadian[i] && out.length < limit) out.push(canadian[i]);
    if (sec[i] && out.length < limit) out.push(sec[i]);
    if (ig[i] && out.length < limit) out.push(ig[i]);
  }
  return out;
}

/** Examples for the empty state, chosen to show off different fund shapes. */
export function featuredFunds(): SearchResult[] {
  const ig = allIgFunds();
  const igPick = ig.find((f) => /Canadian Equity Fund$/.test(f.name)) ?? ig[0];

  const featured: SearchResult[] = [
    {
      query: "VOO",
      label: "VOO",
      sublabel: "Vanguard 500 Index Fund — 500+ US large caps",
      provider: "sec-edgar",
    },
    {
      query: "AOR",
      label: "AOR",
      sublabel: "iShares Core Growth Allocation — fund of funds, drills two levels",
      provider: "sec-edgar",
    },
    {
      query: "VTI",
      label: "VTI",
      sublabel: "Vanguard Total Stock Market — the whole US market",
      provider: "sec-edgar",
    },
  ];

  featured.splice(2, 0, {
    query: "XEQT",
    label: "XEQT",
    sublabel: "iShares Core Equity ETF Portfolio — Canadian, daily holdings",
    provider: "ishares-ca",
  });

  if (igPick) {
    featured.push({
      query: igPick.slug,
      label: igPick.name,
      sublabel: "IG Wealth Management — Canadian mutual fund",
      provider: "ig-wealth",
    });
  }

  return featured;
}
