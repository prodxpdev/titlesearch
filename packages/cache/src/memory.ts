// In-process store for tests, single-shot CLI runs, and as a fallback.

import {
  assertBlob,
  assertKey,
  assertTtl,
  type BlobStore,
  type CacheStore,
  decodeValue,
  encodeValue,
  type StoreOptions,
} from "./store.js";

export interface MemoryStoreOptions extends StoreOptions {
  /** Oldest entries are evicted beyond this many. */
  maxEntries?: number;
}

export class MemoryStore implements CacheStore, BlobStore {
  readonly #entries = new Map<string, { json: string; expires: number }>();
  readonly #blobs = new Map<string, { bytes: Uint8Array; contentType: string; expires: number }>();
  readonly #now: () => number;
  readonly #maxEntries: number;

  constructor(options: MemoryStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#maxEntries = options.maxEntries ?? 10_000;
  }

  async get<T>(key: string): Promise<T | undefined> {
    assertKey(key);
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= this.#now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return decodeValue<T>(entry.json);
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    assertKey(key);
    assertTtl(ttlSeconds);
    const json = encodeValue(value);
    // Re-inserting moves the key to the end, so eviction takes the oldest write.
    this.#entries.delete(key);
    this.#entries.set(key, { json, expires: this.#now() + ttlSeconds * 1000 });
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  async getBlob(key: string): Promise<{ bytes: Uint8Array; contentType: string } | undefined> {
    assertKey(key);
    const b = this.#blobs.get(key);
    if (!b) return undefined;
    if (b.expires <= this.#now()) {
      this.#blobs.delete(key);
      return undefined;
    }
    return { bytes: b.bytes.slice(), contentType: b.contentType };
  }

  async putBlob(
    key: string,
    bytes: Uint8Array,
    contentType: string,
    ttlSeconds: number,
  ): Promise<void> {
    assertKey(key);
    assertTtl(ttlSeconds);
    assertBlob(bytes, contentType);
    this.#blobs.delete(key);
    this.#blobs.set(key, {
      bytes: bytes.slice(),
      contentType,
      expires: this.#now() + ttlSeconds * 1000,
    });
    while (this.#blobs.size > this.#maxEntries) {
      const oldest = this.#blobs.keys().next().value;
      if (oldest === undefined) break;
      this.#blobs.delete(oldest);
    }
  }
}
