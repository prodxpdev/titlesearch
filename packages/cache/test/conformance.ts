// The shared CacheStore conformance suite. Every store (memory, sqlite, d1,
// firestore, dynamodb) runs this against a controllable clock:
//
//   cacheConformance("sqlite (node)", (now) => ({ store: new SqliteStore(open(":memory:"), { now }) }));

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CacheStore, MAX_KEY_LENGTH, MAX_VALUE_BYTES } from "../src/store.js";

export interface ConformanceSubject {
  store: CacheStore;
  close?: () => void | Promise<void>;
}

export type SubjectFactory = (
  now: () => number,
) => ConformanceSubject | Promise<ConformanceSubject>;

export function cacheConformance(name: string, factory: SubjectFactory): void {
  describe(`CacheStore conformance: ${name}`, () => {
    let time = Date.parse("2026-09-30T12:00:00Z");
    let subject: ConformanceSubject;
    let store: CacheStore;
    const advance = (ms: number) => {
      time += ms;
    };

    beforeEach(async () => {
      time = Date.parse("2026-09-30T12:00:00Z");
      subject = await factory(() => time);
      store = subject.store;
    });
    afterEach(async () => {
      await subject.close?.();
    });

    describe("reads and writes", () => {
      it("returns undefined for a missing key", async () => {
        await expect(store.get("missing")).resolves.toBeUndefined();
      });

      it.each([
        ["an object", { domain: "acme.io", sources: [{ source: "rdap", latencyMs: 12.5 }] }],
        ["an array", [1, "two", { three: [3] }]],
        ["a string", "plain"],
        ["an empty string", ""],
        ["unicode", "münchen 例え 😀 \u0000  "],
        ["zero", 0],
        ["a negative float", -12.75],
        ["true", true],
        ["false", false],
        ["null", null],
        ["an empty object", {}],
      ])("round-trips %s", async (_label, value) => {
        await store.set("k", value, 60);
        await expect(store.get("k")).resolves.toEqual(value);
      });

      it("stores dates as ISO strings, as JSON does", async () => {
        await store.set("k", { at: new Date("2026-09-30T12:00:00Z") }, 60);
        await expect(store.get("k")).resolves.toEqual({ at: "2026-09-30T12:00:00.000Z" });
      });

      it("returns copies, not shared references", async () => {
        const value = { list: [1, 2] };
        await store.set("k", value, 60);
        value.list.push(3);
        const first = await store.get<{ list: number[] }>("k");
        first?.list.push(4);
        await expect(store.get("k")).resolves.toEqual({ list: [1, 2] });
      });

      it("replaces a value", async () => {
        await store.set("k", "old", 60);
        await store.set("k", "new", 60);
        await expect(store.get("k")).resolves.toBe("new");
      });

      it("keeps keys independent and case-sensitive", async () => {
        await store.set("Key", 1, 60);
        await store.set("key", 2, 60);
        await store.set("ts:v1:avail:rdap:acme.io", 3, 60);
        await store.set("ключ", 4, 60);
        expect(
          await Promise.all(
            ["Key", "key", "ts:v1:avail:rdap:acme.io", "ключ"].map((k) => store.get(k)),
          ),
        ).toEqual([1, 2, 3, 4]);
      });

      it("handles many concurrent writes", async () => {
        const keys = Array.from({ length: 200 }, (_, i) => `k${i}`);
        await Promise.all(keys.map((k, i) => store.set(k, i, 60)));
        expect(await Promise.all(keys.map((k) => store.get(k)))).toEqual(keys.map((_, i) => i));
      });
    });

    describe("expiry", () => {
      it("is present just before the TTL and gone at it", async () => {
        await store.set("k", "v", 10);
        advance(9_999);
        await expect(store.get("k")).resolves.toBe("v");
        advance(1);
        await expect(store.get("k")).resolves.toBeUndefined();
      });

      it("stays gone after expiring", async () => {
        await store.set("k", "v", 1);
        advance(5_000);
        await expect(store.get("k")).resolves.toBeUndefined();
        await expect(store.get("k")).resolves.toBeUndefined();
      });

      it("resets the TTL on overwrite", async () => {
        await store.set("k", "v1", 10);
        advance(5_000);
        await store.set("k", "v2", 10);
        advance(8_000);
        await expect(store.get("k")).resolves.toBe("v2");
      });

      it("can shorten a TTL on overwrite", async () => {
        await store.set("k", "v1", 3600);
        await store.set("k", "v2", 1);
        advance(1_000);
        await expect(store.get("k")).resolves.toBeUndefined();
      });

      it("accepts fractional seconds", async () => {
        await store.set("k", "v", 0.5);
        advance(499);
        await expect(store.get("k")).resolves.toBe("v");
        advance(1);
        await expect(store.get("k")).resolves.toBeUndefined();
      });

      it("can be written again after expiring", async () => {
        await store.set("k", "v1", 1);
        advance(2_000);
        await store.set("k", "v2", 1);
        await expect(store.get("k")).resolves.toBe("v2");
      });

      it("expires each key on its own schedule", async () => {
        await store.set("short", 1, 1);
        await store.set("long", 2, 100);
        advance(1_000);
        await expect(store.get("short")).resolves.toBeUndefined();
        await expect(store.get("long")).resolves.toBe(2);
      });
    });

    describe("validation", () => {
      it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
        "rejects a TTL of %s and writes nothing",
        async (ttl) => {
          await store.set("k", "kept", 60);
          await expect(store.set("k", "replaced", ttl)).rejects.toBeInstanceOf(RangeError);
          await expect(store.get("k")).resolves.toBe("kept");
        },
      );

      it("rejects an empty key", async () => {
        await expect(store.set("", 1, 60)).rejects.toBeInstanceOf(RangeError);
        await expect(store.get("")).rejects.toBeInstanceOf(RangeError);
      });

      it("accepts a key at the maximum length and rejects a longer one", async () => {
        const max = "k".repeat(MAX_KEY_LENGTH);
        await store.set(max, 1, 60);
        await expect(store.get(max)).resolves.toBe(1);
        await expect(store.set(`${max}k`, 1, 60)).rejects.toBeInstanceOf(RangeError);
      });

      it("rejects undefined, which would read back as a miss", async () => {
        await expect(store.set("k", undefined, 60)).rejects.toBeInstanceOf(TypeError);
      });

      it.each([
        ["a function", () => 1],
        ["a bigint", 10n],
        ["a symbol", Symbol("s")],
      ])("rejects %s", async (_label, value) => {
        await expect(store.set("k", value, 60)).rejects.toBeInstanceOf(TypeError);
      });

      it("rejects a cyclic value", async () => {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        await expect(store.set("k", cyclic, 60)).rejects.toBeInstanceOf(TypeError);
      });

      it("accepts a value just under the size cap and rejects one over it", async () => {
        const under = "x".repeat(MAX_VALUE_BYTES - 2);
        await store.set("big", under, 60);
        await expect(store.get("big")).resolves.toBe(under);
        await expect(store.set("big", `${under}xx`, 60)).rejects.toBeInstanceOf(RangeError);
        await expect(store.get("big")).resolves.toBe(under);
      });

      it("measures the cap in UTF-8 bytes, not characters", async () => {
        // Each "é" is 2 bytes in UTF-8.
        const value = "é".repeat(MAX_VALUE_BYTES / 2);
        await expect(store.set("k", value, 60)).rejects.toBeInstanceOf(RangeError);
      });
    });
  });
}
