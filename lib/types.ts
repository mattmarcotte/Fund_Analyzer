/**
 * Asset classes as reported in N-PORT `assetCat`. The SEC's own code list —
 * we keep the raw code and map to display labels rather than inventing our own
 * taxonomy, so the numbers always tie back to the filing.
 */
export type AssetCategory =
  | "EC" // equity-common
  | "EP" // equity-preferred
  | "DBT" // debt
  | "ABS-MBS"
  | "ABS-ABSCDO"
  | "ABS-O"
  | "ACOM" // commodity
  | "COMM"
  | "DE" // derivative
  | "RE" // real estate
  | "LON" // loan
  | "SN" // structured note
  | "STIV" // short-term investment vehicle (money market / sweep)
  | "RA" // repurchase agreement
  | "UST"
  | "OTHER";

/** Broad buckets we roll `assetCat` up into for the headline allocation chart. */
export type AssetClass =
  | "Equity"
  | "Fixed Income"
  | "Cash & Equivalents"
  | "Real Estate"
  | "Commodities"
  | "Derivatives"
  | "Other";

/**
 * Issuer categories from N-PORT `issuerCat`. `RF` (registered fund) is the one
 * that matters most here — it marks a holding that is itself a fund, and is
 * therefore a look-through candidate.
 */
export type IssuerCategory =
  | "CORP"
  | "UST"
  | "USGSE"
  | "MUN"
  | "NUSS"
  | "RF"
  | "PF"
  | "GSE"
  | "OTHER";

export interface Holding {
  /** Stable id derived from cusip/isin/lei/name — used as React key and cache key. */
  id: string;
  name: string;
  title: string | null;
  cusip: string | null;
  isin: string | null;
  lei: string | null;
  ticker: string | null;
  /** Percent of the fund's net assets, 0-100. */
  pct: number;
  /** Market value in USD. */
  valueUsd: number;
  balance: number | null;
  units: string | null;
  currency: string | null;
  assetCat: AssetCategory;
  assetClass: AssetClass;
  issuerCat: IssuerCategory;
  /** ISO-3166 alpha-2, as reported. */
  country: string | null;
  /** Long or Short. Shorts carry a negative `pct` in the filing. */
  payoffProfile: string | null;
  /** True when this holding is itself a fund we can drill into. */
  isFund: boolean;
  /** Populated by sector enrichment; null until resolved or if unresolvable. */
  sector: string | null;
  industry: string | null;
  sicCode: string | null;
}

export interface FundMeta {
  ticker: string;
  /** Registrant (the trust), e.g. "VANGUARD INDEX FUNDS". */
  registrantName: string;
  /** The specific fund, e.g. "VANGUARD 500 INDEX FUND". */
  seriesName: string;
  seriesId: string;
  cik: string;
  classId: string | null;
  /** Reporting period end date the holdings are as of. */
  asOf: string | null;
  /** Date the filing was accepted by EDGAR. */
  filedAt: string | null;
  accession: string | null;
  filingUrl: string | null;
  totalAssets: number | null;
  netAssets: number | null;
  source: "sec-edgar" | "ig-wealth" | "ishares-ca";
  /** Currency the reported values are denominated in. */
  currency: "USD" | "CAD";
  /** Human label for where the numbers came from, shown in the UI. */
  sourceLabel: string;
}

/**
 * Allocations a fund publishes itself. When present these are authoritative and
 * preferred over anything we derive from the holdings list — they come straight
 * from the manager's regulatory disclosure and account for positions our
 * holdings parse may not fully capture.
 */
export interface PublishedBreakdowns {
  assetAllocation: Breakdown[];
  regional: Breakdown[];
  sector: Breakdown[];
  /**
   * Effective date of these figures. Often differs from the holdings' as-of
   * date — quarterly disclosures and annual financial reports are struck on
   * different calendars — so the UI labels each separately.
   */
  asOf: string | null;
}

export interface FundSnapshot {
  meta: FundMeta;
  holdings: Holding[];
  /** Sum of |pct| across holdings — sanity check that the filing parsed fully. */
  totalPct: number;
  /** Set when the manager publishes its own allocations (IG). */
  published?: PublishedBreakdowns;
  /**
   * True when `holdings` is a partial list (e.g. a top-25 disclosure) rather
   * than the complete portfolio. The UI must say so rather than implying the
   * remainder doesn't exist.
   */
  holdingsArePartial: boolean;
}

/** One node in the look-through tree. */
export interface LookThroughNode {
  holding: Holding;
  /** Weight within the *root* portfolio, 0-100, after multiplying down the chain. */
  effectivePct: number;
  depth: number;
  /** Path of fund tickers/names from the root down to this node's parent. */
  path: string[];
  children: LookThroughNode[] | null;
  /** Set when a fund holding could not be expanded, with the reason. */
  expansionError: string | null;
}

export interface Breakdown {
  label: string;
  pct: number;
  valueUsd: number;
  count: number;
}

export class FundLookupError extends Error {
  constructor(
    message: string,
    readonly code:
      | "UNKNOWN_TICKER"
      | "NO_FILINGS"
      | "PARSE_FAILED"
      | "UPSTREAM_ERROR",
    readonly hint?: string,
  ) {
    super(message);
    this.name = "FundLookupError";
  }
}
