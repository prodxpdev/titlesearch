// Keyed token buckets. RDAP servers throttle per client IP, and a burst from
// a shared egress address gets everyone 429s, so each base URL gets a bucket.

export interface RateLimiter {
  /** Waits until a token for `key` is available, or rejects when `signal` aborts. */
  acquire(key: string, signal?: AbortSignal): Promise<void>;
}

export interface TokenBucketOptions {
  /** Tokens added per second. */
  ratePerSecond: number;
  /** Maximum burst. */
  capacity: number;
  /** Per-key overrides. */
  overrides?: Record<string, { ratePerSecond: number; capacity: number }>;
  /** Computed limits for keys without an override, such as by prefix. */
  limitFor?: (key: string) => { ratePerSecond: number; capacity: number } | undefined;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class TokenBucketLimiter implements RateLimiter {
  readonly #options: TokenBucketOptions;
  readonly #now: () => number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #buckets = new Map<string, { tokens: number; updated: number }>();

  constructor(options: TokenBucketOptions) {
    if (options.ratePerSecond <= 0 || options.capacity < 1) throw new Error("Invalid rate limit.");
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
    this.#sleep = options.sleep ?? abortableSleep;
  }

  async acquire(key: string, signal?: AbortSignal): Promise<void> {
    const { ratePerSecond, capacity } =
      this.#options.overrides?.[key] ?? this.#options.limitFor?.(key) ?? this.#options;
    for (;;) {
      signal?.throwIfAborted();
      const now = this.#now();
      const bucket = this.#buckets.get(key) ?? { tokens: capacity, updated: now };
      bucket.tokens = Math.min(
        capacity,
        bucket.tokens + ((now - bucket.updated) / 1000) * ratePerSecond,
      );
      bucket.updated = now;
      this.#buckets.set(key, bucket);
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return;
      }
      await this.#sleep(Math.ceil(((1 - bucket.tokens) / ratePerSecond) * 1000), signal);
    }
  }
}

/** A limiter that never waits, for tests and single-shot tools. */
export const unlimited: RateLimiter = { acquire: async () => {} };
