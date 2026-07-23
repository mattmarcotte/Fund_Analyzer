import { NextResponse } from "next/server";
import { enrichHoldings, type EnrichRequestItem } from "@/lib/enrich";
import { enforce } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Bounded so one request can't fan out into hundreds of SEC lookups. */
const MAX_BATCH = 50;

export async function POST(request: Request) {
  const limited = enforce(request, "enrich");
  if (limited) return limited;

  try {
    const body = (await request.json()) as { items?: EnrichRequestItem[] };
    const items = (body.items ?? []).slice(0, MAX_BATCH);

    if (!items.length) {
      return NextResponse.json({ results: [] });
    }

    const results = await enrichHoldings(items);
    return NextResponse.json({ results });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Enrichment failed" },
      { status: 500 },
    );
  }
}
