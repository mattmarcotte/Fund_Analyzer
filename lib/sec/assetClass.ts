import type { AssetCategory, AssetClass, IssuerCategory } from "@/lib/types";

/**
 * N-PORT `assetCat` code -> human label, straight from the form's code list.
 * @see https://www.sec.gov/files/formn-port.pdf (Item C.4.a)
 */
const ASSET_CAT_LABELS: Record<string, string> = {
  EC: "Equity — common",
  EP: "Equity — preferred",
  DBT: "Debt",
  "ABS-MBS": "Mortgage-backed",
  "ABS-ABSCDO": "Asset-backed CDO",
  "ABS-O": "Asset-backed — other",
  ACOM: "Commodity",
  COMM: "Commodity",
  DE: "Derivative",
  RE: "Real estate",
  LON: "Loan",
  SN: "Structured note",
  STIV: "Short-term investment",
  RA: "Repurchase agreement",
  UST: "US Treasury",
  OTHER: "Other",
};

/** Roll-up used by the headline allocation chart. */
const ASSET_CLASS_BY_CAT: Record<string, AssetClass> = {
  EC: "Equity",
  EP: "Equity",
  DBT: "Fixed Income",
  "ABS-MBS": "Fixed Income",
  "ABS-ABSCDO": "Fixed Income",
  "ABS-O": "Fixed Income",
  SN: "Fixed Income",
  LON: "Fixed Income",
  UST: "Fixed Income",
  STIV: "Cash & Equivalents",
  RA: "Cash & Equivalents",
  RE: "Real Estate",
  ACOM: "Commodities",
  COMM: "Commodities",
  DE: "Derivatives",
  OTHER: "Other",
};

export function normalizeAssetCat(raw: string | null): AssetCategory {
  if (!raw) return "OTHER";
  const code = raw.trim().toUpperCase();
  return (code in ASSET_CAT_LABELS ? code : "OTHER") as AssetCategory;
}

export function assetCatLabel(cat: AssetCategory): string {
  return ASSET_CAT_LABELS[cat] ?? "Other";
}

export function toAssetClass(cat: AssetCategory): AssetClass {
  return ASSET_CLASS_BY_CAT[cat] ?? "Other";
}

export function normalizeIssuerCat(raw: string | null): IssuerCategory {
  if (!raw) return "OTHER";
  const code = raw.trim().toUpperCase();
  const known: IssuerCategory[] = [
    "CORP",
    "UST",
    "USGSE",
    "MUN",
    "NUSS",
    "RF",
    "PF",
    "GSE",
  ];
  return (known as string[]).includes(code) ? (code as IssuerCategory) : "OTHER";
}

const ISSUER_CAT_LABELS: Record<IssuerCategory, string> = {
  CORP: "Corporate",
  UST: "US Treasury",
  USGSE: "US Govt agency",
  MUN: "Municipal",
  NUSS: "Non-US sovereign",
  RF: "Registered fund",
  PF: "Private fund",
  GSE: "Govt-sponsored entity",
  OTHER: "Other",
};

export function issuerCatLabel(cat: IssuerCategory): string {
  return ISSUER_CAT_LABELS[cat];
}
