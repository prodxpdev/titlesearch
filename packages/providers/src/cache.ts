/**
 * The subset of @titlesearch/cache's CacheStore that providers use. Declared
 * structurally so providers don't depend on the cache package.
 */
export interface CacheLike {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
}

/** A process-local cache for when no store is configured. */
export function memoryCache(now: () => number = Date.now): CacheLike {
  const entries = new Map<string, { value: unknown; expires: number }>();
  return {
    async get<T>(key: string) {
      const e = entries.get(key);
      if (!e) return undefined;
      if (e.expires <= now()) {
        entries.delete(key);
        return undefined;
      }
      return e.value as T;
    },
    async set<T>(key: string, value: T, ttlSeconds: number) {
      entries.set(key, { value, expires: now() + ttlSeconds * 1000 });
    },
  };
}
