import { cached, TTL } from "@/lib/cache";

/**
 * LEI -> legal names, via GLEIF's free public API.
 *
 * Funds get renamed, and the SEC's series register is an annual snapshot, so a
 * filing routinely reports a name the register has never heard of. That breaks
 * name matching on exactly the positions it matters for — "iShares Core
 * Universal USD Bond ETF" is 32% of AOR and appears in the register under its
 * former name, "iShares Core Total USD Bond Market ETF".
 *
 * N-PORT reports an LEI for these holdings, and GLEIF publishes both the
 * current legal name and every previous one, which bridges the gap exactly
 * rather than guessing. Fuzzy matching can't safely resolve this case: the
 * filing's name ties with a genuinely different fund (a long-duration bond ETF).
 *
 * @see https://www.gleif.org/en/lei-data/gleif-api
 */

const GLEIF_API = "https://api.gleif.org/api/v1/lei-records";

interface GleifResponse {
  data?: {
    attributes?: {
      entity?: {
        legalName?: { name?: string };
        otherNames?: { name?: string; type?: string }[];
      };
    };
  };
}

/**
 * Every name GLEIF knows this entity by — current legal name first, then
 * previous and alternate names.
 */
export async function namesForLei(lei: string): Promise<string[]> {
  const key = lei.trim().toUpperCase();
  if (!key || key === "N/A" || key.length !== 20) return [];

  return cached(`gleif:${key}`, TTL.SIC, async () => {
    try {
      const res = await fetch(`${GLEIF_API}/${encodeURIComponent(key)}`, {
        headers: { Accept: "application/vnd.api+json" },
        cache: "no-store",
      });
      if (!res.ok) return [];

      const json = (await res.json()) as GleifResponse;
      const entity = json.data?.attributes?.entity;

      const names = [
        entity?.legalName?.name,
        ...(entity?.otherNames ?? []).map((n) => n.name),
      ].filter((n): n is string => Boolean(n));

      return [...new Set(names)];
    } catch {
      // GLEIF being unreachable degrades look-through coverage; it must never
      // fail the request.
      return [];
    }
  });
}
