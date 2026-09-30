import {
  type Assessment,
  type AvailabilityProvider,
  type CacheStore,
  type PresenceProbe,
  type ProviderContext,
  silentLogger,
  unlimited,
} from "@titlesearch/core";
import { describe, expect, it } from "vitest";
import { assessMarketConflicts } from "../src/assess.js";
import type { ConflictClassifier } from "../src/classifier.js";
import { site } from "./fixtures.js";

const ctx = (): ProviderContext => ({
  signal: new AbortController().signal,
  rateLimiter: unlimited,
  logger: silentLogger,
});

const rdap: AvailabilityProvider = {
  id: "rdap",
  supports: () => true,
  check: async (ds) =>
    ds.map((d) => ({
      source: "rdap",
      availability: d.startsWith("free") ? "unregistered_at_registry" : "registered",
      checkedAt: "2026-09-30T12:00:00.000Z",
      latencyMs: 1,
    })),
};

// real.* are real sites; parked.* are parked.
const probe: PresenceProbe = async (domain) =>
  domain.startsWith("parked")
    ? { evidence: site(domain, { parkingSignals: ["ns-sedoparking"] }), occupancy: "parked" }
    : { evidence: site(domain), occupancy: "unassessed" };

function fakeClassifier(
  level: Assessment["level"] = "competitor",
): ConflictClassifier & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    id: "fake",
    calls,
    async assess(market, evidence) {
      calls.push(evidence.map((e) => e.domain));
      return evidence.map((e) => ({
        domain: e.domain,
        level,
        reasons: ["r1", "r2"],
        assessedBy: "fake",
        market,
      }));
    },
  };
}

function mapCache(): CacheStore {
  const m = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => m.get(k) as T | undefined,
    set: async (k, v) => void m.set(k, JSON.parse(JSON.stringify(v))),
  };
}

const base = { providers: [rdap], probe };

describe("assessMarketConflicts", () => {
  it("judges only real sites and maps levels to occupancy", async () => {
    const classifier = fakeClassifier("none");
    const r = await assessMarketConflicts(
      ["real.com", "parked.com", "free.com"],
      "Invoicing",
      ctx(),
      {
        ...base,
        mode: "anthropic",
        classifier,
      },
    );
    expect(classifier.calls).toEqual([["real.com"]]);
    expect(r.assessedBy).toBe("fake");
    expect(r.results.map((x) => [x.domain, x.availability, x.occupancy])).toEqual([
      ["real.com", "registered", "unrelated"],
      ["parked.com", "registered", "parked"],
      ["free.com", "unregistered_at_registry", undefined],
    ]);
    expect(r.results[0]?.assessment?.reasons).toEqual(["r1", "r2"]);
  });

  it.each(["client", "off"] as const)(
    "in %s mode returns evidence with sites unassessed",
    async (mode) => {
      const classifier = fakeClassifier();
      const r = await assessMarketConflicts(["real.com"], "Invoicing", ctx(), {
        ...base,
        mode,
        classifier,
      });
      expect(classifier.calls).toEqual([]);
      expect(r.results[0]).toMatchObject({ occupancy: "unassessed" });
      expect(r.results[0]?.presence).toBeDefined();
      expect(r.assessedBy).toBeUndefined();
    },
  );

  it("leaves a site unassessed when the classifier can't judge it", async () => {
    const classifier: ConflictClassifier = { id: "fake", assess: async () => [] };
    const r = await assessMarketConflicts(["real.com"], "m", ctx(), {
      ...base,
      mode: "anthropic",
      classifier,
    });
    expect(r.results[0]?.occupancy).toBe("unassessed");
    expect(r.results[0]?.assessment).toBeUndefined();
  });

  it("caches assessments per domain, market, and classifier", async () => {
    const cache = mapCache();
    const classifier = fakeClassifier();
    const opts = { ...base, cache, mode: "anthropic" as const, classifier };
    await assessMarketConflicts(["real.com"], "Invoicing for freelancers", ctx(), opts);
    await assessMarketConflicts(["real.com"], "  invoicing FOR freelancers ", ctx(), opts);
    expect(classifier.calls).toHaveLength(1);
    await assessMarketConflicts(["real.com"], "Payroll for agencies", ctx(), opts);
    expect(classifier.calls).toHaveLength(2);
  });

  it("requires a market description of reasonable length", async () => {
    await expect(
      assessMarketConflicts(["real.com"], "  ", ctx(), { ...base, mode: "off" }),
    ).rejects.toThrow(RangeError);
    await expect(
      assessMarketConflicts(["real.com"], "x".repeat(1001), ctx(), { ...base, mode: "off" }),
    ).rejects.toThrow(RangeError);
  });

  it("requires a classifier in anthropic mode", async () => {
    await expect(
      assessMarketConflicts(["real.com"], "m", ctx(), { ...base, mode: "anthropic" }),
    ).rejects.toThrow(/classifier/);
  });
});
