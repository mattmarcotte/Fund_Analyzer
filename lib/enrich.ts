import { resolveCompany } from "@/lib/match";
import {
  fetchSicForCik,
  sectorForSic,
  sectorOverrideForTicker,
} from "@/lib/sec/sic";
import type { Holding } from "@/lib/types";

export interface EnrichRequestItem {
  id: string;
  name: string;
  ticker?: string | null;
}

export interface EnrichResult {
  id: string;
  sector: string | null;
  industry: string | null;
  sicCode: string | null;
}

/**
 * Resolve sector/industry for a batch of holdings.
 *
 * Every lookup is two cached steps: name -> CIK (in-memory index, free after
 * the first call) and CIK -> SIC (one small EDGAR request, cached for a week).
 * The SEC rate limiter in `secFetch` paces the fan-out, so callers can hand us
 * a whole batch without worrying about tripping the 10 req/s ceiling.
 */
export async function enrichHoldings(
  items: EnrichRequestItem[],
): Promise<EnrichResult[]> {
  return Promise.all(
    items.map(async (item): Promise<EnrichResult> => {
      const empty: EnrichResult = {
        id: item.id,
        sector: null,
        industry: null,
        sicCode: null,
      };

      try {
        const company = await resolveCompany(item.name, item.ticker);
        if (!company) return empty;

        const { sic, description } = await fetchSicForCik(company.cik);
        return {
          id: item.id,
          // The override is keyed off the resolved registrant's ticker, so it
          // applies even when the filing itself reports no ticker.
          sector: sectorOverrideForTicker(company.ticker) ?? sectorForSic(sic),
          industry: description,
          sicCode: sic,
        };
      } catch {
        // Enrichment is additive — a failure here degrades the sector chart's
        // coverage but must never take down the holdings view.
        return empty;
      }
    }),
  );
}

/**
 * Holdings that are worth spending a lookup on: equities only, since SIC codes
 * describe operating companies. Bonds, cash and derivatives are already
 * classified by `assetCat` and would only add noise.
 */
export function enrichableHoldings(holdings: Holding[]): Holding[] {
  return holdings.filter(
    (h) =>
      (h.assetClass === "Equity" || h.assetClass === "Real Estate") &&
      !h.isFund &&
      h.name !== "N/A",
  );
}
