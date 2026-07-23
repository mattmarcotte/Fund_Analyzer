import { cached, TTL } from "@/lib/cache";
import { secFetch } from "@/lib/sec/client";
import { tagText } from "@/lib/sec/xml";

/**
 * SIC -> sector.
 *
 * EDGAR assigns every registrant a SIC code, which is free and authoritative
 * but predates modern sector schemes. This maps it onto GICS-style sectors so
 * the charts read the way an investor expects. Four-digit overrides come first
 * (they capture the cases where SIC's industrial-era grouping diverges sharply
 * from GICS — pharma sitting under "Chemicals", software under "Business
 * Services"), then we fall back to the two-digit major group.
 */

const SECTOR_BY_SIC_CODE: Record<string, string> = {
  // Pharma & biotech live under SIC 28 "Chemicals"
  "2833": "Health Care",
  "2834": "Health Care",
  "2835": "Health Care",
  "2836": "Health Care",
  // Computers & IT hardware under SIC 35 "Industrial Machinery"
  "3570": "Information Technology",
  "3571": "Information Technology",
  "3572": "Information Technology",
  "3575": "Information Technology",
  "3576": "Information Technology",
  "3577": "Information Technology",
  "3578": "Information Technology",
  "3579": "Information Technology",
  // Semiconductors & electronics under SIC 36
  "3661": "Information Technology",
  "3663": "Information Technology",
  "3669": "Information Technology",
  "3670": "Information Technology",
  "3672": "Information Technology",
  "3674": "Information Technology",
  "3677": "Information Technology",
  "3678": "Information Technology",
  "3679": "Information Technology",
  // Motor vehicles under SIC 37 "Transportation Equipment"
  "3711": "Consumer Discretionary",
  "3713": "Consumer Discretionary",
  "3714": "Consumer Discretionary",
  "3716": "Consumer Discretionary",
  "3751": "Consumer Discretionary",
  // Medical devices & lab instruments under SIC 38 "Instruments"
  "3826": "Health Care",
  "3827": "Health Care",
  "3841": "Health Care",
  "3842": "Health Care",
  "3843": "Health Care",
  "3844": "Health Care",
  "3845": "Health Care",
  "3851": "Health Care",
  // Drug wholesale / drug stores
  "5122": "Health Care",
  "5912": "Consumer Staples",
  // REITs sit inside SIC 67 "Holding & Investment Offices"
  "6798": "Real Estate",
  // Advertising & media under SIC 73 "Business Services"
  "7310": "Communication Services",
  "7311": "Communication Services",
  "7312": "Communication Services",
  // Commercial physical & biological research (CROs, biotech services)
  "8731": "Health Care",
};

const SECTOR_BY_MAJOR_GROUP: Record<string, string> = {
  "01": "Consumer Staples",
  "02": "Consumer Staples",
  "07": "Consumer Staples",
  "08": "Materials",
  "09": "Consumer Staples",
  "10": "Materials",
  "12": "Energy",
  "13": "Energy",
  "14": "Materials",
  "15": "Industrials",
  "16": "Industrials",
  "17": "Industrials",
  "20": "Consumer Staples",
  "21": "Consumer Staples",
  "22": "Consumer Discretionary",
  "23": "Consumer Discretionary",
  "24": "Materials",
  "25": "Consumer Discretionary",
  "26": "Materials",
  "27": "Communication Services",
  "28": "Materials",
  "29": "Energy",
  "30": "Materials",
  "31": "Consumer Discretionary",
  "32": "Materials",
  "33": "Materials",
  "34": "Industrials",
  "35": "Industrials",
  "36": "Information Technology",
  "37": "Industrials",
  "38": "Health Care",
  "39": "Consumer Discretionary",
  "40": "Industrials",
  "41": "Industrials",
  "42": "Industrials",
  "44": "Industrials",
  "45": "Industrials",
  "46": "Energy",
  "47": "Industrials",
  "48": "Communication Services",
  "49": "Utilities",
  "50": "Industrials",
  "51": "Industrials",
  "52": "Consumer Discretionary",
  "53": "Consumer Discretionary",
  "54": "Consumer Staples",
  "55": "Consumer Discretionary",
  "56": "Consumer Discretionary",
  "57": "Consumer Discretionary",
  "58": "Consumer Discretionary",
  "59": "Consumer Discretionary",
  "60": "Financials",
  "61": "Financials",
  "62": "Financials",
  "63": "Financials",
  "64": "Financials",
  "65": "Real Estate",
  "67": "Financials",
  "70": "Consumer Discretionary",
  "72": "Consumer Discretionary",
  "73": "Information Technology",
  "75": "Consumer Discretionary",
  "76": "Industrials",
  "78": "Communication Services",
  "79": "Communication Services",
  "80": "Health Care",
  "81": "Industrials",
  "82": "Consumer Discretionary",
  "83": "Health Care",
  "87": "Industrials",
  "89": "Industrials",
  "99": "Other",
};

export const SECTORS = [
  "Information Technology",
  "Financials",
  "Health Care",
  "Consumer Discretionary",
  "Communication Services",
  "Industrials",
  "Consumer Staples",
  "Energy",
  "Utilities",
  "Real Estate",
  "Materials",
  "Other",
] as const;

/**
 * Per-issuer corrections where SIC and GICS disagree materially.
 *
 * SIC was designed for an industrial economy and assigns whole categories in
 * ways modern sector schemes don't: Alphabet and Meta are "computer programming
 * and data processing" (SIC 7370) but sit in Communication Services under GICS,
 * and the card networks are "business services" (7389) but are Financials.
 * These are large index constituents, so leaving them mis-bucketed visibly
 * inflates Information Technology — roughly 48% vs the ~33% an investor expects
 * for the S&P 500.
 *
 * Deliberately limited to names big enough to move a chart. The general SIC
 * mapping handles the long tail, and the UI labels the sector chart as
 * SIC-derived so the residual imprecision is disclosed rather than hidden.
 */
const SECTOR_OVERRIDES_BY_TICKER: Record<string, string> = {
  GOOGL: "Communication Services",
  GOOG: "Communication Services",
  META: "Communication Services",
  NFLX: "Communication Services",
  DIS: "Communication Services",
  TMUS: "Communication Services",
  EA: "Communication Services",
  TTWO: "Communication Services",
  V: "Financials",
  MA: "Financials",
  PYPL: "Financials",
  AXP: "Financials",
  FI: "Financials",
  FIS: "Financials",
  GPN: "Financials",
  COIN: "Financials",
  ABNB: "Consumer Discretionary",
  UBER: "Industrials",
  DASH: "Consumer Discretionary",
  BKNG: "Consumer Discretionary",
  EBAY: "Consumer Discretionary",
  AMZN: "Consumer Discretionary",
  TSLA: "Consumer Discretionary",
};

export function sectorOverrideForTicker(
  ticker: string | null | undefined,
): string | null {
  if (!ticker) return null;
  return SECTOR_OVERRIDES_BY_TICKER[ticker.trim().toUpperCase()] ?? null;
}

export function sectorForSic(sic: string | null): string | null {
  if (!sic) return null;
  const code = sic.padStart(4, "0");
  return (
    SECTOR_BY_SIC_CODE[code] ?? SECTOR_BY_MAJOR_GROUP[code.slice(0, 2)] ?? null
  );
}

export interface SicInfo {
  sic: string | null;
  /** EDGAR's own industry description, e.g. "Electronic Computers". */
  description: string | null;
}

/**
 * EDGAR's atom company feed carries the assigned SIC in ~15KB, versus the
 * multi-megabyte submissions JSON. Cached aggressively — a company's SIC is
 * effectively immutable.
 */
export async function fetchSicForCik(cik: string): Promise<SicInfo> {
  return cached(`sic:${cik}`, TTL.SIC, async () => {
    const params = new URLSearchParams({
      action: "getcompany",
      CIK: cik,
      type: "10-K",
      dateb: "",
      owner: "include",
      count: "1",
      output: "atom",
    });

    try {
      const atom = await secFetch(
        `https://www.sec.gov/cgi-bin/browse-edgar?${params}`,
        { retries: 1 },
      );
      const sic = tagText(atom, "assigned-sic");
      const description = tagText(atom, "assigned-sic-desc");
      return { sic, description: description ? titleCase(description) : null };
    } catch {
      // A single company failing to resolve shouldn't fail the whole fund.
      return { sic: null, description: null };
    }
  });
}

function titleCase(input: string): string {
  return input
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\bAnd\b/g, "and")
    .replace(/\bOf\b/g, "of")
    .replace(/\bThe\b/g, "the");
}
