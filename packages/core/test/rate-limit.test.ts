import { describe, expect, it } from "vitest";
import { TokenBucketLimiter } from "../src/rate-limit.js";

function clock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
  };
}

describe("TokenBucketLimiter", () => {
  it("allows a burst, then paces", async () => {
    const c = clock();
    const l = new TokenBucketLimiter({ ratePerSecond: 2, capacity: 3, now: c.now, sleep: c.sleep });
    for (let i = 0; i < 5; i++) await l.acquire("rdap.verisign.com");
    expect(c.sleeps).toEqual([500, 500]);
  });

  it("keeps separate buckets per key", async () => {
    const c = clock();
    const l = new TokenBucketLimiter({ ratePerSecond: 1, capacity: 1, now: c.now, sleep: c.sleep });
    await l.acquire("a");
    await l.acquire("b");
    expect(c.sleeps).toEqual([]);
    await l.acquire("a");
    expect(c.sleeps).toEqual([1000]);
  });

  it("applies per-key overrides", async () => {
    const c = clock();
    const l = new TokenBucketLimiter({
      ratePerSecond: 100,
      capacity: 100,
      overrides: { slow: { ratePerSecond: 1, capacity: 1 } },
      now: c.now,
      sleep: c.sleep,
    });
    await l.acquire("slow");
    await l.acquire("slow");
    expect(c.sleeps).toEqual([1000]);
  });

  it("computes limits by key", async () => {
    const c = clock();
    const l = new TokenBucketLimiter({
      ratePerSecond: 100,
      capacity: 100,
      limitFor: (k) => (k.startsWith("whois:") ? { ratePerSecond: 0.5, capacity: 1 } : undefined),
      now: c.now,
      sleep: c.sleep,
    });
    await l.acquire("whois:whois.nic.io");
    await l.acquire("whois:whois.nic.io");
    await l.acquire("rdap:x");
    expect(c.sleeps).toEqual([2000]);
  });

  it("rejects when aborted", async () => {
    const l = new TokenBucketLimiter({ ratePerSecond: 0.001, capacity: 1 });
    await l.acquire("k");
    const controller = new AbortController();
    const pending = l.acquire("k", controller.signal);
    controller.abort(new Error("stop"));
    await expect(pending).rejects.toThrow("stop");
  });
});
