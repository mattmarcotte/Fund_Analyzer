import type { IssuerCategory } from "@/lib/types";

/**
 * Whether a holding is itself a fund, and therefore a look-through candidate.
 *
 * `issuerCat = RF` is the official signal but it is not applied consistently:
 * iShares tags underlying funds as RF, while Vanguard tags its own underlying
 * funds as CORP. Trusting the flag alone silently drops every Vanguard
 * fund-of-fund, so we fall back to the name.
 *
 * Deliberately permissive — a false positive costs one failed lookup that gets
 * reported inline, while a false negative understates what the portfolio owns.
 */
export function looksLikeFund(
  name: string,
  issuerCat: IssuerCategory,
): boolean {
  if (issuerCat === "RF") return true;
  if (!name || name === "N/A") return false;
  return /\b(fund|etf|trust|portfolio|index|sicav|ucits)\b/i.test(name);
}
