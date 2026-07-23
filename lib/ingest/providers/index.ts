import { isharesCa } from "@/lib/ingest/providers/isharesCa";
import type { EtfProvider } from "@/lib/ingest/types";

/**
 * Registered ingestion providers.
 *
 * Vanguard Canada exposes a JSON API keyed by `portId`, and BMO is not yet
 * mapped; both slot in here once written, with no changes to the CLI or store.
 */
export const providers: EtfProvider[] = [isharesCa];

export function providerById(id: string): EtfProvider | undefined {
  return providers.find((p) => p.id === id);
}
