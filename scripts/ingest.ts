/**
 * Holdings ingestion CLI.
 *
 *   npm run ingest -- --top 100          # 100 largest funds by AUM (default)
 *   npm run ingest -- --all              # every fund the providers list
 *   npm run ingest -- --ticker XEQT,XIU  # named funds only
 *   npm run ingest -- --provider ishares-ca
 *   npm run ingest -- --top 5 --dry-run  # fetch and parse, write nothing
 *
 * Designed to run locally or in CI, not in a serverless function: a full pass
 * pulls hundreds of megabytes of CSV (XGRO alone is 5.5MB / 22k rows), which
 * would blow past request timeouts.
 *
 * Re-running is safe. Snapshots are keyed by (fund, date, layer) and replaced
 * on conflict, so ingesting the same day twice leaves one copy.
 */

import { providers, providerById } from "@/lib/ingest/providers";
import { markIngested, upsertFund, writeSnapshot } from "@/lib/ingest/store";
import type { EtfProvider, ProviderFund } from "@/lib/ingest/types";

interface Options {
  top: number | null;
  all: boolean;
  tickers: string[] | null;
  providerId: string | null;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    top: null,
    all: false,
    tickers: null,
    providerId: null,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--all") opts.all = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--top") opts.top = Number(argv[++i]);
    else if (arg === "--ticker") {
      opts.tickers = (argv[++i] ?? "")
        .split(",")
        .map((t) => t.trim().toUpperCase())
        .filter(Boolean);
    } else if (arg === "--provider") opts.providerId = argv[++i] ?? null;
  }

  // Default to the top 100 rather than everything: it's the useful set and
  // keeps an unqualified run from pulling every fund on offer.
  if (!opts.all && !opts.tickers && opts.top === null) opts.top = 100;
  return opts;
}

function selectFunds(funds: ProviderFund[], opts: Options): ProviderFund[] {
  if (opts.tickers) {
    return funds.filter((f) => opts.tickers!.includes(f.ticker.toUpperCase()));
  }
  if (opts.all) return funds;
  return funds.slice(0, opts.top ?? 100);
}

interface Tally {
  funds: number;
  snapshots: number;
  holdings: number;
  failures: { ticker: string; reason: string }[];
}

async function ingestProvider(
  provider: EtfProvider,
  opts: Options,
  tally: Tally,
): Promise<void> {
  console.log(`\n${provider.label}`);
  console.log("  listing funds…");

  const all = await provider.listFunds();
  const selected = selectFunds(all, opts);

  console.log(`  ${all.length} available, ingesting ${selected.length}\n`);

  for (const [i, fund] of selected.entries()) {
    const label = `[${String(i + 1).padStart(3)}/${selected.length}] ${fund.ticker.padEnd(6)}`;

    try {
      const sets = await provider.fetchHoldings(fund);

      if (!sets.length) {
        console.log(`  ${label} no holdings published`);
        tally.failures.push({ ticker: fund.ticker, reason: "no holdings published" });
        continue;
      }

      if (opts.dryRun) {
        const summary = sets
          .map((s) => `${s.layer} ${s.holdings.length} rows @ ${s.asOf}`)
          .join(", ");
        console.log(`  ${label} ${summary}  (dry run)`);
        tally.funds++;
        tally.snapshots += sets.length;
        tally.holdings += sets.reduce((n, s) => n + s.holdings.length, 0);
        continue;
      }

      const fundId = await upsertFund(provider.id, fund);
      const written: string[] = [];

      for (const set of sets) {
        const { inserted } = await writeSnapshot(fundId, set);
        written.push(`${set.layer} ${inserted}`);
        tally.snapshots++;
        tally.holdings += inserted;
      }

      await markIngested(fundId);
      tally.funds++;
      console.log(`  ${label} ${written.join(", ")}  @ ${sets[0].asOf}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.log(`  ${label} FAILED — ${reason.slice(0, 90)}`);
      tally.failures.push({ ticker: fund.ticker, reason });
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const targets = opts.providerId
    ? [providerById(opts.providerId)].filter((p): p is EtfProvider => Boolean(p))
    : providers;

  if (!targets.length) {
    console.error(
      `Unknown provider "${opts.providerId}". Available: ${providers
        .map((p) => p.id)
        .join(", ")}`,
    );
    process.exit(1);
  }

  const started = Date.now();
  const tally: Tally = { funds: 0, snapshots: 0, holdings: 0, failures: [] };

  for (const provider of targets) {
    await ingestProvider(provider, opts, tally);
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(0);

  console.log(`\n${"─".repeat(52)}`);
  console.log(`  funds      ${tally.funds}`);
  console.log(`  snapshots  ${tally.snapshots}`);
  console.log(`  holdings   ${tally.holdings.toLocaleString()}`);
  console.log(`  elapsed    ${elapsed}s${opts.dryRun ? "   (dry run — nothing written)" : ""}`);

  if (tally.failures.length) {
    console.log(`\n  ${tally.failures.length} failed:`);
    for (const f of tally.failures.slice(0, 15)) {
      console.log(`    ${f.ticker.padEnd(7)} ${f.reason.slice(0, 80)}`);
    }
  }
  console.log();
}

main().catch((err) => {
  console.error(`\nIngestion failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
