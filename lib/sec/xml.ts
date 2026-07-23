/**
 * Minimal XML readers for EDGAR documents.
 *
 * N-PORT and EDGAR's atom feeds are machine-generated against a fixed schema,
 * so targeted extraction is both sufficient and considerably faster than a full
 * DOM parse of a multi-megabyte filing. Nothing here is a general XML parser —
 * it only needs to hold for these two document shapes.
 */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
  nbsp: " ",
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, code: string) => {
    if (code in ENTITIES) return ENTITIES[code];
    if (code.startsWith("#x") || code.startsWith("#X")) {
      return String.fromCodePoint(parseInt(code.slice(2), 16));
    }
    if (code.startsWith("#")) {
      return String.fromCodePoint(parseInt(code.slice(1), 10));
    }
    return match;
  });
}

/** First `<tag>…</tag>` text content, entity-decoded. Namespace-prefix tolerant. */
export function tagText(xml: string, tag: string): string | null {
  const re = new RegExp(
    `<(?:[\\w.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}>`,
  );
  const m = re.exec(xml);
  if (!m) return null;
  const value = decodeEntities(m[1]).trim();
  return value.length ? value : null;
}

/** Value of an attribute on a self-closing element, e.g. `<isin value="US…"/>`. */
export function selfClosingAttr(
  xml: string,
  tag: string,
  attr = "value",
): string | null {
  const re = new RegExp(
    `<(?:[\\w.-]+:)?${tag}\\s[^>]*?${attr}\\s*=\\s*"([^"]*)"`,
  );
  const m = re.exec(xml);
  if (!m) return null;
  const value = decodeEntities(m[1]).trim();
  return value.length ? value : null;
}

/** All `<tag>…</tag>` blocks, inner content only. */
export function tagBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(
    `<(?:[\\w.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}>`,
    "g",
  );
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

export function tagNumber(xml: string, tag: string): number | null {
  const raw = tagText(xml, tag);
  if (raw === null) return null;
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}
