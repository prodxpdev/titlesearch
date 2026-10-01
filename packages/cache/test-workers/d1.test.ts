// Runs the conformance suites on D1 inside workerd (Miniflare).

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type D1Like, D1Store } from "../src/d1.js";
import { blobConformance, cacheConformance } from "../test/conformance.js";

const db = (env as unknown as { DB: D1Like }).DB;

async function fresh(now: () => number) {
  const store = new D1Store(db, { now });
  // Creates the schema, then empties it so every test starts clean.
  await store.prune();
  await db.batch([
    db.prepare("DELETE FROM titlesearch_cache"),
    db.prepare("DELETE FROM titlesearch_blobs"),
  ]);
  return { store };
}

cacheConformance("d1", fresh);
blobConformance("d1", fresh);

describe("D1Store", () => {
  it("prunes expired rows", async () => {
    let t = 1_000_000;
    const { store } = await fresh(() => t);
    await store.set("a", 1, 1);
    await store.putBlob("b", new Uint8Array([1]), "image/webp", 1);
    t += 2_000;
    await store.prune();
    const count = await db
      .prepare(
        "SELECT (SELECT COUNT(*) FROM titlesearch_cache) + (SELECT COUNT(*) FROM titlesearch_blobs) AS n",
      )
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });
});
