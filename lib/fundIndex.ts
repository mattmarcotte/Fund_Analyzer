import rawIndex from "@/data/fund-index.json";

/**
 * Name -> fund-series crosswalk, built from the SEC's series & class report.
 *
 * Look-through depends entirely on this. N-PORT names the funds inside a
 * fund-of-funds but reports no ticker or series id for them, so matching the
 * reported name against the fund register is the only free way to find the
 * underlying filing. Regenerate with `npm run update-data`.
 */

export interface FundSeries {
  id: string;
  name: string;
  cik: string;
  entity: string;
  tickers: string[];
}

interface FundIndexFile {
  generatedAt: string;
  sourceYear: number;
  series: FundSeries[];
}

const file = rawIndex as FundIndexFile;

/**
 * Abbreviations that appear in N-PORT holding names but are spelled out in the
 * register (and vice versa). Applied to both sides so they meet in the middle.
 */
const ABBREVIATIONS: Record<string, string> = {
  intl: "international",
  intrntl: "international",
  natl: "national",
  govt: "government",
  gov: "government",
  mkt: "market",
  mkts: "markets",
  idx: "index",
  fd: "fund",
  fds: "funds",
  fdn: "foundation",
  corp: "corporation",
  cos: "companies",
  mgmt: "management",
  eq: "equity",
  gr: "growth",
  sec: "securities",
  secs: "securities",
  tr: "trust",
  ptf: "portfolio",
  port: "portfolio",
  sh: "shares",
  cl: "class",
  ii: "2",
  iii: "3",
  iv: "4",
};

/** Words that add no discriminating signal between fund names. */
const NOISE = new Set(["the", "a", "an", "of", "and", "shares", "share"]);

function normalizeFundName(raw: string): string {
  const expanded = raw
    .toLowerCase()
    .replace(/&amp;/g, "&")
    // "S&P" and "AT&T" must not lose the ampersand that distinguishes them
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => ABBREVIATIONS[token] ?? token)
    .filter((token) => !NOISE.has(token));

  return expanded.join(" ");
}

/**
 * Crude singularisation. Filings abbreviate inconsistently — "…International
 * Developed Mkt ETF" in the filing vs "…International Developed Markets ETF" in
 * the register — and after expanding "mkt" the two still differ by a plural.
 */
function stem(token: string): string {
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) {
    return token.slice(0, -1);
  }
  return token;
}

function fundTokens(raw: string): string[] {
  return [...new Set(normalizeFundName(raw).split(" ").map(stem))].filter(Boolean);
}

/** Order-insensitive key, so "Fund Index Total" matches "Total Index Fund". */
function fundTokenKey(raw: string): string {
  return fundTokens(raw).sort().join(" ");
}

/** Jaccard overlap of two token sets. */
function similarity(a: string[], b: string[]): number {
  const setB = new Set(b);
  const shared = a.filter((t) => setB.has(t)).length;
  return shared / (a.length + b.length - shared);
}

interface Indexes {
  byTicker: Map<string, FundSeries>;
  byName: Map<string, FundSeries>;
  byTokens: Map<string, FundSeries>;
  bySeriesId: Map<string, FundSeries>;
}

let indexes: Indexes | null = null;

function build(): Indexes {
  if (indexes) return indexes;

  const byTicker = new Map<string, FundSeries>();
  const byName = new Map<string, FundSeries>();
  const byTokens = new Map<string, FundSeries>();
  const bySeriesId = new Map<string, FundSeries>();

  for (const series of file.series) {
    bySeriesId.set(series.id, series);

    for (const ticker of series.tickers) {
      if (!byTicker.has(ticker)) byTicker.set(ticker, series);
    }

    const name = normalizeFundName(series.name);
    const tokens = fundTokenKey(series.name);

    // Prefer series that actually have a ticker — those are the tradeable ones
    // a user is likely to mean when two series share a normalized name.
    const better = (existing: FundSeries | undefined) =>
      !existing || (!existing.tickers.length && series.tickers.length > 0);

    if (name && better(byName.get(name))) byName.set(name, series);
    if (tokens && better(byTokens.get(tokens))) byTokens.set(tokens, series);
  }

  indexes = { byTicker, byName, byTokens, bySeriesId };
  return indexes;
}

export function fundIndexMeta(): { generatedAt: string; sourceYear: number } {
  return { generatedAt: file.generatedAt, sourceYear: file.sourceYear };
}

export function findSeriesByTicker(ticker: string): FundSeries | null {
  return build().byTicker.get(ticker.trim().toUpperCase()) ?? null;
}

export function findSeriesById(seriesId: string): FundSeries | null {
  return build().bySeriesId.get(seriesId) ?? null;
}

/**
 * Minimum token overlap for the fuzzy fallback, plus how far ahead of the
 * runner-up the winner must be. Funds get renamed between the register's annual
 * snapshot and a filing ("iShares Core Universal USD Bond ETF" is the register's
 * "iShares Core Total USD Bond Market ETF"), and without a fuzzy pass those
 * positions silently drop out of the look-through — 32% of AOR in that one case.
 * The margin requirement is what keeps it from grabbing a similarly-named
 * sibling fund.
 */
const FUZZY_MIN_SIMILARITY = 0.6;
const FUZZY_MIN_MARGIN = 0.08;

/** Resolve a fund name as reported inside an N-PORT filing to its series. */
export function findSeriesByName(name: string): FundSeries | null {
  if (!name || name === "N/A") return null;
  const idx = build();

  const exact = idx.byName.get(normalizeFundName(name));
  if (exact) return exact;

  const tokens = idx.byTokens.get(fundTokenKey(name));
  if (tokens) return tokens;

  const queryTokens = fundTokens(name);
  if (queryTokens.length < 3) return null;

  let best: FundSeries | null = null;
  let bestScore = 0;
  let runnerUp = 0;

  for (const series of file.series) {
    const score = similarity(queryTokens, fundTokens(series.name));
    if (score > bestScore) {
      runnerUp = bestScore;
      bestScore = score;
      best = series;
    } else if (score > runnerUp) {
      runnerUp = score;
    }
  }

  if (
    best &&
    bestScore >= FUZZY_MIN_SIMILARITY &&
    bestScore - runnerUp >= FUZZY_MIN_MARGIN
  ) {
    return best;
  }

  return null;
}

export interface FundSuggestion {
  ticker: string | null;
  name: string;
  entity: string;
  seriesId: string;
}

/** Ticker- and name-aware autocomplete for the search box. */
export function searchFunds(query: string, limit = 10): FundSuggestion[] {
  const q = query.trim();
  if (q.length < 2) return [];

  const upper = q.toUpperCase();
  const normalized = normalizeFundName(q);
  const idx = build();

  const exactTicker: FundSeries[] = [];
  const tickerPrefix: FundSeries[] = [];
  const nameMatch: FundSeries[] = [];

  for (const series of file.series) {
    if (series.tickers.includes(upper)) {
      exactTicker.push(series);
    } else if (series.tickers.some((t) => t.startsWith(upper))) {
      if (tickerPrefix.length < limit) tickerPrefix.push(series);
    } else if (
      nameMatch.length < limit * 2 &&
      normalized &&
      normalizeFundName(series.name).includes(normalized)
    ) {
      nameMatch.push(series);
    }

    if (exactTicker.length && tickerPrefix.length >= limit) break;
  }

  // Tradeable series first — a name-only series is usually an insurance
  // sub-account or a closed share class the user can't actually buy.
  nameMatch.sort((a, b) => b.tickers.length - a.tickers.length);

  return [...exactTicker, ...tickerPrefix, ...nameMatch]
    .slice(0, limit)
    .map((s) => ({
      ticker: s.tickers[0] ?? null,
      name: s.name,
      entity: s.entity,
      seriesId: s.id,
    }));
}
