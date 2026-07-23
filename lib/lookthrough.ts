import { looksLikeFund } from "@/lib/fundDetect";
import { namesForLei } from "@/lib/gleif";
import { findSeriesByName, findSeriesByTicker } from "@/lib/fundIndex";
import { fetchSnapshotBySeries } from "@/lib/sec/nport";
import { fundTickerMap } from "@/lib/sec/tickers";
import type { FundSnapshot, Holding, LookThroughNode } from "@/lib/types";

/**
 * Recursive look-through.
 *
 * A holding flagged `issuerCat = RF` is itself a registered fund, so its own
 * N-PORT can be pulled and spliced in. Weights multiply down the chain: a 40%
 * position in a fund that holds 5% Apple contributes 2% Apple to the parent.
 * That product is what `effectivePct` carries.
 */

/** Guards against pathological trees; fund-of-fund chains are rarely deep. */
const MAX_DEPTH = 4;
const MAX_EXPANSIONS_PER_LEVEL = 25;

/**
 * Decide whether a holding is a fund we can drill into, and find its filing.
 *
 * Two things make this harder than it looks:
 *
 *  1. `issuerCat = RF` is not reliable. iShares tags underlying funds as RF,
 *     but Vanguard tags its own underlying funds as CORP. Relying on the flag
 *     alone silently drops every Vanguard fund-of-fund.
 *  2. N-PORT reports no ticker or series id for fund holdings — the name is the
 *     only identifier. Hence the name -> series index.
 *
 * So we treat a holding as a fund if either the issuer category says so or the
 * name resolves against the SEC's fund register.
 */
async function resolveFundSeries(
  holding: Holding,
): Promise<{ seriesId: string; ticker: string } | null> {
  if (holding.ticker) {
    const map = await fundTickerMap();
    const direct = map.get(holding.ticker.trim().toUpperCase());
    if (direct) return { seriesId: direct.seriesId, ticker: direct.ticker };

    const byTicker = findSeriesByTicker(holding.ticker);
    if (byTicker) {
      return { seriesId: byTicker.id, ticker: byTicker.tickers[0] ?? holding.ticker };
    }
  }

  const byName = findSeriesByName(holding.name);
  if (byName) {
    return { seriesId: byName.id, ticker: byName.tickers[0] ?? byName.name };
  }

  // Last resort: the fund may simply have been renamed since the register's
  // annual snapshot. GLEIF knows both names for the LEI in the filing.
  if (holding.lei) {
    for (const alias of await namesForLei(holding.lei)) {
      if (alias.toLowerCase() === holding.name.toLowerCase()) continue;
      const match = findSeriesByName(alias);
      if (match) {
        return { seriesId: match.id, ticker: match.tickers[0] ?? match.name };
      }
    }
  }

  return null;
}

const isFundHolding = (h: Holding) => looksLikeFund(h.name, h.issuerCat);

interface ExpandOptions {
  maxDepth: number;
  /** Only expand fund positions above this weight — small ones aren't worth the requests. */
  minPctToExpand: number;
}

const DEFAULT_OPTIONS: ExpandOptions = {
  maxDepth: 2,
  minPctToExpand: 0.5,
};

async function expandNode(
  holding: Holding,
  effectivePct: number,
  depth: number,
  path: string[],
  visited: Set<string>,
  options: ExpandOptions,
): Promise<LookThroughNode> {
  const node: LookThroughNode = {
    holding,
    effectivePct,
    depth,
    path,
    children: null,
    expansionError: null,
  };

  if (!isFundHolding(holding)) return node;
  if (depth >= options.maxDepth) {
    node.expansionError = "Depth limit reached";
    return node;
  }
  if (Math.abs(effectivePct) < options.minPctToExpand) {
    node.expansionError = "Position too small to expand";
    return node;
  }

  const resolved = await resolveFundSeries(holding);
  if (!resolved) {
    node.expansionError =
      "Could not match this fund to an EDGAR filer (the filing reports no ticker for it)";
    return node;
  }

  // A fund holding itself, directly or via a cycle, would recurse forever.
  if (visited.has(resolved.seriesId)) {
    node.expansionError = "Circular holding — already expanded higher up";
    return node;
  }

  let snapshot: FundSnapshot;
  try {
    snapshot = await fetchSnapshotBySeries(resolved.seriesId, resolved.ticker);
  } catch (err) {
    node.expansionError =
      err instanceof Error ? err.message : "Could not load this fund's holdings";
    return node;
  }

  const nextVisited = new Set(visited).add(resolved.seriesId);
  const nextPath = [...path, resolved.ticker];

  // The child's pctVal is a share of the *child's* assets; scale into the root.
  const scale = effectivePct / 100;

  /*
   * Every child is kept. Truncating here would silently discard weight — a
   * broad bond fund holds thousands of positions, so capping at a few hundred
   * loses most of its value and leaves the parent's asset mix badly understated.
   *
   * Only *recursion* is capped: aggregating many rows is cheap, whereas each
   * further expansion is another rate-limited SEC fetch.
   */
  node.children = await Promise.all(
    snapshot.holdings.map((child, i) =>
      expandNode(
        child,
        child.pct * scale,
        depth + 1,
        nextPath,
        nextVisited,
        i < MAX_EXPANSIONS_PER_LEVEL
          ? options
          : { ...options, maxDepth: depth + 1 },
      ),
    ),
  );

  return node;
}

/** Build the look-through tree for a fund snapshot. */
export async function buildLookThrough(
  snapshot: FundSnapshot,
  overrides: Partial<ExpandOptions> = {},
): Promise<LookThroughNode[]> {
  const options: ExpandOptions = {
    ...DEFAULT_OPTIONS,
    ...overrides,
    maxDepth: Math.min(overrides.maxDepth ?? DEFAULT_OPTIONS.maxDepth, MAX_DEPTH),
  };

  const visited = new Set([snapshot.meta.seriesId]);

  return Promise.all(
    snapshot.holdings.map((h) =>
      expandNode(h, h.pct, 0, [snapshot.meta.ticker], visited, options),
    ),
  );
}

/**
 * Collapse the tree to the securities actually owned — every leaf, plus any
 * fund that could not be expanded (so weight is never silently dropped).
 * Duplicate securities held through multiple funds are merged.
 */
export function flattenToEffectiveExposure(
  nodes: LookThroughNode[],
  /** Root fund's net assets, used to restate child values into this portfolio. */
  rootNetAssets: number | null,
): LookThroughNode[] {
  const merged = new Map<string, LookThroughNode>();

  const scaledValue = (node: LookThroughNode) =>
    rootNetAssets ? (node.effectivePct / 100) * rootNetAssets : 0;

  const walk = (node: LookThroughNode) => {
    const isLeaf = !node.children || node.children.length === 0;
    if (!isLeaf) {
      node.children!.forEach(walk);
      return;
    }

    const key = node.holding.id;
    const existing = merged.get(key);
    if (existing) {
      existing.effectivePct += node.effectivePct;
      existing.holding = {
        ...existing.holding,
        valueUsd: existing.holding.valueUsd + scaledValue(node),
      };
    } else {
      merged.set(key, {
        ...node,
        // `valUSD` on a child row is the *underlying fund's* position — IVV's
        // whole $70B Apple stake, not this portfolio's slice of it. Rescale to
        // the root's own weight or the value columns read absurdly high.
        holding: { ...node.holding, valueUsd: scaledValue(node) },
        children: null,
      });
    }
  };

  nodes.forEach(walk);

  return [...merged.values()].sort(
    (a, b) => Math.abs(b.effectivePct) - Math.abs(a.effectivePct),
  );
}

/** How much of the portfolio sits behind a fund we couldn't see through. */
export function unresolvedFundWeight(nodes: LookThroughNode[]): number {
  let total = 0;
  const walk = (node: LookThroughNode) => {
    if (isFundHolding(node.holding) && node.expansionError) {
      total += Math.abs(node.effectivePct);
      return;
    }
    node.children?.forEach(walk);
  };
  nodes.forEach(walk);
  return total;
}
