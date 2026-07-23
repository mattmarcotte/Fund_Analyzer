import { cached, TTL } from "@/lib/cache";
import { secFetchJson } from "@/lib/sec/client";

const MF_TICKERS_URL = "https://www.sec.gov/files/company_tickers_mf.json";
const COMPANY_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";

interface MfTickersFile {
  fields: ["cik", "seriesId", "classId", "symbol"];
  data: [number, string, string, string][];
}

type CompanyTickersFile = Record<
  string,
  { cik_str: number; ticker: string; title: string }
>;

export interface FundIdentity {
  ticker: string;
  cik: string;
  seriesId: string;
  classId: string;
}

export interface CompanyIdentity {
  cik: string;
  ticker: string;
  title: string;
}

/** ticker -> fund series. One fund (series) can have many share classes. */
export async function fundTickerMap(): Promise<Map<string, FundIdentity>> {
  return cached("sec:mf-tickers", TTL.TICKER_MAP, async () => {
    const file = await secFetchJson<MfTickersFile>(MF_TICKERS_URL);
    const map = new Map<string, FundIdentity>();
    for (const [cik, seriesId, classId, symbol] of file.data) {
      if (!symbol) continue;
      map.set(symbol.toUpperCase(), {
        ticker: symbol.toUpperCase(),
        cik: String(cik),
        seriesId,
        classId,
      });
    }
    return map;
  });
}

export async function lookupFundTicker(
  ticker: string,
): Promise<FundIdentity | undefined> {
  const map = await fundTickerMap();
  return map.get(ticker.trim().toUpperCase());
}

/** All operating-company tickers, used to resolve holdings to a CIK. */
export async function companyList(): Promise<CompanyIdentity[]> {
  return cached("sec:company-tickers", TTL.TICKER_MAP, async () => {
    const file = await secFetchJson<CompanyTickersFile>(COMPANY_TICKERS_URL);
    return Object.values(file).map((c) => ({
      cik: String(c.cik_str),
      ticker: c.ticker,
      title: c.title,
    }));
  });
}

/**
 * Fuzzy ticker suggestions for the search box. Matches on ticker prefix first,
 * then on fund-name substring.
 */
export async function suggestFunds(
  query: string,
  limit = 8,
): Promise<{ ticker: string; seriesId: string }[]> {
  const q = query.trim().toUpperCase();
  if (q.length < 1) return [];

  const map = await fundTickerMap();
  const starts: FundIdentity[] = [];
  const contains: FundIdentity[] = [];

  for (const entry of map.values()) {
    if (entry.ticker === q) {
      starts.unshift(entry);
    } else if (entry.ticker.startsWith(q)) {
      starts.push(entry);
    } else if (starts.length + contains.length < limit * 4 && entry.ticker.includes(q)) {
      contains.push(entry);
    }
    if (starts.length >= limit) break;
  }

  return [...starts, ...contains]
    .slice(0, limit)
    .map(({ ticker, seriesId }) => ({ ticker, seriesId }));
}
