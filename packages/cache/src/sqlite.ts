// SQLite store for the CLI and desktop app. Runs on any driver with the
// small synchronous API that node:sqlite and bun:sqlite share; see
// ./sqlite-node.ts and ./sqlite-bun.ts, and docs/decisions/0010-cache-stores.md.

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

export type SqliteParam = string | number | Uint8Array;

export interface SqliteStatement {
  get(...params: SqliteParam[]): unknown;
  run(...params: SqliteParam[]): unknown;
}

export interface SqliteDriver {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

export interface SqliteStoreOptions extends StoreOptions {
  /** Expired rows are deleted after this many writes. */
  pruneEvery?: number;
}

const Row = (row: unknown): { value: string; expires_at: number } | undefined => {
  if (!row || typeof row !== "object") return undefined;
  const r = row as Record<string, unknown>;
  return typeof r.value === "string" && typeof r.expires_at === "number"
    ? { value: r.value, expires_at: r.expires_at }
    : undefined;
};

export class SqliteStore implements CacheStore, BlobStore {
  readonly #now: () => number;
  readonly #pruneEvery: number;
  readonly #select: SqliteStatement;
  readonly #upsert: SqliteStatement;
  readonly #delete: SqliteStatement;
  readonly #prune: SqliteStatement;
  readonly #blobSelect: SqliteStatement;
  readonly #blobUpsert: SqliteStatement;
  readonly #blobDelete: SqliteStatement;
  readonly #blobPrune: SqliteStatement;
  #writes = 0;

  constructor(driver: SqliteDriver, options: SqliteStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#pruneEvery = options.pruneEvery ?? 200;
    driver.exec(`
      CREATE TABLE IF NOT EXISTS titlesearch_cache (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS titlesearch_cache_expires ON titlesearch_cache (expires_at);
      CREATE TABLE IF NOT EXISTS titlesearch_blobs (
        key TEXT PRIMARY KEY NOT NULL,
        bytes BLOB NOT NULL,
        content_type TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS titlesearch_blobs_expires ON titlesearch_blobs (expires_at);
    `);
    this.#select = driver.prepare("SELECT value, expires_at FROM titlesearch_cache WHERE key = ?");
    this.#upsert = driver.prepare(
      `INSERT INTO titlesearch_cache (key, value, expires_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
    );
    this.#delete = driver.prepare("DELETE FROM titlesearch_cache WHERE key = ?");
    this.#prune = driver.prepare("DELETE FROM titlesearch_cache WHERE expires_at <= ?");
    this.#blobSelect = driver.prepare(
      "SELECT bytes, content_type, expires_at FROM titlesearch_blobs WHERE key = ?",
    );
    this.#blobUpsert = driver.prepare(
      `INSERT INTO titlesearch_blobs (key, bytes, content_type, expires_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET bytes = excluded.bytes, content_type = excluded.content_type,
       expires_at = excluded.expires_at`,
    );
    this.#blobDelete = driver.prepare("DELETE FROM titlesearch_blobs WHERE key = ?");
    this.#blobPrune = driver.prepare("DELETE FROM titlesearch_blobs WHERE expires_at <= ?");
  }

  async get<T>(key: string): Promise<T | undefined> {
    assertKey(key);
    const row = Row(this.#select.get(key));
    if (!row) return undefined;
    if (row.expires_at <= this.#now()) {
      this.#delete.run(key);
      return undefined;
    }
    return decodeValue<T>(row.value);
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    assertKey(key);
    assertTtl(ttlSeconds);
    const json = encodeValue(value);
    this.#upsert.run(key, json, Math.round(this.#now() + ttlSeconds * 1000));
    if (++this.#writes % this.#pruneEvery === 0) this.prune();
  }

  /** Deletes every expired row. Returns nothing; safe to call any time. */
  prune(): void {
    const now = this.#now();
    this.#prune.run(now);
    this.#blobPrune.run(now);
  }

  async getBlob(key: string): Promise<{ bytes: Uint8Array; contentType: string } | undefined> {
    assertKey(key);
    const row = this.#blobSelect.get(key) as
      | { bytes: unknown; content_type: unknown; expires_at: unknown }
      | undefined;
    if (!row || typeof row.content_type !== "string" || typeof row.expires_at !== "number")
      return undefined;
    if (!(row.bytes instanceof Uint8Array)) return undefined;
    if (row.expires_at <= this.#now()) {
      this.#blobDelete.run(key);
      return undefined;
    }
    return { bytes: new Uint8Array(row.bytes), contentType: row.content_type };
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
    this.#blobUpsert.run(key, bytes, contentType, Math.round(this.#now() + ttlSeconds * 1000));
    if (++this.#writes % this.#pruneEvery === 0) this.prune();
  }
}
