import { NextResponse } from "next/server";
import { fetchSnapshot } from "@/lib/providers";
import { FundLookupError } from "@/lib/types";

/** N-PORT parsing is CPU- and memory-heavy; keep it off the edge runtime. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ query: string }> },
) {
  const { query } = await params;

  try {
    const snapshot = await fetchSnapshot(decodeURIComponent(query));
    return NextResponse.json(snapshot);
  } catch (err) {
    if (err instanceof FundLookupError) {
      return NextResponse.json(
        { error: err.message, code: err.code, hint: err.hint },
        { status: err.code === "UNKNOWN_TICKER" ? 404 : 502 },
      );
    }
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Unexpected error",
        code: "UPSTREAM_ERROR",
      },
      { status: 500 },
    );
  }
}
