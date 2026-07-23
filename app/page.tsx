import Link from "next/link";
import { SearchBar } from "@/components/SearchBar";
import { featuredFunds } from "@/lib/providers";

export default function HomePage() {
  const featured = featuredFunds();

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-5 py-16">
      <h1
        className="text-3xl font-semibold tracking-tight"
        style={{ color: "var(--text-primary)" }}
      >
        Fund Analyzer
      </h1>
      <p className="mt-2 text-base" style={{ color: "var(--text-secondary)" }}>
        See what a fund actually holds — then keep drilling, through the funds
        inside it, down to the individual companies.
      </p>

      <div className="mt-7">
        <SearchBar autoFocus />
      </div>

      <div className="mt-9">
        <p
          className="mb-3 text-[11px] uppercase tracking-wide"
          style={{ color: "var(--text-muted)" }}
        >
          Try one of these
        </p>
        <ul className="space-y-2">
          {featured.map((f) => (
            <li key={f.query}>
              <Link
                href={`/fund/${encodeURIComponent(f.query)}`}
                className="card flex items-baseline gap-3 px-4 py-3 transition-colors"
              >
                <span
                  className="shrink-0 text-sm font-semibold"
                  style={{ color: "var(--text-primary)" }}
                >
                  {f.label}
                </span>
                <span
                  className="min-w-0 flex-1 text-xs"
                  style={{ color: "var(--text-secondary)" }}
                >
                  {f.sublabel}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>

      <p className="mt-9 text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
        US funds come from SEC EDGAR Form N-PORT filings; Canadian funds from IG
        Wealth Management&rsquo;s published regulatory disclosures. Holdings are
        as of each fund&rsquo;s most recent filing and lag the market. This is an
        informational tool, not investment advice.
      </p>
    </main>
  );
}
