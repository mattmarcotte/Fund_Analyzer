import { assetCatLabel } from "@/lib/sec/assetClass";
import type { Breakdown, Holding, LookThroughNode } from "@/lib/types";

/**
 * Aggregations that drive the charts.
 *
 * All of these work off absolute weight. Short positions carry a negative
 * `pct` in N-PORT, and letting those net against longs would understate a
 * fund's real exposure to a sector — a fund that is 10% long and 8% short tech
 * is taking far more tech risk than a flat 2% suggests.
 */

interface GroupOptions {
  /** Collapse everything past this many slices into "Other". */
  maxSlices?: number;
  /** Weight below which a slice is folded into "Other" regardless of rank. */
  minPct?: number;
}

function groupBy<T>(
  items: T[],
  keyOf: (item: T) => string | null,
  pctOf: (item: T) => number,
  valueOf: (item: T) => number,
  { maxSlices = 12, minPct = 0.4 }: GroupOptions = {},
): Breakdown[] {
  const buckets = new Map<string, Breakdown>();

  for (const item of items) {
    const key = keyOf(item);
    if (!key) continue;

    const existing = buckets.get(key);
    const pct = Math.abs(pctOf(item));
    const value = Math.abs(valueOf(item));

    if (existing) {
      existing.pct += pct;
      existing.valueUsd += value;
      existing.count += 1;
    } else {
      buckets.set(key, { label: key, pct, valueUsd: value, count: 1 });
    }
  }

  const sorted = [...buckets.values()].sort((a, b) => b.pct - a.pct);
  const keep: Breakdown[] = [];
  const fold: Breakdown[] = [];

  for (const [i, bucket] of sorted.entries()) {
    if (i < maxSlices && bucket.pct >= minPct) keep.push(bucket);
    else fold.push(bucket);
  }

  if (fold.length) {
    keep.push({
      label: "Other",
      pct: fold.reduce((s, b) => s + b.pct, 0),
      valueUsd: fold.reduce((s, b) => s + b.valueUsd, 0),
      count: fold.reduce((s, b) => s + b.count, 0),
    });
  }

  return keep;
}

export function byAssetClass(holdings: Holding[]): Breakdown[] {
  return groupBy(
    holdings,
    (h) => h.assetClass,
    (h) => h.pct,
    (h) => h.valueUsd,
    { maxSlices: 8, minPct: 0 },
  );
}

export function byAssetCategory(holdings: Holding[]): Breakdown[] {
  return groupBy(
    holdings,
    (h) => assetCatLabel(h.assetCat),
    (h) => h.pct,
    (h) => h.valueUsd,
  );
}

/** Sector mix across equity holdings only, since SIC describes operating companies. */
export function bySector(holdings: Holding[]): Breakdown[] {
  return groupBy(
    holdings.filter((h) => h.assetClass === "Equity" || h.assetClass === "Real Estate"),
    (h) => h.sector,
    (h) => h.pct,
    (h) => h.valueUsd,
  );
}

export function byIndustry(holdings: Holding[]): Breakdown[] {
  return groupBy(
    holdings,
    (h) => h.industry,
    (h) => h.pct,
    (h) => h.valueUsd,
    { maxSlices: 15, minPct: 0.3 },
  );
}

export function byCountry(holdings: Holding[]): Breakdown[] {
  return groupBy(
    holdings,
    (h) => h.country,
    (h) => h.pct,
    (h) => h.valueUsd,
  );
}

/**
 * Share of equity weight that has a resolved sector. Surfaced in the UI so a
 * sector chart built on 80% coverage is never mistaken for the whole picture.
 */
export function sectorCoverage(holdings: Holding[]): {
  classifiedPct: number;
  totalPct: number;
} {
  const equities = holdings.filter(
    (h) => h.assetClass === "Equity" || h.assetClass === "Real Estate",
  );
  const totalPct = equities.reduce((s, h) => s + Math.abs(h.pct), 0);
  const classifiedPct = equities
    .filter((h) => h.sector)
    .reduce((s, h) => s + Math.abs(h.pct), 0);
  return { classifiedPct, totalPct };
}

/** Same aggregations, applied to a flattened look-through result. */
export function breakdownsFromNodes(nodes: LookThroughNode[]) {
  const asHoldings = nodes.map((n) => ({
    ...n.holding,
    pct: n.effectivePct,
  }));
  return {
    assetClass: byAssetClass(asHoldings),
    sector: bySector(asHoldings),
    country: byCountry(asHoldings),
    industry: byIndustry(asHoldings),
    holdings: asHoldings,
  };
}

export function concentration(holdings: Holding[]): {
  top10Pct: number;
  count: number;
} {
  const sorted = [...holdings].sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
  return {
    top10Pct: sorted.slice(0, 10).reduce((s, h) => s + Math.abs(h.pct), 0),
    count: holdings.length,
  };
}
