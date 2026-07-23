import { cleanText, parseCsv, toIsoDate, toNumber } from "@/lib/ingest/csv";
import type {
  EtfProvider,
  HoldingsLayer,
  HoldingsSet,
  ProviderFund,
  RawHolding,
} from "@/lib/ingest/types";

/**
 * iShares Canada (BlackRock).
 *
 * The largest Canadian ETF issuer — XIU, XIC, XEQT, XGRO, XBAL, XSP, XUU and
 * ~170 others. Two published endpoints do all the work:
 *
 *  1. A product-screener JSON listing every fund with its product id and AUM.
 *  2. A per-product holdings CSV whose path is *derivable* — the numeric ajax
 *     segment is identical across every product, verified across the range —
 *     so no per-fund page fetch is needed.
 *
 * The CSV is refreshed daily, and carries GICS sector, asset class, country,
 * shares and price per holding. That is materially better than SEC N-PORT,
 * which lags up to 60 days and omits sector entirely.
 *
 * robots.txt permits these paths (only sign-on and a few iframe routes are
 * disallowed). Requests identify the tool honestly and are rate-limited.
 */

const ORIGIN = "https://www.blackrock.com";

const SCREENER_URL =
  `${ORIGIN}/ca/investors/en/product-screener/product-screener-v3.1.jsn` +
  `?dcrPath=/templatedata/config/product-screener-v3/data/en/ca-one/product-screener-backend-config` +
  `&siteEntryPassthrough=true`;

/**
 * Constant across every iShares Canada product. If BlackRock ever rotates it,
 * every holdings fetch 404s at once — which the CLI reports per fund rather
 * than failing silently.
 */
const HOLDINGS_AJAX_ID = "1464253357814";

const USER_AGENT = "FundAnalyzer/0.1 (personal portfolio analysis tool)";

/** Politeness delay between requests. */
const DELAY_MS = 350;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ScreenerEntry {
  localExchangeTicker?: string;
  fundName?: string;
  productPageUrl?: string;
  aladdinAssetClass?: string;
  inceptionDate?: { r?: number | string };
  totalNetAssets?: { r?: number };
  mer?: { r?: number };
}

async function get(url: string, accept: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: accept },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

function holdingsUrl(productPageUrl: string, ticker: string): string {
  return (
    `${ORIGIN}${productPageUrl}/${HOLDINGS_AJAX_ID}.ajax` +
    `?fileType=csv&fileName=${encodeURIComponent(ticker)}_holdings&dataType=fund`
  );
}

/**
 * Splits a holdings CSV into its sections.
 *
 * A plain fund's file has one section. A fund-of-funds has two, each
 * introduced by its own `Fund Holdings as of,"<date>"` banner: first the ETFs
 * the fund directly owns, then the look-through to the underlying securities.
 * Treating the file as one table sums both and yields ~193% for XEQT.
 */
function splitSections(text: string): { asOf: string; rows: string[][] }[] {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  const sections: { asOf: string; rows: string[][] }[] = [];

  let current: { asOf: string; rows: string[][] } | null = null;
  let header: string[] | null = null;

  for (const row of rows) {
    const first = (row[0] ?? "").trim();

    if (/^Fund Holdings as of$/i.test(first)) {
      current = { asOf: toIsoDate(row[1] ?? null), rows: [] };
      header = null;
      sections.push(current);
      continue;
    }

    if (!current) continue;

    if (first === "Ticker") {
      header = row.map((c) => c.trim());
      current.rows.push(header);
      continue;
    }

    // Trailing disclaimer prose has no ticker and far fewer columns.
    if (header && first && row.length >= header.length - 3) {
      current.rows.push(row);
    }
  }

  return sections.filter((s) => s.rows.length > 1);
}

const KNOWN_COLUMNS = new Set([
  "Ticker",
  "Name",
  "Sector",
  "Asset Class",
  "Market Value",
  "Weight (%)",
  "Notional Value",
  "Shares",
  "Par Value",
  "Price",
  "Location",
  "Exchange",
  "Currency",
  "FX Rate",
  "Market Currency",
  "ISIN",
  "CUSIP",
  "SEDOL",
]);

function toHoldings(rows: string[][]): RawHolding[] {
  const header = rows[0].map((h) => h.trim());
  const at = (row: string[], col: string) => {
    const i = header.indexOf(col);
    return i >= 0 ? row[i] : undefined;
  };

  const out: RawHolding[] = [];

  for (const [i, row] of rows.slice(1).entries()) {
    const name = cleanText(at(row, "Name"));
    if (!name) continue;

    // Bond funds add Duration/YTM/Coupon/Maturity; keep rather than discard.
    const extra: Record<string, string> = {};
    for (const [j, col] of header.entries()) {
      if (!KNOWN_COLUMNS.has(col)) {
        const v = cleanText(row[j]);
        if (v) extra[col] = v;
      }
    }

    out.push({
      position: i + 1,
      ticker: cleanText(at(row, "Ticker")),
      name,
      sector: cleanText(at(row, "Sector")),
      assetClass: cleanText(at(row, "Asset Class")),
      weight: toNumber(at(row, "Weight (%)")),
      marketValue: toNumber(at(row, "Market Value")),
      shares: toNumber(at(row, "Shares")),
      price: toNumber(at(row, "Price")),
      country: cleanText(at(row, "Location")),
      exchange: cleanText(at(row, "Exchange")),
      currency: cleanText(at(row, "Currency")),
      isin: cleanText(at(row, "ISIN")),
      cusip: cleanText(at(row, "CUSIP")),
      extra: Object.keys(extra).length ? extra : null,
    });
  }

  return out;
}

export const isharesCa: EtfProvider = {
  id: "ishares-ca",
  label: "iShares Canada (BlackRock)",

  async listFunds(): Promise<ProviderFund[]> {
    const raw = await get(SCREENER_URL, "application/json");
    const parsed = JSON.parse(raw) as Record<string, ScreenerEntry>;

    const funds: ProviderFund[] = [];

    for (const [productId, entry] of Object.entries(parsed)) {
      const ticker = entry.localExchangeTicker?.trim();
      const pageUrl = entry.productPageUrl?.trim();
      if (!ticker || !pageUrl || !entry.fundName) continue;

      const inception = entry.inceptionDate?.r;
      const inceptionDate =
        inception !== undefined && inception !== null
          ? // Reported as YYYYMMDD.
            String(inception).replace(/^(\d{4})(\d{2})(\d{2}).*$/, "$1-$2-$3")
          : null;

      funds.push({
        ticker,
        name: entry.fundName.trim(),
        providerFundId: productId,
        exchange: "TSX",
        currency: "CAD",
        assetClass: entry.aladdinAssetClass?.trim() ?? null,
        aum: entry.totalNetAssets?.r ?? null,
        managementFee: entry.mer?.r ?? null,
        inceptionDate: /^\d{4}-\d{2}-\d{2}$/.test(inceptionDate ?? "")
          ? inceptionDate
          : null,
        holdingsUrl: holdingsUrl(pageUrl, ticker),
      });
    }

    return funds.sort((a, b) => (b.aum ?? 0) - (a.aum ?? 0));
  },

  async fetchHoldings(fund: ProviderFund): Promise<HoldingsSet[]> {
    await sleep(DELAY_MS);
    const csv = await get(fund.holdingsUrl, "text/csv");
    const sections = splitSections(csv);

    return sections.map((section, i) => {
      // Section order is the provider's: direct holdings first, look-through
      // second where published.
      const layer: HoldingsLayer = i === 0 ? "direct" : "lookthrough";
      return {
        layer,
        asOf: section.asOf,
        sourceUrl: fund.holdingsUrl,
        holdings: toHoldings(section.rows),
      };
    });
  },
};
