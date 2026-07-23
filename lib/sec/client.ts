import { FundLookupError } from "@/lib/types";

/**
 * The SEC's fair-access policy caps clients at 10 requests/second and requires
 * a User-Agent that identifies the app and a contact address. Exceeding either
 * gets the IP blocked, so every sec.gov request in this app goes through here.
 *
 * @see https://www.sec.gov/os/webmaster-faq#developers
 */
const MAX_REQUESTS_PER_SECOND = 8; // headroom under the documented 10
const MIN_INTERVAL_MS = 1000 / MAX_REQUESTS_PER_SECOND;

const DEFAULT_USER_AGENT = "Fund Analyzer (contact: set SEC_USER_AGENT)";

function userAgent(): string {
  return process.env.SEC_USER_AGENT?.trim() || DEFAULT_USER_AGENT;
}

/**
 * Serialized request gate. Each call waits until at least MIN_INTERVAL_MS has
 * elapsed since the previous one started, which smooths bursts into a steady
 * rate rather than letting Promise.all fire 500 requests at once.
 */
let nextSlot = 0;

function reserveSlot(): Promise<void> {
  const now = Date.now();
  const start = Math.max(now, nextSlot);
  nextSlot = start + MIN_INTERVAL_MS;
  const wait = start - now;
  return wait <= 0
    ? Promise.resolve()
    : new Promise((resolve) => setTimeout(resolve, wait));
}

interface SecFetchOptions {
  /** Retries on 429/5xx with exponential backoff. */
  retries?: number;
  accept?: string;
  signal?: AbortSignal;
}

export async function secFetch(
  url: string,
  { retries = 2, accept, signal }: SecFetchOptions = {},
): Promise<string> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    await reserveSlot();

    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": userAgent(),
          "Accept-Encoding": "gzip, deflate",
          ...(accept ? { Accept: accept } : {}),
        },
        signal,
        // We do our own caching; Next's fetch cache would blow past its 2MB
        // entry limit on large N-PORT documents.
        cache: "no-store",
      });

      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`SEC returned ${res.status} for ${url}`);
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
          continue;
        }
      }

      if (!res.ok) {
        throw new FundLookupError(
          `SEC request failed with ${res.status}`,
          "UPSTREAM_ERROR",
          res.status === 403
            ? "The SEC blocks requests without a descriptive User-Agent. Set SEC_USER_AGENT to \"AppName your@email.com\"."
            : undefined,
        );
      }

      return await res.text();
    } catch (err) {
      if (err instanceof FundLookupError) throw err;
      lastError = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
  }

  throw new FundLookupError(
    `Could not reach the SEC after ${retries + 1} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
    "UPSTREAM_ERROR",
  );
}

export async function secFetchJson<T>(url: string): Promise<T> {
  const text = await secFetch(url, { accept: "application/json" });
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new FundLookupError(
      `Expected JSON from ${url} but got something else`,
      "UPSTREAM_ERROR",
    );
  }
}
