"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { SearchResult } from "@/lib/providers";

export function SearchBar({
  initialValue = "",
  autoFocus = false,
}: {
  initialValue?: string;
  autoFocus?: boolean;
}) {
  const router = useRouter();
  const [value, setValue] = useState(initialValue);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const q = value.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }

    // Debounced so typing a ticker doesn't fire a request per keystroke.
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const data = (await res.json()) as { results: SearchResult[] };
        setResults(data.results ?? []);
        setHighlighted(0);
      } catch {
        setResults([]);
      }
    }, 160);

    return () => clearTimeout(timer);
  }, [value]);

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const go = (query: string) => {
    if (!query.trim()) return;
    setOpen(false);
    router.push(`/fund/${encodeURIComponent(query.trim())}`);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open || !results.length) {
      if (e.key === "Enter") go(value);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((h) => (h + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((h) => (h - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(results[highlighted]?.query ?? value);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div ref={containerRef} className="relative w-full">
      <input
        type="text"
        value={value}
        autoFocus={autoFocus}
        spellCheck={false}
        autoComplete="off"
        placeholder="Ticker or fund name — VOO, AOR, IG Mackenzie Canadian Equity…"
        aria-label="Search for a fund by ticker or name"
        onChange={(e) => {
          setValue(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        className="w-full rounded-lg px-4 py-3 text-base outline-none transition-shadow focus:ring-2"
        style={{
          background: "var(--surface-1)",
          color: "var(--text-primary)",
          border: "1px solid var(--border-hairline)",
        }}
      />

      {open && results.length > 0 && (
        <ul
          className="absolute z-20 mt-1.5 max-h-80 w-full overflow-auto rounded-lg py-1 shadow-lg"
          style={{
            background: "var(--surface-1)",
            border: "1px solid var(--border-hairline)",
          }}
        >
          {results.map((r, i) => (
            <li key={`${r.provider}-${r.query}`}>
              <button
                type="button"
                onMouseEnter={() => setHighlighted(i)}
                onClick={() => go(r.query)}
                className="flex w-full items-baseline gap-3 px-3 py-2 text-left"
                style={{
                  background:
                    i === highlighted ? "var(--gridline)" : "transparent",
                }}
              >
                <span
                  className="shrink-0 text-sm font-semibold"
                  style={{ color: "var(--text-primary)" }}
                >
                  {r.label}
                </span>
                <span
                  className="min-w-0 flex-1 truncate text-xs"
                  style={{ color: "var(--text-secondary)" }}
                >
                  {r.sublabel}
                </span>
                <span
                  className="shrink-0 text-[10px] uppercase tracking-wide"
                  style={{ color: "var(--text-muted)" }}
                >
                  {r.provider === "ig-wealth" ? "CA" : "US"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
