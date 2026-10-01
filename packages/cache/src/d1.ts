// D1 store for the Workers target. Same schema as the SQLite store, over D1's
// asynchronous API. The schema is created on first use; it's also in
// deploy/workers/migrations for `wrangler d1 migrations apply`.

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

/** The part of D1's binding this store uses, so the package needs no Workers types. */
export interface D1Like {
  prepare(sql: string): D1StatementLike;
  batch(statements: D1StatementLike[]): Promise<unknown[]>;
}
export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
}

export const D1_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS titlesearch_cache (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS titlesearch_cache_expires ON titlesearch_cache (expires_at)",
  `CREATE TABLE IF NOT EXISTS titlesearch_blobs (
    key TEXT PRIMARY KEY NOT NULL,
    bytes BLOB NOT NULL,
    content_type TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS titlesearch_blobs_expires ON titlesearch_blobs (expires_at)",
];

export interface D1StoreOptions extends StoreOptions {
  /** Expired rows are deleted after this many writes from this isolate. */
  pruneEvery?: number;
}

export class D1Store implements CacheStore, BlobStore {
  readonly #db: D1Like;
  readonly #now: () => number;
  readonly #pruneEvery: number;
  #ready: Promise<void> | undefined;
  #writes = 0;

  constructor(db: D1Like, options: D1StoreOptions = {}) {
    this.#db = db;
    this.#now = options.now ?? Date.now;
    this.#pruneEvery = options.pruneEvery ?? 200;
  }

  #init(): Promise<void> {
    this.#ready ??= this.#db
      .batch(D1_SCHEMA.map((sql) => this.#db.prepare(sql)))
      .then(() => undefined)
      .catch((err) => {
        this.#ready = undefined;
        throw err;
      });
    return this.#ready;
  }

  async get<T>(key: string): Promise<T | undefined> {
    assertKey(key);
    await this.#init();
    const row = await this.#db
      .prepare("SELECT value, expires_at FROM titlesearch_cache WHERE key = ?")
      .bind(key)
      .first<{ value: unknown; expires_at: unknown }>();
    if (!row || typeof row.value !== "string" || typeof row.expires_at !== "number")
      return undefined;
    if (row.expires_at <= this.#now()) {
      await this.#db.prepare("DELETE FROM titlesearch_cache WHERE key = ?").bind(key).run();
      return undefined;
    }
    return decodeValue<T>(row.value);
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    assertKey(key);
    assertTtl(ttlSeconds);
    const json = encodeValue(value);
    await this.#init();
    await this.#db
      .prepare(
        `INSERT INTO titlesearch_cache (key, value, expires_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
      )
      .bind(key, json, Math.round(this.#now() + ttlSeconds * 1000))
      .run();
    await this.#maybePrune();
  }

  async getBlob(key: string): Promise<{ bytes: Uint8Array; contentType: string } | undefined> {
    assertKey(key);
    await this.#init();
    const row = await this.#db
      .prepare("SELECT bytes, content_type, expires_at FROM titlesearch_blobs WHERE key = ?")
      .bind(key)
      .first<{ bytes: unknown; content_type: unknown; expires_at: unknown }>();
    if (!row || typeof row.content_type !== "string" || typeof row.expires_at !== "number")
      return undefined;
    if (row.expires_at <= this.#now()) {
      await this.#db.prepare("DELETE FROM titlesearch_blobs WHERE key = ?").bind(key).run();
      return undefined;
    }
    // D1 returns BLOB columns as an ArrayBuffer or an array of byte values.
    const b = row.bytes;
    const bytes =
      b instanceof ArrayBuffer
        ? new Uint8Array(b.slice(0))
        : b instanceof Uint8Array
          ? new Uint8Array(b)
          : Array.isArray(b)
            ? Uint8Array.from(b as number[])
            : undefined;
    if (!bytes) return undefined;
    return { bytes, contentType: row.content_type };
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
    await this.#init();
    await this.#db
      .prepare(
        `INSERT INTO titlesearch_blobs (key, bytes, content_type, expires_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET bytes = excluded.bytes,
         content_type = excluded.content_type, expires_at = excluded.expires_at`,
      )
      .bind(key, bytes, contentType, Math.round(this.#now() + ttlSeconds * 1000))
      .run();
    await this.#maybePrune();
  }

  /** Deletes every expired row. */
  async prune(): Promise<void> {
    await this.#init();
    const now = this.#now();
    await this.#db.batch([
      this.#db.prepare("DELETE FROM titlesearch_cache WHERE expires_at <= ?").bind(now),
      this.#db.prepare("DELETE FROM titlesearch_blobs WHERE expires_at <= ?").bind(now),
    ]);
  }

  async #maybePrune(): Promise<void> {
    if (++this.#writes % this.#pruneEvery === 0) await this.prune();
  }
}
