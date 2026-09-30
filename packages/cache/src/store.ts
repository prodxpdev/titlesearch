// The cache contract. Every store (memory, sqlite, d1, firestore, dynamodb)
// passes test/conformance.ts, which pins down the behavior below.

export interface CacheStore {
  /** Returns the value, or undefined if it's missing or expired. */
  get<T>(key: string): Promise<T | undefined>;
  /**
   * Stores a JSON-serializable value for `ttlSeconds` (a positive, finite
   * number). Replaces any existing value and TTL. Values round-trip through
   * JSON, so what `get` returns is a copy.
   */
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
}

/** Options every store accepts. */
export interface StoreOptions {
  /** Milliseconds since the epoch. Injected so tests control expiry. */
  now?: () => number;
}

export const MAX_KEY_LENGTH = 512;
/**
 * Encoded values are capped below DynamoDB's 400 KB item limit, the smallest
 * of the backends, so every store behaves the same.
 */
export const MAX_VALUE_BYTES = 256 * 1024;

export function assertKey(key: string): void {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_LENGTH) {
    throw new RangeError(`Cache keys must be 1 to ${MAX_KEY_LENGTH} characters.`);
  }
}

export function assertTtl(ttlSeconds: number): void {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new RangeError("ttlSeconds must be a positive, finite number.");
  }
}

/** JSON-encodes a value, rejecting undefined, non-JSON values, and oversized values. */
export function encodeValue(value: unknown): string {
  if (value === undefined) throw new TypeError("undefined can't be cached; it means a miss.");
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError("Only JSON-serializable values can be cached.");
  if (new TextEncoder().encode(json).byteLength > MAX_VALUE_BYTES) {
    throw new RangeError(`Cached values are limited to ${MAX_VALUE_BYTES} bytes as JSON.`);
  }
  return json;
}

export function decodeValue<T>(json: string): T {
  return JSON.parse(json) as T;
}
