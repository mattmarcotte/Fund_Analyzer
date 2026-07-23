import { NextResponse } from "next/server";
import { search } from "@/lib/providers";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get("q") ?? "";
  return NextResponse.json({ results: await search(query) });
}
