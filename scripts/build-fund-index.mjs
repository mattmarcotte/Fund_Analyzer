/**
 * Builds data/fund-index.json from the SEC's Investment Company Series and
 * Class Information report.
 *
 * This index is what makes look-through possible. N-PORT names the funds a
 * fund-of-funds holds ("iShares Core S&P 500 ETF") but reports no ticker or
 * series id for them, so a name -> series crosswalk is the only way to find
 * the underlying filing. The report is also the only free source of fund
 * *names*, which powers search-by-name.
 *
 * The SEC publishes one file per year and does not always have the current
 * year available, so we walk backwards to the most recent one that exists.
 *
 * Usage: npm run update-data
 *
 * @see https://www.sec.gov/data-research/sec-markets-data/investment-company-series-class-information
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE =
  "https://www.sec.gov/files/investment/data/other/investment-company-series-and-class-information";

const USER_AGENT =
  process.env.SEC_USER_AGENT?.trim() ||
  "Fund Analyzer data build (contact: set SEC_USER_AGENT)";

const OUT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../data/fund-index.json",
);

/** Minimal RFC-4180 parser — series names contain commas and quoted segments. */
function parseCsv(text) {
  const rows = [];
  let row = [];
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

async function fetchLatestReport() {
  const currentYear = new Date().getFullYear();

  for (let year = currentYear; year >= currentYear - 3; year--) {
    const url = `${BASE}/investment-company-series-class-${year}.csv`;
    process.stdout.write(`  trying ${year}… `);

    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    // The SEC serves a 404 HTML page rather than a plain status for missing years.
    const text = res.ok ? await res.text() : "";

    if (res.ok && text.startsWith("Reporting File Number")) {
      console.log(`found (${(text.length / 1e6).toFixed(1)} MB)`);
      return { year, text };
    }
    console.log("not published");
  }

  throw new Error("No series/class report found for the last 4 years");
}

async function main() {
  console.log("Fetching SEC series & class report…");
  const { year, text } = await fetchLatestReport();

  const rows = parseCsv(text);
  const header = rows[0].map((h) => h.trim());
  const col = (name) => header.indexOf(name);

  const iCik = col("CIK Number");
  const iEntity = col("Entity Name");
  const iSeriesId = col("Series ID");
  const iSeriesName = col("Series Name");
  const iTicker = col("Class Ticker");

  if ([iCik, iEntity, iSeriesId, iSeriesName, iTicker].some((i) => i < 0)) {
    throw new Error(`Unexpected columns in report: ${header.join(", ")}`);
  }

  // Collapse share classes: many rows per series, one entry out.
  const bySeries = new Map();

  for (const row of rows.slice(1)) {
    const seriesId = row[iSeriesId]?.trim();
    const seriesName = row[iSeriesName]?.trim();
    if (!seriesId?.startsWith("S") || !seriesName) continue;

    let entry = bySeries.get(seriesId);
    if (!entry) {
      entry = {
        id: seriesId,
        name: seriesName,
        cik: String(Number(row[iCik]?.trim() || 0)),
        entity: row[iEntity]?.trim() ?? "",
        tickers: [],
      };
      bySeries.set(seriesId, entry);
    }

    const ticker = row[iTicker]?.trim().toUpperCase();
    if (ticker && ticker !== "N/A" && !entry.tickers.includes(ticker)) {
      entry.tickers.push(ticker);
    }
  }

  const series = [...bySeries.values()];
  const withTickers = series.filter((s) => s.tickers.length).length;

  const payload = {
    generatedAt: new Date().toISOString(),
    sourceYear: year,
    series,
  };

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(payload));

  console.log(`\nWrote ${OUT_PATH}`);
  console.log(`  ${series.length.toLocaleString()} series`);
  console.log(`  ${withTickers.toLocaleString()} with at least one ticker`);
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
});
