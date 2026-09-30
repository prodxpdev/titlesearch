// Runs the conformance suite on node:sqlite (Node and Bun) and bun:sqlite
// (Bun only), plus SQLite-specific behavior: persistence and pruning.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type SqliteDriver, SqliteStore } from "../src/sqlite.js";
import { openNodeSqlite } from "../src/sqlite-node.js";
import { blobConformance, cacheConformance } from "./conformance.js";

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

cacheConformance("sqlite via node:sqlite", (now) => {
  const db = openNodeSqlite(":memory:");
  return { store: new SqliteStore(db, { now }), close: () => db.close() };
});

blobConformance("sqlite via node:sqlite", (now) => {
  const db = openNodeSqlite(":memory:");
  return { store: new SqliteStore(db, { now }), close: () => db.close() };
});

if (isBun) {
  blobConformance("sqlite via bun:sqlite", async (now) => {
    const { openBunSqlite } = await import("../src/sqlite-bun.js");
    const db = openBunSqlite(":memory:");
    return { store: new SqliteStore(db, { now }), close: () => db.close() };
  });
  cacheConformance("sqlite via bun:sqlite", async (now) => {
    const { openBunSqlite } = await import("../src/sqlite-bun.js");
    const db = openBunSqlite(":memory:");
    return { store: new SqliteStore(db, { now }), close: () => db.close() };
  });
}

describe("SqliteStore", () => {
  const dir = mkdtempSync(join(tmpdir(), "titlesearch-cache-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("persists across reopening the file", async () => {
    const path = join(dir, "persist.db");
    const first = openNodeSqlite(path);
    await new SqliteStore(first).set("k", { v: 1 }, 60);
    first.close();
    const second = openNodeSqlite(path);
    await expect(new SqliteStore(second).get("k")).resolves.toEqual({ v: 1 });
    second.close();
  });

  it("prunes expired rows", async () => {
    let time = 0;
    const db = openNodeSqlite(":memory:");
    const count = () =>
      (db.prepare("SELECT count(*) AS n FROM titlesearch_cache").get() as { n: number }).n;
    const store = new SqliteStore(db, { now: () => time, pruneEvery: 1_000_000 });
    await store.set("old", 1, 1);
    await store.set("new", 2, 100);
    time = 5_000;
    store.prune();
    expect(count()).toBe(1);
    db.close();
  });

  it("prunes automatically every N writes", async () => {
    let time = 0;
    const db: SqliteDriver & { close(): void } = openNodeSqlite(":memory:");
    const count = () =>
      (db.prepare("SELECT count(*) AS n FROM titlesearch_cache").get() as { n: number }).n;
    const store = new SqliteStore(db, { now: () => time, pruneEvery: 3 });
    await store.set("a", 1, 1);
    await store.set("b", 1, 1);
    time = 2_000;
    await store.set("c", 1, 60); // third write triggers a prune of a and b
    expect(count()).toBe(1);
    db.close();
  });
});
