/**
 * Per-IP rate limiting for routes that can trigger upstream work.
 *
 * The concern isn't compute, it's attribution and courtesy: every US fund
 * lookup hits sec.gov carrying this deployment's contact address, and every
 * Canadian one can fetch a multi-megabyte CSV from a provider and write to
 * Supabase. A crawler walking `/fund/<anything>` would do all of that under the
 * operator's name.
 *
 * Deliberately enforced in the route handlers rather than in middleware.
 * Middleware bypass has been a recurring class of Next.js vulnerability, and a
 * limiter that can be routed around isn't one.
 *
 * ## Serverless caveat
 *
 * State is per-instance and resets on cold start, so under heavy fan-out the
 * effective ceiling is (limit x instances) rather than (limit). That is fine
 * for the actual threat here — an unattended crawler hitting one warm instance
 * — but it is not a defence against a distributed attacker. If you need that,
 * swap `hit()` for a Vercel KV or Postgres counter; the call sites don't change.
 */

interface Window {
  /** Timestamps of recent requests, oldest first. */
  hits: number[];
}

const buckets = new Map<string, Window>();

/** Rolling window length. */
const WINDOW_MS = 60_000;

/** Requests permitted per window, by cost class. */
export const LIMITS = {
  /** Cheap: search autocomplete, served from memory or one small query. */
  search: 60,
  /** A fund lookup — may trigger one filing parse or one provider CSV. */
  fund: 30,
  /** Expensive: recursive expansion across many upstream fetches. */
  lookthrough: 10,
  /** Sector enrichment, batched and rate-limited against SEC downstream. */
  enrich: 20,
} as const;

export type LimitClass = keyof typeof LIMITS;

/** Stop the map growing without bound on a long-lived instance. */
const MAX_TRACKED_IPS = 5_000;

function sweep(now: number): void {
  if (buckets.size < MAX_TRACKED_IPS) return;
  for (const [key, window] of buckets) {
    if (!window.hits.length || now - window.hits[window.hits.length - 1] > WINDOW_MS) {
      buckets.delete(key);
    }
  }
}

/**
 * Client IP as seen through Vercel's proxy.
 *
 * `x-forwarded-for` is a client-settable header in general, but on Vercel the
 * edge overwrites it, so the leftmost entry is trustworthy here. Requests with
 * no identifiable IP share one bucket rather than getting a free pass.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

export interface LimitResult {
  ok: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the oldest hit falls out of the window. */
  retryAfter: number;
}

export function hit(ip: string, cls: LimitClass): LimitResult {
  const now = Date.now();
  const limit = LIMITS[cls];
  const key = `${cls}:${ip}`;

  sweep(now);

  const window = buckets.get(key) ?? { hits: [] };
  // Drop anything that has aged out of the window.
  window.hits = window.hits.filter((t) => now - t < WINDOW_MS);

  if (window.hits.length >= limit) {
    buckets.set(key, window);
    const oldest = window.hits[0];
    return {
      ok: false,
      limit,
      remaining: 0,
      retryAfter: Math.max(1, Math.ceil((WINDOW_MS - (now - oldest)) / 1000)),
    };
  }

  window.hits.push(now);
  buckets.set(key, window);

  return {
    ok: true,
    limit,
    remaining: limit - window.hits.length,
    retryAfter: 0,
  };
}

/** Standard rate-limit headers, so clients can back off politely. */
export function limitHeaders(result: LimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    "RateLimit-Limit": String(result.limit),
    "RateLimit-Remaining": String(result.remaining),
  };
  if (!result.ok) headers["Retry-After"] = String(result.retryAfter);
  return headers;
}

/**
 * Guard a request. Returns a 429 Response when over the limit, or null to
 * proceed.
 */
export function enforce(request: Request, cls: LimitClass): Response | null {
  const result = hit(clientIp(request), cls);
  if (result.ok) return null;

  return Response.json(
    {
      error: "Too many requests",
      hint: `This deployment limits ${cls} requests to ${result.limit} per minute per IP, so that upstream data providers aren't hit hard on one operator's behalf. Try again in ${result.retryAfter}s.`,
      code: "RATE_LIMITED",
    },
    { status: 429, headers: limitHeaders(result) },
  );
}
