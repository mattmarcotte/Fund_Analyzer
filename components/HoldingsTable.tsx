"use client";

import { useCallback, useState } from "react";
import { money, pct } from "@/components/format";
import { assetCatLabel } from "@/lib/sec/assetClass";
import type { FundSnapshot, Holding } from "@/lib/types";

/**
 * Holdings table with on-demand look-through.
 *
 * Each fund holding can be expanded in place, which fetches that fund's own
 * filing and splices its holdings in as indented rows. Weights are multiplied
 * down the chain, so every row's percentage is always relative to the *root*
 * fund — a 40% position in a fund that holds 5% Apple shows Apple at 2%.
 *
 * Expansion is user-driven and unbounded in depth: there is no fixed limit on
 * how far down you can keep going, you just have to click.
 */

interface Props {
  holdings: Holding[];
  currency: "USD" | "CAD";
  /** Rows visible before "show more". */
  pageSize?: number;
}

interface RowState {
  status: "idle" | "loading" | "loaded" | "error";
  children?: Holding[];
  error?: string;
  fundName?: string;
}

export function HoldingsTable({ holdings, currency, pageSize = 25 }: Props) {
  const [expanded, setExpanded] = useState<Record<string, RowState>>({});
  const [visible, setVisible] = useState(pageSize);
  const [filter, setFilter] = useState("");

  const toggle = useCallback(
    async (key: string, holding: Holding) => {
      const current = expanded[key];

      if (current?.status === "loaded" || current?.status === "error") {
        setExpanded((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
        return;
      }
      if (current?.status === "loading") return;

      setExpanded((prev) => ({ ...prev, [key]: { status: "loading" } }));

      try {
        // The lookup key is the fund's name — N-PORT reports no ticker for the
        // funds held inside a fund-of-funds.
        const lookup = holding.ticker ?? holding.name;
        const res = await fetch(`/api/fund/${encodeURIComponent(lookup)}`);
        const data = (await res.json()) as
          | FundSnapshot
          | { error: string; hint?: string };

        if (!res.ok || "error" in data) {
          const err = "error" in data ? data : { error: "Lookup failed" };
          setExpanded((prev) => ({
            ...prev,
            [key]: {
              status: "error",
              error: [err.error, "hint" in err ? err.hint : null]
                .filter(Boolean)
                .join(" — "),
            },
          }));
          return;
        }

        setExpanded((prev) => ({
          ...prev,
          [key]: {
            status: "loaded",
            children: data.holdings,
            fundName: data.meta.seriesName,
          },
        }));
      } catch (err) {
        setExpanded((prev) => ({
          ...prev,
          [key]: {
            status: "error",
            error: err instanceof Error ? err.message : "Lookup failed",
          },
        }));
      }
    },
    [expanded],
  );

  const query = filter.trim().toLowerCase();
  const filtered = query
    ? holdings.filter(
        (h) =>
          h.name.toLowerCase().includes(query) ||
          h.sector?.toLowerCase().includes(query) ||
          h.country?.toLowerCase().includes(query) ||
          h.ticker?.toLowerCase().includes(query),
      )
    : holdings;

  const rows = filtered.slice(0, visible);

  const renderRows = (
    items: Holding[],
    depth: number,
    parentKey: string,
    scale: number,
  ): React.ReactNode[] =>
    items.flatMap((holding, i) => {
      const key = `${parentKey}/${holding.id}-${i}`;
      const state = expanded[key];
      const effective = holding.pct * scale;

      const out: React.ReactNode[] = [
        <tr
          key={key}
          className="border-t"
          style={{ borderColor: "var(--gridline)" }}
        >
          <td className="py-2 pr-3">
            <div
              className="flex items-start gap-1.5"
              style={{ paddingLeft: depth * 18 }}
            >
              {holding.isFund ? (
                <button
                  type="button"
                  onClick={() => toggle(key, holding)}
                  aria-expanded={state?.status === "loaded"}
                  aria-label={`Expand ${holding.name}`}
                  className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px]"
                  style={{
                    color: "var(--seq-400)",
                    border: "1px solid var(--border-hairline)",
                  }}
                >
                  {state?.status === "loading"
                    ? "·"
                    : state?.status === "loaded"
                      ? "−"
                      : "+"}
                </button>
              ) : (
                <span className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              )}

              <div className="min-w-0">
                <p
                  className="truncate text-sm"
                  style={{ color: "var(--text-primary)" }}
                  title={holding.name}
                >
                  {holding.name}
                </p>
                <p
                  className="truncate text-xs"
                  style={{ color: "var(--text-muted)" }}
                >
                  {[
                    holding.ticker,
                    holding.sector ?? assetCatLabel(holding.assetCat),
                    holding.country,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
            </div>
          </td>

          <td
            className="tabular py-2 pr-3 text-right text-sm"
            style={{ color: "var(--text-primary)" }}
          >
            {pct(effective, effective < 1 ? 2 : 1)}
          </td>
          <td
            className="tabular hidden py-2 text-right text-sm sm:table-cell"
            style={{ color: "var(--text-secondary)" }}
          >
            {money(holding.valueUsd * scale, currency)}
          </td>
        </tr>,
      ];

      if (state?.status === "error") {
        out.push(
          <tr key={`${key}-err`}>
            <td colSpan={3} className="pb-2">
              <p
                className="rounded-md px-3 py-2 text-xs"
                style={{
                  marginLeft: (depth + 1) * 18,
                  background: "var(--gridline)",
                  color: "var(--text-secondary)",
                }}
              >
                Couldn&rsquo;t drill into this fund. {state.error}
              </p>
            </td>
          </tr>,
        );
      }

      if (state?.status === "loaded" && state.children) {
        // Only the top slice is spliced inline; the rest stay one click away by
        // opening that fund directly.
        out.push(
          ...renderRows(
            state.children.slice(0, 30),
            depth + 1,
            key,
            scale * (holding.pct / 100),
          ),
        );

        if (state.children.length > 30) {
          out.push(
            <tr key={`${key}-more`}>
              <td colSpan={3} className="pb-2">
                <a
                  href={`/fund/${encodeURIComponent(holding.ticker ?? holding.name)}`}
                  className="block text-xs underline"
                  style={{
                    marginLeft: (depth + 1) * 18,
                    color: "var(--seq-400)",
                  }}
                >
                  View all {state.children.length} holdings of{" "}
                  {state.fundName ?? holding.name}
                </a>
              </td>
            </tr>,
          );
        }
      }

      return out;
    });

  return (
    <div>
      <input
        type="text"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter holdings…"
        aria-label="Filter holdings"
        className="mb-3 w-full rounded-md px-3 py-2 text-sm outline-none"
        style={{
          background: "var(--page-plane)",
          color: "var(--text-primary)",
          border: "1px solid var(--border-hairline)",
        }}
      />

      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] border-collapse">
          <thead>
            <tr>
              <th
                className="pb-2 text-left text-[11px] font-medium uppercase tracking-wide"
                style={{ color: "var(--text-muted)" }}
              >
                Holding
              </th>
              <th
                className="pb-2 text-right text-[11px] font-medium uppercase tracking-wide"
                style={{ color: "var(--text-muted)" }}
              >
                Weight
              </th>
              <th
                className="hidden pb-2 text-right text-[11px] font-medium uppercase tracking-wide sm:table-cell"
                style={{ color: "var(--text-muted)" }}
              >
                Value
              </th>
            </tr>
          </thead>
          <tbody>{renderRows(rows, 0, "root", 1)}</tbody>
        </table>
      </div>

      {filtered.length > visible && (
        <button
          type="button"
          onClick={() => setVisible((v) => v + 50)}
          className="mt-3 w-full rounded-md py-2 text-sm"
          style={{
            border: "1px solid var(--border-hairline)",
            color: "var(--text-secondary)",
          }}
        >
          Show more ({filtered.length - visible} remaining)
        </button>
      )}

      {!filtered.length && (
        <p className="py-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>
          No holdings match &ldquo;{filter}&rdquo;.
        </p>
      )}
    </div>
  );
}
