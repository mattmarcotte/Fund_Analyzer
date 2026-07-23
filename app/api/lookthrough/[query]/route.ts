import { NextResponse } from "next/server";
import { byAssetClass, byCountry } from "@/lib/breakdown";
import {
  buildLookThrough,
  flattenToEffectiveExposure,
  unresolvedFundWeight,
} from "@/lib/lookthrough";
import { fetchSnapshot } from "@/lib/providers";
import {
  fetchIsharesCaLookThrough,
  storeConfigured,
} from "@/lib/providers/isharesCaStore";
import { FundLookupError, type Holding } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Expanding several underlying funds means several sequential SEC fetches. */
export const maxDuration = 60;

/**
 * How many flattened holdings to return.
 *
 * A fully expanded balanced fund can own 30,000+ securities, which is far too
 * much to ship to the browser. Asset-class and country breakdowns are therefore
 * computed server-side across *all* of them (so those totals are exact), while
 * the response carries only the largest positions — enough to drive the sector
 * chart and the holdings list.
 */
const MAX_RETURNED_HOLDINGS = 500;

function summarize(asHoldings: Holding[], unresolvedPct: number) {
  const returned = asHoldings.slice(0, MAX_RETURNED_HOLDINGS);
  const truncatedPct = asHoldings
    .slice(MAX_RETURNED_HOLDINGS)
    .reduce((sum, h) => sum + Math.abs(h.pct), 0);

  return {
    holdings: returned,
    totalSecurities: asHoldings.length,
    truncatedPct,
    // Exact, computed over every security.
    assetClass: byAssetClass(asHoldings),
    country: byCountry(asHoldings),
    unresolvedPct,
  };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ query: string }> },
) {
  const { query } = await params;
  const decoded = decodeURIComponent(query);
  const depth = Number(new URL(request.url).searchParams.get("depth") ?? "2");

  try {
    /*
     * iShares publishes its own look-through, so for Canadian funds we serve
     * the manager's figures straight from the store. That's both more accurate
     * than reconstructing the tree ourselves and far cheaper — no recursive
     * EDGAR fetches, and nothing to leave unresolved.
     */
    if (storeConfigured()) {
      const published = await fetchIsharesCaLookThrough(decoded).catch(() => null);
      if (published) {
        return NextResponse.json({
          ...summarize(published.holdings, 0),
          source: "provider-published",
          asOf: published.asOf,
        });
      }
    }

    const snapshot = await fetchSnapshot(decoded);
    const tree = await buildLookThrough(snapshot, {
      maxDepth: Number.isFinite(depth) ? Math.max(1, Math.min(depth, 4)) : 2,
    });

    const flattened = flattenToEffectiveExposure(
      tree,
      snapshot.meta.netAssets ?? snapshot.meta.totalAssets,
    );

    // Restate weights onto the holding so the aggregations read the right field.
    const asHoldings: Holding[] = flattened.map((n) => ({
      ...n.holding,
      pct: n.effectivePct,
    }));

    return NextResponse.json({
      meta: snapshot.meta,
      ...summarize(asHoldings, unresolvedFundWeight(tree)),
      source: "reconstructed",
      asOf: snapshot.meta.asOf,
    });
  } catch (err) {
    if (err instanceof FundLookupError) {
      return NextResponse.json(
        { error: err.message, code: err.code, hint: err.hint },
        { status: err.code === "UNKNOWN_TICKER" ? 404 : 502 },
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unexpected error" },
      { status: 500 },
    );
  }
}
