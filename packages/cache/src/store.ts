// The cache contract. Every store (memory, sqlite, d1, firestore, dynamodb)
// passes test/conformance.ts, which pins down the behavior below.

export type { BlobStore, CacheStore } from "@titlesearch/core";

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

/** Blobs (preview images) are capped well above a 1280 by 800 WebP, and below object-store single-put limits. */
export const MAX_BLOB_BYTES = 1024 * 1024;

export function assertBlob(bytes: Uint8Array, contentType: string): void {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("Blobs must be Uint8Array.");
  if (bytes.byteLength > MAX_BLOB_BYTES)
    throw new RangeError(`Blobs are limited to ${MAX_BLOB_BYTES} bytes.`);
  if (!/^[a-z]+\/[a-z0-9.+-]+$/.test(contentType))
    throw new TypeError("Give a content type such as image/webp.");
}
