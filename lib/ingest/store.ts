import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { HoldingsSet, ProviderFund } from "@/lib/ingest/types";

/**
 * Supabase persistence for the ingestion CLI.
 *
 * Writes go through the service-role key, which bypasses RLS — it must never
 * reach the browser. Only this module and the CLI touch it, and it lives in
 * `.env.local`, which is gitignored.
 */

/*
 * Two clients, deliberately.
 *
 * Reads go through the publishable key: RLS grants public select on all three
 * tables, so serving stored holdings needs no secret. Writes go through the
 * service-role key, which bypasses RLS and must never reach the browser.
 *
 * Splitting them means the app can serve everything already stored with only
 * the publishable key configured — the service key is required solely to
 * refresh from the provider.
 */

let readClient: SupabaseClient | null = null;
let writeClient: SupabaseClient | null = null;

function supabaseUrl(): string | null {
  return (
    process.env.SUPABASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ||
    null
  );
}

function publishableKey(): string | null {
  return (
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ||
    null
  );
}

function serviceKey(): string | null {
  return process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || null;
}

/** True when stored holdings can be served. */
export function canRead(): boolean {
  return Boolean(supabaseUrl() && (publishableKey() || serviceKey()));
}

/** True when holdings can be refreshed from the provider and written back. */
export function canWrite(): boolean {
  return Boolean(supabaseUrl() && serviceKey());
}

export function getClient(): SupabaseClient {
  if (readClient) return readClient;

  const url = supabaseUrl();
  // Prefer the publishable key for reads so the secret isn't used where it
  // isn't needed; fall back to the service key if that's all that's set.
  const key = publishableKey() ?? serviceKey();

  if (!url || !key) {
    throw new Error(
      "Missing SUPABASE_URL and a Supabase key. Add them to .env.local — " +
        "see the README for where to find them in the dashboard.",
    );
  }

  readClient = createClient(url, key, { auth: { persistSession: false } });
  return readClient;
}

export function getWriteClient(): SupabaseClient {
  if (writeClient) return writeClient;

  const url = supabaseUrl();
  const key = serviceKey();

  if (!url || !key) {
    throw new Error(
      "Missing SUPABASE_SERVICE_ROLE_KEY, which is required to write holdings. " +
        "Find it in the Supabase dashboard under Project Settings -> API Keys.",
    );
  }

  writeClient = createClient(url, key, { auth: { persistSession: false } });
  return writeClient;
}

/** Insert or update the fund row, returning its id. */
export async function upsertFund(
  providerId: string,
  fund: ProviderFund,
): Promise<string> {
  const db = getWriteClient();

  const { data, error } = await db
    .from("funds")
    .upsert(
      {
        provider: providerId,
        provider_fund_id: fund.providerFundId,
        ticker: fund.ticker,
        exchange: fund.exchange,
        name: fund.name,
        asset_class: fund.assetClass,
        currency: fund.currency,
        aum: fund.aum,
        management_fee: fund.managementFee,
        inception_date: fund.inceptionDate,
        holdings_url: fund.holdingsUrl,
      },
      { onConflict: "provider,ticker" },
    )
    .select("id")
    .single();

  if (error) throw new Error(`upsert fund ${fund.ticker}: ${error.message}`);
  return data.id as string;
}

/** Rows per insert batch — large funds run to 22,000 holdings. */
const INSERT_CHUNK = 1000;

/**
 * Replace the snapshot for this (fund, date, layer) and write its holdings.
 *
 * Deleting first makes re-runs idempotent: ingesting the same day twice leaves
 * one snapshot, not two. Holdings cascade from the snapshot row, so the delete
 * clears them too.
 */
export async function writeSnapshot(
  fundId: string,
  set: HoldingsSet,
): Promise<{ inserted: number }> {
  const db = getWriteClient();

  await db
    .from("holdings_snapshots")
    .delete()
    .eq("fund_id", fundId)
    .eq("as_of", set.asOf)
    .eq("layer", set.layer);

  const totalWeight = set.holdings.reduce((s, h) => s + Math.abs(h.weight ?? 0), 0);

  const { data: snapshot, error: snapErr } = await db
    .from("holdings_snapshots")
    .insert({
      fund_id: fundId,
      as_of: set.asOf,
      layer: set.layer,
      row_count: set.holdings.length,
      total_weight: Number(totalWeight.toFixed(4)),
      source_url: set.sourceUrl,
    })
    .select("id")
    .single();

  if (snapErr) throw new Error(`insert snapshot: ${snapErr.message}`);

  const snapshotId = snapshot.id as string;
  const rows = set.holdings.map((h) => ({
    snapshot_id: snapshotId,
    position: h.position,
    ticker: h.ticker,
    name: h.name,
    sector: h.sector,
    asset_class: h.assetClass,
    weight: h.weight,
    market_value: h.marketValue,
    shares: h.shares,
    price: h.price,
    country: h.country,
    exchange: h.exchange,
    currency: h.currency,
    isin: h.isin,
    cusip: h.cusip,
    extra: h.extra,
  }));

  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const { error } = await db.from("holdings").insert(rows.slice(i, i + INSERT_CHUNK));
    if (error) throw new Error(`insert holdings: ${error.message}`);
  }

  return { inserted: rows.length };
}

export async function markIngested(fundId: string): Promise<void> {
  await getWriteClient()
    .from("funds")
    .update({ last_ingested_at: new Date().toISOString() })
    .eq("id", fundId);
}
