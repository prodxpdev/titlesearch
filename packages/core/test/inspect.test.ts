import { describe, expect, it } from "vitest";
import type { CacheStore } from "../src/cache.js";
import { inspectDomain, type PresenceProbe } from "../src/inspect.js";
import { silentLogger } from "../src/log.js";
import type { Availability, PresenceEvidence } from "../src/model.js";
import type { AvailabilityProvider, ProviderContext } from "../src/provider.js";
import { unlimited } from "../src/rate-limit.js";

const ctx = (): ProviderContext => ({
  signal: new AbortController().signal,
  rateLimiter: unlimited,
  logger: silentLogger,
});
const provider = (id: string, a: Availability): AvailabilityProvider => ({
  id,
  supports: () => true,
  check: async (ds) =>
    ds.map(() => ({
      source: id,
      availability: a,
      checkedAt: "2026-09-30T12:00:00.000Z",
      latencyMs: 1,
    })),
});
const evidence = (domain: string): PresenceEvidence => ({
  domain,
  dns: { hasA: true, hasAAAA: false, hasNS: true, hasMX: false, nameservers: ["ns1.afternic.com"] },
  parkingSignals: ["ns-afternic"],
  clientRedirects: [],
  probeErrors: [],
  contentConfidence: "low",
});

/** A probe that records calls. `dnsFailed` makes it return no occupancy, as when DNS can't be read. */
function countingProbe(dnsFailed = false): PresenceProbe & { calls: string[] } {
  const calls: string[] = [];
  const probe: PresenceProbe = async (domain) => {
    calls.push(domain);
    return { evidence: evidence(domain), occupancy: dnsFailed ? undefined : "for_sale" };
  };
  return Object.assign(probe, { calls });
}

function mapCache(): CacheStore {
  const m = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => m.get(k) as T | undefined,
    set: async (k, v) => void m.set(k, JSON.parse(JSON.stringify(v))),
  };
}

describe("inspectDomain", () => {
  it("adds presence and occupancy to a registered domain", async () => {
    const probe = countingProbe();
    const r = await inspectDomain("Acme.io", ctx(), {
      providers: [provider("rdap", "registered")],
      probe,
    });
    expect(r).toMatchObject({
      domain: "acme.io",
      availability: "registered",
      occupancy: "for_sale",
    });
    expect(r.presence?.parkingSignals).toEqual(["ns-afternic"]);
    expect(probe.calls).toEqual(["acme.io"]);
  });

  it("probes an unconfirmed domain that the registry says is registered", async () => {
    const probe = countingProbe();
    const r = await inspectDomain("bank.app", ctx(), {
      providers: [provider("rdap", "registered"), provider("godaddy", "premium")],
      probe,
    });
    expect(r.availability).toBe("unconfirmed");
    expect(r.presence).toBeDefined();
  });

  it.each(["available", "unregistered_at_registry", "error"] as const)(
    "doesn't probe a %s domain",
    async (a) => {
      const probe = countingProbe();
      const providers =
        a === "available"
          ? [provider("rdap", "unregistered_at_registry"), provider("gd", "available")]
          : [provider("rdap", a)];
      const r = await inspectDomain("acme.io", ctx(), { providers, probe });
      expect(r.presence).toBeUndefined();
      expect(probe.calls).toEqual([]);
    },
  );

  it("caches presence for 6 hours, and not when DNS failed", async () => {
    const cache = mapCache();
    const probe = countingProbe();
    const opts = { providers: [provider("rdap", "registered")], probe, cache };
    await inspectDomain("acme.io", ctx(), opts);
    await inspectDomain("acme.io", ctx(), opts);
    expect(probe.calls).toHaveLength(1);

    const failing = countingProbe(true);
    const opts2 = {
      providers: [provider("rdap", "registered")],
      probe: failing,
      cache: mapCache(),
    };
    const r = await inspectDomain("beta.io", ctx(), opts2);
    await inspectDomain("beta.io", ctx(), opts2);
    expect(r.occupancy).toBeUndefined();
    expect(failing.calls).toHaveLength(2);
  });
});
