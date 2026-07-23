import Link from "next/link";
import { FundDashboard } from "@/components/FundDashboard";
import { SearchBar } from "@/components/SearchBar";
import { formatDate } from "@/components/format";
import { fetchSnapshot } from "@/lib/providers";
import { FundLookupError } from "@/lib/types";

/** Filings are fetched live and cached in-process; never prerender. */
export const dynamic = "force-dynamic";

export default async function FundPage({
  params,
}: {
  params: Promise<{ query: string }>;
}) {
  const { query } = await params;
  const decoded = decodeURIComponent(query);

  let snapshot;
  let error: { message: string; hint?: string } | null = null;

  try {
    snapshot = await fetchSnapshot(decoded);
  } catch (err) {
    error =
      err instanceof FundLookupError
        ? { message: err.message, hint: err.hint }
        : {
            message:
              err instanceof Error ? err.message : "Something went wrong.",
          };
  }

  return (
    <main className="mx-auto max-w-5xl px-5 py-8">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center">
        <Link
          href="/"
          className="shrink-0 text-sm font-semibold"
          style={{ color: "var(--text-primary)" }}
        >
          Fund Analyzer
        </Link>
        <div className="flex-1">
          <SearchBar initialValue={snapshot ? "" : decoded} />
        </div>
      </div>

      {error && (
        <div className="card p-6">
          <h1
            className="text-lg font-semibold"
            style={{ color: "var(--text-primary)" }}
          >
            {error.message}
          </h1>
          {error.hint && (
            <p
              className="mt-2 text-sm leading-relaxed"
              style={{ color: "var(--text-secondary)" }}
            >
              {error.hint}
            </p>
          )}
          <Link
            href="/"
            className="mt-4 inline-block text-sm underline"
            style={{ color: "var(--seq-400)" }}
          >
            Back to search
          </Link>
        </div>
      )}

      {snapshot && (
        <>
          <header className="mb-5">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h1
                className="text-2xl font-semibold tracking-tight"
                style={{ color: "var(--text-primary)" }}
              >
                {snapshot.meta.seriesName}
              </h1>
              {snapshot.meta.source === "sec-edgar" && (
                <span
                  className="rounded px-1.5 py-0.5 text-xs font-semibold"
                  style={{
                    background: "var(--gridline)",
                    color: "var(--text-secondary)",
                  }}
                >
                  {snapshot.meta.ticker}
                </span>
              )}
            </div>

            <p
              className="mt-1.5 text-xs"
              style={{ color: "var(--text-muted)" }}
            >
              {snapshot.meta.registrantName} · holdings as of{" "}
              {formatDate(snapshot.meta.asOf)} ·{" "}
              {snapshot.meta.filingUrl ? (
                <a
                  href={snapshot.meta.filingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  {snapshot.meta.sourceLabel}
                </a>
              ) : (
                snapshot.meta.sourceLabel
              )}
            </p>
          </header>

          <FundDashboard snapshot={snapshot} />

          <p
            className="mt-8 text-xs leading-relaxed"
            style={{ color: "var(--text-muted)" }}
          >
            Holdings reflect the fund&rsquo;s most recent regulatory filing and
            lag the market — US funds report quarterly with up to a 60-day delay.
            Percentages are of net assets as reported. Informational only; not
            investment advice.
          </p>
        </>
      )}
    </main>
  );
}
