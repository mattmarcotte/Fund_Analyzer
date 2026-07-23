/** Shared number formatting, so every surface renders figures identically. */

export function pct(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

export function money(value: number, currency: "USD" | "CAD" = "USD"): string {
  if (!Number.isFinite(value) || value === 0) return "—";

  const abs = Math.abs(value);
  const [scaled, suffix] =
    abs >= 1e12
      ? [value / 1e12, "T"]
      : abs >= 1e9
        ? [value / 1e9, "B"]
        : abs >= 1e6
          ? [value / 1e6, "M"]
          : abs >= 1e3
            ? [value / 1e3, "K"]
            : [value, ""];

  const symbol = currency === "CAD" ? "C$" : "$";
  return `${symbol}${scaled.toFixed(scaled >= 100 || suffix === "" ? 0 : 1)}${suffix}`;
}

export function count(value: number): string {
  return value.toLocaleString("en-US");
}

/** ISO or "March 31, 2026" in, short readable form out. */
export function formatDate(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
