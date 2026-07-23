"use client";

import { useEffect, useMemo, useState } from "react";
import { AllocationDonut } from "@/components/charts/AllocationDonut";
import { BreakdownBars } from "@/components/charts/BreakdownBars";
import { HoldingsTable } from "@/components/HoldingsTable";
import { Card, StatTile } from "@/components/StatTile";
import { count, formatDate, money, pct } from "@/components/format";
import {
  byAssetClass,
  byCountry,
  byIndustry,
  bySector,
  concentration,
  sectorCoverage,
} from "@/lib/breakdown";
import type { EnrichResult } from "@/lib/enrich";
import type { Breakdown, FundSnapshot, Holding } from "@/lib/types";

/** Holdings sent per enrichment request; the API caps this server-side too. */
const ENRICH_BATCH = 40;
/**
 * Enrichment ceiling. The top 300 holdings cover essentially all of the weight
 * in even the broadest index funds, and each lookup is a rate-limited SEC call.
 */
const ENRICH_LIMIT = 300;
/**
 * Above this share of weight held in other funds, the top-level view says
 * almost nothing — a 60/40 fund-of-funds reports its own ETF holdings with
 * assetCat "Other", so equity-vs-bond only exists one level down.
 */
const AUTO_LOOKTHROUGH_THRESHOLD = 20;

type SectorMap = Record<string, EnrichResult>;

/**
 * Look-through payload. Asset-class and country breakdowns arrive
 * pre-aggregated across every security in the tree — a fully expanded balanced
 * fund owns far too many positions to ship in full — while `holdings` carries
 * only the largest, which is what the sector chart and table need.
 */
interface LookThroughData {
  holdings: Holding[];
  totalSecurities: number;
  truncatedPct: number;
  assetClass: Breakdown[];
  country: Breakdown[];
  unresolvedPct: number;
  /**
   * `provider-published` means the manager publishes the look-through itself
   * (iShares does), so it's their figures with nothing left unresolved.
   * `reconstructed` means we expanded the tree from filings.
   */
  source: "provider-published" | "reconstructed";
  asOf: string | null;
}

export function FundDashboard({ snapshot }: { snapshot: FundSnapshot }) {
  const [sectors, setSectors] = useState<SectorMap>({});
  const [enriching, setEnriching] = useState(false);

  const [lookThrough, setLookThrough] = useState<LookThroughData | null>(null);
  const [lookThroughState, setLookThroughState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [useLookThrough, setUseLookThrough] = useState(true);

  const { meta, published } = snapshot;
  const currency = meta.currency;

  const fundWeight = snapshot.holdings
    .filter((h) => h.isFund)
    .reduce((s, h) => s + Math.abs(h.pct), 0);
  const isFundOfFunds = fundWeight >= AUTO_LOOKTHROUGH_THRESHOLD;

  /*
   * For a fund-of-funds, fetch the look-through automatically — without it the
   * allocation charts carry no information. Funds that hold securities directly
   * have nothing to see through, so we skip the request entirely.
   */
  useEffect(() => {
    if (!isFundOfFunds) {
      setLookThrough(null);
      setLookThroughState("idle");
      return;
    }

    let cancelled = false;
    setLookThroughState("loading");

    (async () => {
      try {
        const res = await fetch(
          `/api/lookthrough/${encodeURIComponent(meta.ticker)}?depth=2`,
        );
        if (!res.ok) throw new Error("look-through failed");

        const data = (await res.json()) as LookThroughData;
        if (cancelled) return;

        setLookThrough(data);
        setLookThroughState("ready");
      } catch {
        if (!cancelled) setLookThroughState("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [meta.ticker, isFundOfFunds]);

  /** The holdings the charts describe, before sector enrichment is applied. */
  const activeBase = useMemo(
    () =>
      useLookThrough && lookThrough ? lookThrough.holdings : snapshot.holdings,
    [useLookThrough, lookThrough, snapshot.holdings],
  );

  /*
   * Sector isn't in the N-PORT filing — it has to be resolved per company
   * against EDGAR, one rate-limited request each. Doing that before first paint
   * would stall the page for many seconds, so the dashboard renders immediately
   * from filing data and the sector chart fills in progressively.
   *
   * Results are keyed by holding id in a map shared across the as-reported and
   * look-through views, so switching between them never re-fetches.
   *
   * IG funds skip this entirely: their filings already carry a GICS sector.
   */
  useEffect(() => {
    const pending = activeBase
      .filter(
        (h) =>
          !h.sector &&
          !sectors[h.id] &&
          !h.isFund &&
          h.name !== "N/A" &&
          (h.assetClass === "Equity" || h.assetClass === "Real Estate"),
      )
      .slice(0, ENRICH_LIMIT);

    if (!pending.length) return;

    let cancelled = false;
    setEnriching(true);

    (async () => {
      for (let i = 0; i < pending.length; i += ENRICH_BATCH) {
        if (cancelled) return;

        const batch = pending.slice(i, i + ENRICH_BATCH);
        try {
          const res = await fetch("/api/enrich", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              items: batch.map((h) => ({
                id: h.id,
                name: h.name,
                ticker: h.ticker,
              })),
            }),
          });
          if (!res.ok) continue;

          const { results } = (await res.json()) as { results: EnrichResult[] };
          if (cancelled) return;

          setSectors((prev) => {
            const next = { ...prev };
            for (const r of results) if (r.sector) next[r.id] = r;
            return next;
          });
        } catch {
          // A failed batch leaves those holdings unclassified; the coverage
          // figure below reports the shortfall either way.
        }
      }

      if (!cancelled) setEnriching(false);
    })();

    return () => {
      cancelled = true;
    };
    // `sectors` is intentionally omitted: including it would re-run the effect
    // after every batch and restart the walk.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBase]);

  const holdings = useMemo(
    () =>
      activeBase.map((h) => {
        const hit = sectors[h.id];
        return hit
          ? {
              ...h,
              sector: h.sector ?? hit.sector,
              industry: h.industry ?? hit.industry,
              sicCode: h.sicCode ?? hit.sicCode,
            }
          : h;
      }),
    [activeBase, sectors],
  );

  const derived = useMemo(
    () => ({
      assetClass: byAssetClass(holdings),
      sector: bySector(holdings),
      country: byCountry(holdings),
      industry: byIndustry(holdings),
      coverage: sectorCoverage(holdings),
      concentration: concentration(holdings),
    }),
    [holdings],
  );

  const showingLookThrough = useLookThrough && lookThrough !== null;

  /*
   * Published figures win when we're showing the fund as reported — they're the
   * manager's own numbers. They do *not* apply to the look-through view, which
   * describes a different (deeper) set of holdings.
   */
  const usePublished = showingLookThrough ? undefined : published;

  /*
   * When looking through, asset-class and country come from the server, which
   * aggregated them across every security in the tree. The client only holds
   * the largest positions, so computing them here would understate the tail.
   */
  const assetData = usePublished?.assetAllocation.length
    ? usePublished.assetAllocation
    : showingLookThrough
      ? lookThrough!.assetClass
      : derived.assetClass;

  /*
   * Sector resolution is capped (each lookup is a rate-limited SEC request), so
   * on a fully expanded fund only a fraction of the securities carry a sector.
   * Left as a share of the whole portfolio the bars would silently understate
   * every sector in proportion to how much we hadn't classified yet. Restating
   * them as a share of *classified* equity keeps the mix accurate and honest;
   * the card's subtitle reports the coverage behind it.
   */
  const sectorData = useMemo(() => {
    if (usePublished?.sector.length) return usePublished.sector;
    // Provider-classified sectors cover every holding, so they need no
    // rescaling — normalising them would distort exact figures. This applies
    // to the published look-through too, which ships the same GICS labels.
    if (
      meta.source === "ishares-ca" ||
      (showingLookThrough && lookThrough!.source === "provider-published")
    ) {
      return derived.sector;
    }

    const total = derived.sector.reduce((s, b) => s + b.pct, 0);
    if (total <= 0) return derived.sector;

    // Dollar values are dropped: rescaled percentages no longer correspond to
    // the underlying amounts, and showing both would invite a false reading.
    return derived.sector.map((b) => ({
      ...b,
      pct: (b.pct / total) * 100,
      valueUsd: 0,
    }));
  }, [usePublished, derived.sector, meta.source, showingLookThrough, lookThrough]);

  const countryData = usePublished?.regional.length
    ? usePublished.regional
    : showingLookThrough
      ? lookThrough!.country
      : derived.country;

  const equityPct =
    assetData.find((d) => /^equit/i.test(d.label))?.pct ??
    derived.assetClass.find((d) => d.label === "Equity")?.pct ??
    0;
  const bondPct =
    assetData.find((d) => /bond|fixed income|debt/i.test(d.label))?.pct ??
    derived.assetClass.find((d) => d.label === "Fixed Income")?.pct ??
    0;

  const coveragePct =
    derived.coverage.totalPct > 0
      ? (derived.coverage.classifiedPct / derived.coverage.totalPct) * 100
      : 0;

  const fundHoldings = snapshot.holdings.filter((h) => h.isFund);

  const viewNote = showingLookThrough
    ? `${
        lookThrough!.source === "provider-published"
          ? "The manager's own look-through"
          : "Seeing"
      } through ${fundHoldings.length} underlying fund${
        fundHoldings.length === 1 ? "" : "s"
      } to ${count(lookThrough!.totalSecurities)} securities`
    : lookThroughState === "loading"
      ? "Looking through the underlying funds…"
      : null;

  return (
    <div className="space-y-4">
      {isFundOfFunds && (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg px-4 py-3"
          style={{
            background: "var(--surface-1)",
            border: "1px solid var(--border-hairline)",
          }}
        >
          <div className="min-w-0">
            <p className="text-sm" style={{ color: "var(--text-primary)" }}>
              {pct(fundWeight)} of this fund is held in other funds.
            </p>
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              {viewNote ??
                (lookThroughState === "error"
                  ? "Couldn't load the underlying holdings — showing the fund as reported."
                  : "Showing the fund as reported.")}
              {showingLookThrough && lookThrough!.unresolvedPct > 0.5 && (
                <> · {pct(lookThrough!.unresolvedPct)} couldn&rsquo;t be resolved</>
              )}
            </p>
          </div>

          {lookThrough && (
            <div
              className="flex shrink-0 overflow-hidden rounded-md"
              style={{ border: "1px solid var(--border-hairline)" }}
              role="group"
              aria-label="Holdings view"
            >
              {[
                { key: true, label: "Look through" },
                { key: false, label: "As reported" },
              ].map((opt) => (
                <button
                  key={String(opt.key)}
                  type="button"
                  onClick={() => setUseLookThrough(opt.key)}
                  aria-pressed={useLookThrough === opt.key}
                  className="px-3 py-1.5 text-xs font-medium"
                  style={{
                    background:
                      useLookThrough === opt.key
                        ? "var(--seq-400)"
                        : "transparent",
                    color:
                      useLookThrough === opt.key
                        ? "#ffffff"
                        : "var(--text-secondary)",
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label={showingLookThrough ? "Securities held" : "Holdings"}
          value={count(
            showingLookThrough
              ? lookThrough!.totalSecurities
              : derived.concentration.count,
          )}
          sublabel={
            snapshot.holdingsArePartial
              ? "top positions only"
              : `top 10 = ${pct(derived.concentration.top10Pct)}`
          }
        />
        <StatTile
          label="Equity"
          value={pct(equityPct)}
          sublabel={bondPct > 0 ? `${pct(bondPct)} fixed income` : undefined}
        />
        <StatTile
          label="Net assets"
          value={meta.netAssets ? money(meta.netAssets, currency) : "—"}
          sublabel={meta.asOf ? `as of ${formatDate(meta.asOf)}` : undefined}
        />
        <StatTile
          label="Funds inside"
          value={count(fundHoldings.length)}
          sublabel={
            fundHoldings.length
              ? "expandable in the table"
              : "holds securities directly"
          }
        />
      </div>

      {snapshot.holdingsArePartial && (
        <p
          className="rounded-lg px-4 py-3 text-sm"
          style={{
            background: "var(--surface-1)",
            border: "1px solid var(--border-hairline)",
            color: "var(--text-secondary)",
          }}
        >
          This fund publishes only its top positions in machine-readable form, so
          the holdings list below is partial. The allocation charts come from the
          manager&rsquo;s own published breakdowns and do cover the full portfolio.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Asset allocation"
          subtitle={
            usePublished?.assetAllocation.length
              ? `Published by the manager${
                  usePublished.asOf ? ` · as of ${usePublished.asOf}` : ""
                }`
              : showingLookThrough
                ? lookThrough!.source === "provider-published"
                  ? "The manager's published look-through"
                  : "From the underlying funds' own holdings"
                : meta.source === "ishares-ca"
                  ? "As classified by the fund provider"
                  : "Derived from the filing's asset categories"
          }
        >
          <AllocationDonut
            data={assetData}
            currency={currency}
            centerLabel="Equity"
            centerValue={pct(equityPct)}
          />
        </Card>

        <Card
          title="Sector"
          subtitle={
            usePublished?.sector.length
              ? "Published by the manager"
              : meta.source === "ishares-ca" ||
                  (showingLookThrough &&
                    lookThrough!.source === "provider-published")
                ? "GICS sectors, as published by the fund provider"
                : enriching
                  ? `Resolving sectors from SEC filings… ${pct(coveragePct, 0)} classified so far`
                  : `SIC-derived · share of classified equity · ${pct(coveragePct, 0)} covered`
          }
        >
          <BreakdownBars
            data={sectorData}
            currency={currency}
            emptyMessage={
              enriching || lookThroughState === "loading"
                ? "Loading…"
                : "No equity holdings to classify by sector."
            }
          />
        </Card>

        <Card
          title="Geography"
          subtitle={
            usePublished?.regional.length
              ? "Published by the manager"
              : "By country of investment"
          }
        >
          <BreakdownBars data={countryData} currency={currency} limit={10} />
        </Card>

        <Card title="Industry" subtitle="SIC industry classification, where resolved">
          <BreakdownBars
            data={derived.industry}
            currency={currency}
            limit={10}
            emptyMessage={
              enriching
                ? "Loading…"
                : "Industry detail isn't available for this fund."
            }
          />
        </Card>
      </div>

      <Card
        title="Holdings"
        subtitle={
          fundHoldings.length
            ? "Rows marked + are funds — expand to see through to what they hold"
            : "Every position in the filing"
        }
      >
        {/* Always the as-reported list: the table is where you drill manually. */}
        <HoldingsTable holdings={snapshot.holdings} currency={currency} />
      </Card>
    </div>
  );
}
