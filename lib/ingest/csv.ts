/** RFC-4180 CSV parsing, shared by the ingestion adapters. */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/** Strips thousands separators, currency symbols and stray whitespace. */
export function toNumber(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  const cleaned = raw.replace(/[,$%\s]/g, "").trim();
  if (!cleaned || cleaned === "-" || cleaned === "—" || cleaned === "–") {
    return null;
  }
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function cleanText(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "-" || trimmed.toUpperCase() === "N/A") return null;
  return trimmed;
}

/**
 * Parses dates as written in provider files ("Jul 22, 2026") into ISO.
 * Returns today only as a last resort, since an unparseable date would
 * otherwise collapse every snapshot onto one key.
 */
export function toIsoDate(raw: string | null): string {
  if (raw) {
    const parsed = new Date(raw.replace(/"/g, "").trim());
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
  }
  return new Date().toISOString().slice(0, 10);
}
