// SQLite store for the CLI and desktop app. Runs on any driver with the
// small synchronous API that node:sqlite and bun:sqlite share; see
// ./sqlite-node.ts and ./sqlite-bun.ts, and docs/decisions/0010-cache-stores.md.

import {
  assertKey,
  assertTtl,
  type CacheStore,
  decodeValue,
  encodeValue,
  type StoreOptions,
} from "./store.js";

export interface SqliteStatement {
  get(...params: (string | number)[]): unknown;
  run(...params: (string | number)[]): unknown;
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

export class SqliteStore implements CacheStore {
  readonly #now: () => number;
  readonly #pruneEvery: number;
  readonly #select: SqliteStatement;
  readonly #upsert: SqliteStatement;
  readonly #delete: SqliteStatement;
  readonly #prune: SqliteStatement;
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
    `);
    this.#select = driver.prepare("SELECT value, expires_at FROM titlesearch_cache WHERE key = ?");
    this.#upsert = driver.prepare(
      `INSERT INTO titlesearch_cache (key, value, expires_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
    );
    this.#delete = driver.prepare("DELETE FROM titlesearch_cache WHERE key = ?");
    this.#prune = driver.prepare("DELETE FROM titlesearch_cache WHERE expires_at <= ?");
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
    this.#prune.run(this.#now());
  }
}
