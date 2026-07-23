import igIndexRaw from "@/data/ig-index.json";
import { cached, TTL } from "@/lib/cache";
import { toAssetClass } from "@/lib/sec/assetClass";
import {
  FundLookupError,
  type AssetCategory,
  type Breakdown,
  type FundSnapshot,
  type Holding,
  type PublishedBreakdowns,
} from "@/lib/types";

/**
 * IG Wealth Management unit trust funds.
 *
 * IG publishes two regulatory PDFs per fund at stable, predictable paths keyed
 * by an internal fund code:
 *
 *   - Summary of Investment Portfolio — asset/regional/sector allocation and
 *     the top 25 positions. Uniform across every fund, so it always parses.
 *   - Annual/Interim Financial Report — the full schedule of investments, with
 *     country and GICS sector already labelled per holding.
 *
 * We read the summary for the headline allocations (they're the manager's own
 * published figures, so they're authoritative) and the financial report for the
 * complete holdings list. If the schedule can't be parsed — bond funds use a
 * different column layout — we fall back to the top 25 and say so.
 *
 * Fund codes come from data/ig-index.json, built by `npm run update-ig`. The
 * running app never crawls ig.ca; it fetches one PDF for the requested fund.
 */

const DOC_BASE =
  "https://www.ig.ca/content/dam/investorsgroup/legacy/en/documents/corp/regulatory";

const USER_AGENT =
  "FundAnalyzer/0.1 (personal portfolio analysis tool)";

interface IgFund {
  slug: string;
  name: string;
  code: string;
}

const igIndex = igIndexRaw as { generatedAt: string; funds: IgFund[] };

/** GICS sectors as IG labels them — used to anchor row parsing. */
const SECTORS = [
  "Communication Services",
  "Consumer Discretionary",
  "Consumer Staples",
  "Energy",
  "Financials",
  "Health Care",
  "Industrials",
  "Information Technology",
  "Materials",
  "Real Estate",
  "Utilities",
];

/**
 * Countries appearing in IG schedules. An explicit list beats a lazy pattern:
 * holding names routinely end in capitalised words ("Shell PLC-W/I ADR
 * Netherlands"), so without a closed set the name/country boundary is ambiguous.
 */
const COUNTRIES = [
  "Argentina", "Australia", "Austria", "Bahamas", "Belgium", "Bermuda",
  "Brazil", "Canada", "Cayman Islands", "Chile", "China", "Colombia",
  "Cyprus", "Czech Republic", "Denmark", "Egypt", "Finland", "France",
  "Germany", "Ghana", "Greece", "Guernsey", "Hong Kong", "Hungary",
  "India", "Indonesia", "Ireland", "Isle of Man", "Israel", "Italy",
  "Japan", "Jersey", "Kazakhstan", "Kenya", "Luxembourg", "Malaysia",
  "Malta", "Mauritius", "Mexico", "Monaco", "Mongolia", "Morocco",
  "Netherlands", "New Zealand", "Nigeria", "Norway", "Panama", "Peru",
  "Philippines", "Poland", "Portugal", "Qatar", "Romania", "Russia",
  "Saudi Arabia", "Singapore", "South Africa", "South Korea", "Spain",
  "Sweden", "Switzerland", "Taiwan", "Tanzania", "Thailand", "Turkey",
  "Ukraine", "United Arab Emirates", "United Kingdom", "United States",
  "Uruguay", "Vietnam", "Zambia",
];

function alternation(values: string[]): string {
  // Longest first so "United States" wins over a hypothetical "United".
  return [...values]
    .sort((a, b) => b.length - a.length)
    .map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
}

function toNumber(raw: string): number {
  // IG prints an en dash for nil values.
  if (/^[–—-]$/.test(raw.trim())) return 0;
  const n = Number(raw.replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export function findIgFund(query: string): IgFund | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;

  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const nq = normalize(q);

  return (
    igIndex.funds.find((f) => f.code.toLowerCase() === q) ??
    igIndex.funds.find((f) => f.slug === q) ??
    igIndex.funds.find((f) => normalize(f.name) === nq) ??
    igIndex.funds.find((f) => normalize(f.name).includes(nq) && nq.length >= 6) ??
    null
  );
}

export function searchIgFunds(query: string, limit = 8): IgFund[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  return igIndex.funds
    .filter(
      (f) =>
        f.name.toLowerCase().includes(q) || f.code.toLowerCase() === q,
    )
    .slice(0, limit);
}

export function allIgFunds(): IgFund[] {
  return igIndex.funds;
}

async function fetchPdfText(url: string): Promise<string | null> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    cache: "no-store",
  });
  if (!res.ok) return null;

  const buf = new Uint8Array(await res.arrayBuffer());
  // Imported lazily: unpdf pulls in a sizeable pdf.js build we don't want on
  // the module graph for SEC-only requests.
  const { extractText, getDocumentProxy } = await import("unpdf");
  const { text } = await extractText(await getDocumentProxy(buf), {
    mergePages: true,
  });
  return text;
}

/** `Label 12.3 Label 4.5 …` pairs from one section of the summary PDF. */
function parseAllocationSection(text: string): Breakdown[] {
  const out = new Map<string, number>();
  const re = /([A-Za-z][A-Za-z0-9 ,.'&()\/-]*?)\s+(\d+\.\d)(?=\s|$)/g;

  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const label = m[1].replace(/\*+$/, "").trim();
    if (!label || label.length > 60) continue;
    // Later occurrences win: IG prints a group subtotal ("Equities 98.1")
    // followed by its components ("Equities 96.8", "Purchased options 1.3").
    // Keeping the component avoids double-counting the group.
    out.set(label, Number(m[2]));
  }

  return [...out.entries()]
    .map(([label, pct]) => ({ label, pct, valueUsd: 0, count: 0 }))
    .filter((b) => b.pct > 0)
    .sort((a, b) => b.pct - a.pct);
}

interface SummaryData {
  published: PublishedBreakdowns;
  topHoldings: { name: string; pct: number }[];
  navMillions: number | null;
  asOf: string | null;
}

function parseSummaryPdf(text: string): SummaryData {
  const section = (start: RegExp, end: RegExp): string => {
    const s = text.search(start);
    if (s < 0) return "";
    const rest = text.slice(s);
    const e = rest.slice(1).search(end);
    return e < 0 ? rest : rest.slice(0, e + 1);
  };

  const portfolio = section(
    /PORTFOLIO ALLOCATION/i,
    /REGIONAL ALLOCATION|SECTOR ALLOCATION|TOP \d+ POSITIONS/i,
  ).replace(/PORTFOLIO ALLOCATION\s*%?\s*OF NAV/i, "");

  const regional = section(
    /REGIONAL ALLOCATION/i,
    /SECTOR ALLOCATION|TOP \d+ POSITIONS/i,
  ).replace(/REGIONAL ALLOCATION\s*%?\s*OF NAV/i, "");

  const sector = section(/SECTOR ALLOCATION/i, /TOP \d+ POSITIONS/i).replace(
    /SECTOR ALLOCATION\s*%?\s*OF NAV/i,
    "",
  );

  const top = section(
    /TOP \d+ POSITIONS/i,
    /Top long positions as a percentage/i,
  )
    .replace(/TOP \d+ POSITIONS\s*%?\s*OF NAV/i, "")
    .replace(/\bIssuer\b/i, "");

  const navMatch = /Total net asset value of the Fund\s*\$?([\d.,]+)\s*(million|billion)/i.exec(
    text,
  );
  const navMillions = navMatch
    ? Number(navMatch[1].replace(/,/g, "")) *
      (navMatch[2].toLowerCase() === "billion" ? 1000 : 1)
    : null;

  const asOfMatch = /As at ([A-Z][a-z]+ \d{1,2}, \d{4})/.exec(text);

  return {
    published: {
      assetAllocation: parseAllocationSection(portfolio),
      regional: parseAllocationSection(regional),
      sector: parseAllocationSection(sector),
      asOf: asOfMatch ? asOfMatch[1] : null,
    },
    topHoldings: parseAllocationSection(top).map((b) => ({
      name: b.label,
      pct: b.pct,
    })),
    navMillions,
    asOf: asOfMatch ? asOfMatch[1] : null,
  };
}

/**
 * Full schedule of investments. Each row is
 * `Name Country Sector Shares AverageCost FairValue`, with values in $000.
 */
function parseSchedulePdf(text: string): { holdings: Holding[]; asOf: string | null } {
  const start = text.search(/SCHEDULE OF INVESTMENTS/i);
  if (start < 0) return { holdings: [], asOf: null };

  // The financial report is struck at the fiscal year end, which is a different
  // date from the quarterly summary. Both dates get shown rather than merged.
  const asOf = /as at ([A-Z][a-z]+ \d{1,2}, \d{4})/i.exec(text)?.[1] ?? null;

  const body = text
    .slice(start)
    // Page furniture repeats between rows and would otherwise be absorbed into
    // the following holding's name.
    .replace(/(ANNUAL|INTERIM)[A-Z ]*FINANCIAL STATEMENTS\s*\|[^A-Z]*/gi, " ")
    .replace(/SCHEDULE OF INVESTMENTS\s*(\(cont’d\)|\(cont'd\))?/gi, " ")
    .replace(/EQUITIES\s*(\(cont’d\)|\(cont'd\))?/gi, " ")
    .replace(
      /Investment Name\s+Country\s+Sector\s+Par Value\/\s*Number of Shares\/Units\s+Average Cost\s*\(\$ 000\)\s+Fair Value\s*\(\$ 000\)/gi,
      " ",
    )
    .replace(/as at [A-Z][a-z]+ \d{1,2}, \d{4}/gi, " ");

  const re = new RegExp(
    String.raw`([^\d].*?)\s+(${alternation(COUNTRIES)})\s+(${alternation(
      SECTORS,
    )})\s+([\d,]+|[–—-])\s+([\d,]+|[–—-])\s+([\d,]+|[–—-])`,
    "g",
  );

  const holdings: Holding[] = [];
  let m: RegExpExecArray | null;
  let index = 0;

  while ((m = re.exec(body)) !== null) {
    const name = m[1]
      // Footnote superscripts trail the previous row's value and lead into this
      // row's name.
      .replace(/^[\d\s.,]+/, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!name || name.length > 120) continue;

    const value = toNumber(m[6]);
    if (value <= 0) continue;

    const assetCat: AssetCategory = "EC";

    holdings.push({
      id: `ig-${index}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`,
      name,
      title: null,
      cusip: null,
      isin: null,
      lei: null,
      ticker: null,
      // Filled in once we know the portfolio total.
      pct: 0,
      valueUsd: value * 1000,
      balance: toNumber(m[4]),
      units: "NS",
      currency: "CAD",
      assetCat,
      assetClass: toAssetClass(assetCat),
      issuerCat: "CORP",
      country: m[2],
      payoffProfile: "Long",
      isFund: false,
      // IG labels the sector in the filing itself, so no SIC lookup needed.
      sector: m[3],
      industry: null,
      sicCode: null,
    });
    index++;
  }

  const total = holdings.reduce((sum, h) => sum + h.valueUsd, 0);
  if (total > 0) {
    for (const h of holdings) h.pct = (h.valueUsd / total) * 100;
  }

  return { holdings: holdings.sort((a, b) => b.pct - a.pct), asOf };
}

export async function fetchIgSnapshot(query: string): Promise<FundSnapshot> {
  const fund = findIgFund(query);
  if (!fund) {
    throw new FundLookupError(
      `"${query}" isn't an IG Wealth Management fund we know about`,
      "UNKNOWN_TICKER",
      "Try the full fund name, e.g. \"IG Mackenzie Canadian Equity Fund\".",
    );
  }

  return cached(`ig:snapshot:${fund.code}`, TTL.FILING, async () => {
    // The summary is the one document guaranteed to parse, so it gates success.
    const summaryText = await fetchPdfText(
      `${DOC_BASE}/summary-investment-portfolio/dec-31/${fund.code}.pdf`,
    );

    if (!summaryText) {
      throw new FundLookupError(
        `IG's portfolio disclosure for ${fund.name} could not be retrieved`,
        "UPSTREAM_ERROR",
        "The document may have moved. Re-run `npm run update-ig` to refresh fund codes.",
      );
    }

    const summary = parseSummaryPdf(summaryText);

    // The full schedule is a bonus — bond funds use a different layout and
    // legitimately yield nothing here.
    let holdings: Holding[] = [];
    let holdingsAsOf: string | null = null;
    try {
      const scheduleText = await fetchPdfText(
        `${DOC_BASE}/fund-financial-statements/annual/${fund.code}.pdf`,
      );
      if (scheduleText) {
        const parsed = parseSchedulePdf(scheduleText);
        holdings = parsed.holdings;
        holdingsAsOf = parsed.asOf;
      }
    } catch {
      // Fall through to the top-25 list below.
    }

    const holdingsArePartial = holdings.length === 0;

    if (holdingsArePartial) {
      holdings = summary.topHoldings.map((h, i) => ({
        id: `ig-top-${i}`,
        name: h.name,
        title: null,
        cusip: null,
        isin: null,
        lei: null,
        ticker: null,
        pct: h.pct,
        valueUsd:
          summary.navMillions !== null
            ? (h.pct / 100) * summary.navMillions * 1e6
            : 0,
        balance: null,
        units: null,
        currency: "CAD",
        assetCat: "EC",
        assetClass: "Equity",
        issuerCat: "CORP",
        country: null,
        payoffProfile: "Long",
        isFund: false,
        sector: null,
        industry: null,
        sicCode: null,
      }));
    }

    return {
      meta: {
        ticker: fund.code,
        registrantName: "IG Wealth Management",
        seriesName: fund.name,
        seriesId: fund.code,
        cik: "",
        classId: null,
        asOf: holdingsAsOf ?? summary.asOf,
        filedAt: null,
        accession: null,
        filingUrl: `https://www.ig.ca/en/investments/solutions/mutual-funds/${fund.slug}`,
        totalAssets: summary.navMillions ? summary.navMillions * 1e6 : null,
        netAssets: summary.navMillions ? summary.navMillions * 1e6 : null,
        source: "ig-wealth",
        currency: "CAD",
        sourceLabel: "IG Wealth Management regulatory disclosure",
      },
      holdings,
      totalPct: holdings.reduce((sum, h) => sum + Math.abs(h.pct), 0),
      published: summary.published,
      holdingsArePartial,
    };
  });
}
