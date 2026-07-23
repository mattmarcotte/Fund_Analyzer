import { NextResponse } from "next/server";
import { search } from "@/lib/providers";
import { enforce } from "@/lib/rateLimit";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const limited = enforce(request, "search");
  if (limited) return limited;

  const query = new URL(request.url).searchParams.get("q") ?? "";
  return NextResponse.json({ results: await search(query) });
}
