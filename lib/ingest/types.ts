/**
 * Provider adapter contract for the holdings ingestion pipeline.
 *
 * Adding an issuer means implementing this interface and registering it in
 * `lib/ingest/providers/index.ts`. Nothing in the CLI or the database layer
 * needs to change.
 */

export interface ProviderFund {
  /** Exchange ticker, e.g. "XEQT". */
  ticker: string;
  name: string;
  /** The provider's own identifier, needed to rebuild the holdings URL later. */
  providerFundId: string;
  exchange: string;
  currency: string;
  assetClass: string | null;
  /** Assets under management, for ranking funds by size. */
  aum: number | null;
  managementFee: number | null;
  inceptionDate: string | null;
  holdingsUrl: string;
}

export interface RawHolding {
  position: number;
  ticker: string | null;
  name: string;
  sector: string | null;
  assetClass: string | null;
  /** Percent of fund, 0-100. */
  weight: number | null;
  marketValue: number | null;
  shares: number | null;
  price: number | null;
  country: string | null;
  exchange: string | null;
  currency: string | null;
  isin: string | null;
  cusip: string | null;
  /** Provider-specific columns worth keeping (duration, YTM, coupon, maturity). */
  extra: Record<string, string> | null;
}

/**
 * One layer of a fund's holdings.
 *
 * `direct` is what the fund itself owns. `lookthrough` is the underlying
 * securities behind any funds it holds, published by the provider. They are
 * stored separately because their weights both total ~100% — summing them
 * double-counts the portfolio.
 */
export type HoldingsLayer = "direct" | "lookthrough";

export interface HoldingsSet {
  layer: HoldingsLayer;
  /** ISO date the provider struck these holdings. */
  asOf: string;
  sourceUrl: string;
  holdings: RawHolding[];
}

export interface EtfProvider {
  /** Stable key stored in `funds.provider`. */
  id: string;
  label: string;
  /** Every fund this provider offers. */
  listFunds(): Promise<ProviderFund[]>;
  /** All published layers for one fund. */
  fetchHoldings(fund: ProviderFund): Promise<HoldingsSet[]>;
}
