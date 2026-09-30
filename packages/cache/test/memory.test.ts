import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/memory.js";
import { blobConformance, cacheConformance } from "./conformance.js";

cacheConformance("memory", (now) => ({ store: new MemoryStore({ now }) }));
blobConformance("memory", (now) => ({ store: new MemoryStore({ now }) }));

describe("MemoryStore", () => {
  it("evicts the oldest writes beyond maxEntries", async () => {
    const store = new MemoryStore({ maxEntries: 2 });
    await store.set("a", 1, 60);
    await store.set("b", 2, 60);
    await store.set("a", 1, 60); // rewriting moves "a" to the newest position
    await store.set("c", 3, 60);
    expect([await store.get("a"), await store.get("b"), await store.get("c")]).toEqual([
      1,
      undefined,
      3,
    ]);
  });
});
