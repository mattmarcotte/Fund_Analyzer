"use client";

import { useState } from "react";
import { money, pct } from "@/components/format";
import type { Breakdown } from "@/lib/types";

/**
 * Magnitude comparison across many categories — sector, geography, holdings.
 *
 * Deliberately a single hue rather than the categorical palette: identity is
 * carried by the row label, so colour has no encoding job here. That also keeps
 * these charts clear of the eight-slot categorical ceiling, which sector (12
 * GICS groups) and geography (dozens of countries) would otherwise blow past.
 */

interface Props {
  data: Breakdown[];
  currency?: "USD" | "CAD";
  /** Cap rows shown; the rest stay reachable via the table view. */
  limit?: number;
  emptyMessage?: string;
  onSelect?: (label: string) => void;
}

export function BreakdownBars({
  data,
  currency = "USD",
  limit = 12,
  emptyMessage = "No data available.",
  onSelect,
}: Props) {
  const [hovered, setHovered] = useState<string | null>(null);

  if (!data.length) {
    return (
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        {emptyMessage}
      </p>
    );
  }

  const rows = data.slice(0, limit);
  // Scale to the largest bar so small categories stay legible.
  const max = Math.max(...rows.map((r) => r.pct), 0.0001);

  return (
    <ul className="space-y-2">
      {rows.map((row) => {
        const isHovered = hovered === row.label;
        const width = Math.max((row.pct / max) * 100, 0.8);

        return (
          <li
            key={row.label}
            className={`group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-md px-1 py-1 ${
              onSelect ? "cursor-pointer" : ""
            }`}
            style={{
              background: isHovered ? "var(--gridline)" : "transparent",
            }}
            onMouseEnter={() => setHovered(row.label)}
            onMouseLeave={() => setHovered(null)}
            onClick={() => onSelect?.(row.label)}
            title={
              row.count
                ? `${row.label} — ${pct(row.pct)} across ${row.count} holding${
                    row.count === 1 ? "" : "s"
                  }`
                : `${row.label} — ${pct(row.pct)}`
            }
          >
            <span
              className="min-w-0 truncate text-sm"
              style={{ color: "var(--text-secondary)" }}
            >
              {row.label}
            </span>

            <span className="flex items-baseline gap-2">
              <span
                className="tabular text-sm font-medium"
                style={{ color: "var(--text-primary)" }}
              >
                {pct(row.pct)}
              </span>
              {row.valueUsd > 0 && (
                <span
                  className="tabular hidden w-14 text-right text-xs sm:inline"
                  style={{ color: "var(--text-muted)" }}
                >
                  {money(row.valueUsd, currency)}
                </span>
              )}
            </span>

            {/* Track spans both columns so bars share one baseline. */}
            <span
              className="col-span-2 block h-1.5 w-full overflow-hidden rounded-full"
              style={{ background: "var(--gridline)" }}
            >
              <span
                className="block h-full rounded-full transition-[width] duration-300"
                style={{
                  width: `${width}%`,
                  background: isHovered ? "var(--seq-450)" : "var(--seq-400)",
                }}
              />
            </span>
          </li>
        );
      })}

      {data.length > limit && (
        <li className="pt-1 text-xs" style={{ color: "var(--text-muted)" }}>
          + {data.length - limit} more, shown in the holdings table below
        </li>
      )}
    </ul>
  );
}
