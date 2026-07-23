import { cached, TTL } from "@/lib/cache";
import { looksLikeFund } from "@/lib/fundDetect";
import { secFetch } from "@/lib/sec/client";
import {
  normalizeAssetCat,
  normalizeIssuerCat,
  toAssetClass,
} from "@/lib/sec/assetClass";
import { lookupFundTicker } from "@/lib/sec/tickers";
import { selfClosingAttr, tagBlocks, tagNumber, tagText } from "@/lib/sec/xml";
import {
  FundLookupError,
  type FundMeta,
  type FundSnapshot,
  type Holding,
} from "@/lib/types";

interface FilingRef {
  accession: string;
  cik: string;
  filedAt: string;
  indexUrl: string;
}

/**
 * EDGAR accepts a series id (S000…) in the CIK parameter, which is the only
 * clean way to get filings for one fund rather than every fund in its trust.
 */
function browseUrl(seriesId: string): string {
  const params = new URLSearchParams({
    action: "getcompany",
    CIK: seriesId,
    type: "NPORT-P",
    dateb: "",
    owner: "include",
    count: "10",
    output: "atom",
  });
  return `https://www.sec.gov/cgi-bin/browse-edgar?${params}`;
}

async function findLatestFiling(seriesId: string): Promise<FilingRef> {
  return cached(`nport:filing:${seriesId}`, TTL.FILING, async () => {
    const atom = await secFetch(browseUrl(seriesId));
    const entries = tagBlocks(atom, "entry");

    const filings: FilingRef[] = [];
    for (const entry of entries) {
      const accession = tagText(entry, "accession-number");
      const filedAt = tagText(entry, "filing-date");
      const href = tagText(entry, "filing-href");
      if (!accession || !filedAt || !href) continue;

      // The filer on the accession may be an agent, so take the CIK from the
      // archive path rather than parsing it out of the accession number.
      const cikMatch = /\/data\/(\d+)\//.exec(href);
      if (!cikMatch) continue;

      filings.push({ accession, cik: cikMatch[1], filedAt, indexUrl: href });
    }

    if (!filings.length) {
      throw new FundLookupError(
        "No N-PORT filings found for this fund",
        "NO_FILINGS",
        "Unit investment trusts (SPY, DIA, QQQ's older structure) and brand-new funds don't file N-PORT. Their holdings aren't available from EDGAR.",
      );
    }

    filings.sort((a, b) => b.filedAt.localeCompare(a.filedAt));
    return filings[0];
  });
}

function parseHolding(block: string, index: number): Holding | null {
  const name = tagText(block, "name") ?? "Unknown";
  const pct = tagNumber(block, "pctVal");
  const valueUsd = tagNumber(block, "valUSD");

  // Rows without a weight carry no analytical signal and would distort totals.
  if (pct === null && valueUsd === null) return null;

  const ticker = selfClosingAttr(block, "ticker");

  /*
   * Filers write placeholders rather than omitting an identifier they don't
   * have: "N/A" for a missing CUSIP, all-zeros for foreign securities with no
   * US identifier. Those strings are truthy, so treating them as real ids makes
   * every unidentified security collapse into a single bucket during
   * look-through merging — which reads as one holding with a colossal weight.
   */
  const cleanIdentifier = (value: string | null): string | null => {
    if (!value) return null;
    const trimmed = value.trim().toUpperCase();
    if (!trimmed || trimmed === "N/A" || trimmed === "NA" || trimmed === "NONE") {
      return null;
    }
    if (/^0+$/.test(trimmed)) return null;
    return trimmed;
  };

  const cusip = cleanIdentifier(tagText(block, "cusip"));
  const isin = cleanIdentifier(selfClosingAttr(block, "isin"));
  const lei = cleanIdentifier(tagText(block, "lei"));

  /*
   * Asset and issuer categories appear in one of two shapes. The plain element
   * is the common case, but when a filer picks "Other" the schema moves the
   * code into an attribute alongside a free-text description:
   *
   *   <assetCat>EC</assetCat>
   *   <assetConditional assetCat="OTHER" desc="ETF"/>
   *
   * Reading only the element silently classifies every ETF-of-ETF holding as
   * uncategorised, which is what turns a 60/40 fund into "Other 99.9%".
   */
  const assetCat = normalizeAssetCat(
    tagText(block, "assetCat") ??
      selfClosingAttr(block, "assetConditional", "assetCat"),
  );
  const assetDesc = selfClosingAttr(block, "assetConditional", "desc");

  const issuerCat = normalizeIssuerCat(
    tagText(block, "issuerCat") ??
      selfClosingAttr(block, "issuerConditional", "issuerCat"),
  );

  /*
   * Falls back to the name rather than the row index: the same security held
   * through two different funds must merge into one effective position, which
   * an index-based key would prevent.
   */
  const id =
    cusip ??
    isin ??
    lei ??
    `name:${name.toLowerCase().replace(/\s+/g, " ").trim()}`;

  return {
    id,
    name,
    title: tagText(block, "title"),
    cusip,
    isin,
    lei,
    ticker,
    pct: pct ?? 0,
    valueUsd: valueUsd ?? 0,
    balance: tagNumber(block, "balance"),
    units: tagText(block, "units"),
    currency: tagText(block, "curCd"),
    assetCat,
    assetClass: toAssetClass(assetCat),
    issuerCat,
    country: tagText(block, "invCountry"),
    payoffProfile: tagText(block, "payoffProfile"),
    // `desc="ETF"` is an explicit statement that this holding is a fund.
    isFund:
      looksLikeFund(name, issuerCat) || /\betf\b|\bfund\b/i.test(assetDesc ?? ""),
    sector: null,
    industry: null,
    sicCode: null,
  };
}

function parseNportDocument(
  xml: string,
  ticker: string,
  filing: FilingRef,
): FundSnapshot {
  const genInfo = tagBlocks(xml, "genInfo")[0] ?? xml;
  const fundInfo = tagBlocks(xml, "fundInfo")[0] ?? "";

  const seriesId = tagText(genInfo, "seriesId");
  if (!seriesId) {
    throw new FundLookupError(
      "The filing did not contain a recognizable N-PORT body",
      "PARSE_FAILED",
    );
  }

  const blocks = tagBlocks(xml, "invstOrSec");
  const holdings = blocks
    .map((b, i) => parseHolding(b, i))
    .filter((h): h is Holding => h !== null)
    .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));

  if (!holdings.length) {
    throw new FundLookupError(
      "The filing parsed but reported no holdings",
      "PARSE_FAILED",
      "This can happen with feeder funds that invest entirely through a master fund.",
    );
  }

  const meta: FundMeta = {
    ticker: ticker.toUpperCase(),
    registrantName: tagText(genInfo, "regName") ?? "Unknown registrant",
    seriesName: tagText(genInfo, "seriesName") ?? ticker.toUpperCase(),
    seriesId,
    cik: filing.cik,
    classId: null,
    asOf: tagText(genInfo, "repPdDate") ?? tagText(genInfo, "repPdEnd"),
    filedAt: filing.filedAt,
    accession: filing.accession,
    filingUrl: filing.indexUrl,
    totalAssets: tagNumber(fundInfo, "totAssets"),
    netAssets: tagNumber(fundInfo, "netAssets"),
    source: "sec-edgar",
    currency: "USD",
    sourceLabel: "SEC EDGAR Form N-PORT",
  };

  return {
    meta,
    holdings,
    totalPct: holdings.reduce((sum, h) => sum + Math.abs(h.pct), 0),
    holdingsArePartial: false,
  };
}

/** Fetch and parse the most recent N-PORT for a fund series. */
export async function fetchSnapshotBySeries(
  seriesId: string,
  ticker: string,
): Promise<FundSnapshot> {
  return cached(`nport:snapshot:${seriesId}`, TTL.FILING, async () => {
    const filing = await findLatestFiling(seriesId);
    const accessionPath = filing.accession.replace(/-/g, "");
    const url = `https://www.sec.gov/Archives/edgar/data/${filing.cik}/${accessionPath}/primary_doc.xml`;
    const xml = await secFetch(url);
    return parseNportDocument(xml, ticker, filing);
  });
}

/** Resolve a ticker all the way to a parsed holdings snapshot. */
export async function fetchSnapshotByTicker(
  ticker: string,
): Promise<FundSnapshot> {
  const identity = await lookupFundTicker(ticker);
  if (!identity) {
    throw new FundLookupError(
      `"${ticker.toUpperCase()}" isn't a US-registered fund ticker`,
      "UNKNOWN_TICKER",
      "Check the symbol, or note that Canadian (TSX) funds and unit investment trusts like SPY aren't in EDGAR's fund register.",
    );
  }
  return fetchSnapshotBySeries(identity.seriesId, identity.ticker);
}
