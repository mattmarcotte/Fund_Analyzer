"use client";

import { useState } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";
import { money, pct } from "@/components/format";
import type { Breakdown } from "@/lib/types";

/**
 * Part-to-whole for a small set of categories (asset class never exceeds seven).
 *
 * Categorical slots are assigned in fixed order and never cycled. Three light
 * -mode slots sit below 3:1 against the surface, so the relief rule applies:
 * every segment is direct-labelled in the legend with its value, and the
 * holdings table below the chart is the table view.
 */

const SLOTS = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
  "var(--series-5)",
  "var(--series-6)",
  "var(--series-7)",
  "var(--series-8)",
];

interface Props {
  data: Breakdown[];
  currency?: "USD" | "CAD";
  /** Rendered inside the ring — the one number the chart is really about. */
  centerLabel?: string;
  centerValue?: string;
}

export function AllocationDonut({
  data,
  currency = "USD",
  centerLabel,
  centerValue,
}: Props) {
  const [active, setActive] = useState<number | null>(null);

  if (!data.length) {
    return (
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        No allocation data available.
      </p>
    );
  }

  const total = data.reduce((s, d) => s + d.pct, 0);

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
      <div className="relative h-[190px] w-[190px] shrink-0 self-center">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="pct"
              nameKey="label"
              innerRadius={62}
              outerRadius={92}
              startAngle={90}
              endAngle={-270}
              /* 2px surface gap between adjacent fills. */
              paddingAngle={1.5}
              stroke="var(--surface-1)"
              strokeWidth={2}
              isAnimationActive={false}
              onMouseEnter={(_, i) => setActive(i)}
              onMouseLeave={() => setActive(null)}
            >
              {data.map((entry, i) => (
                <Cell
                  key={entry.label}
                  fill={SLOTS[i % SLOTS.length]}
                  opacity={active === null || active === i ? 1 : 0.35}
                />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>

        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          {active !== null ? (
            <>
              <span
                className="max-w-[104px] text-[11px] leading-tight"
                style={{ color: "var(--text-secondary)" }}
              >
                {data[active].label}
              </span>
              <span
                className="text-xl font-semibold"
                style={{ color: "var(--text-primary)" }}
              >
                {pct(data[active].pct)}
              </span>
            </>
          ) : (
            <>
              <span
                className="text-[11px] uppercase tracking-wide"
                style={{ color: "var(--text-muted)" }}
              >
                {centerLabel ?? "Total"}
              </span>
              <span
                className="text-xl font-semibold"
                style={{ color: "var(--text-primary)" }}
              >
                {centerValue ?? pct(total)}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Legend doubles as the direct-label relief for low-contrast slots. */}
      <ul className="min-w-0 flex-1 space-y-1.5">
        {data.map((entry, i) => (
          <li
            key={entry.label}
            className="flex items-baseline gap-2 text-sm"
            onMouseEnter={() => setActive(i)}
            onMouseLeave={() => setActive(null)}
          >
            <span
              aria-hidden
              className="mt-1 h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ background: SLOTS[i % SLOTS.length] }}
            />
            <span
              className="min-w-0 flex-1 truncate"
              style={{ color: "var(--text-secondary)" }}
              title={entry.label}
            >
              {entry.label}
            </span>
            <span
              className="tabular font-medium"
              style={{ color: "var(--text-primary)" }}
            >
              {pct(entry.pct)}
            </span>
            {entry.valueUsd > 0 && (
              <span
                className="tabular hidden w-14 text-right text-xs sm:inline"
                style={{ color: "var(--text-muted)" }}
              >
                {money(entry.valueUsd, currency)}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
