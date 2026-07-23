/**
 * Process-local TTL cache.
 *
 * On Vercel this lives for the life of a warm lambda instance, which is enough
 * to make drill-down interactions cheap (a look-through pass hits the same
 * ticker maps and SIC lookups dozens of times). It is deliberately not a
 * durable store — if you outgrow it, swap the two functions below for Vercel KV
 * without touching any call sites.
 */

interface Entry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, Entry<unknown>>();

/** In-flight promises, so N concurrent callers for one key make one request. */
const inflight = new Map<string, Promise<unknown>>();

export const TTL = {
  /** Ticker maps change when funds launch/close — daily is plenty. */
  TICKER_MAP: 24 * 60 * 60 * 1000,
  /** N-PORT is filed quarterly; an hour keeps a browsing session consistent. */
  FILING: 60 * 60 * 1000,
  /** A company's SIC code effectively never changes. */
  SIC: 7 * 24 * 60 * 60 * 1000,
} as const;

export function cacheGet<T>(key: string): T | undefined {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt < Date.now()) {
    store.delete(key);
    return undefined;
  }
  return hit.value as T;
}

export function cacheSet<T>(key: string, value: T, ttlMs: number): void {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/**
 * Cache-aside with request coalescing. Concurrent misses on the same key share
 * a single `fetcher` call — important when a look-through expands ten sibling
 * funds that all need the same ticker map.
 */
export async function cached<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const hit = cacheGet<T>(key);
  if (hit !== undefined) return hit;

  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  const promise = (async () => {
    try {
      const value = await fetcher();
      cacheSet(key, value, ttlMs);
      return value;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}
