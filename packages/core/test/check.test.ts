import { describe, expect, it } from "vitest";
import type { CacheStore } from "../src/cache.js";
import { cacheKeys } from "../src/cache.js";
import { checkDomains, expandCandidates, RequestLimitError } from "../src/check.js";
import { silentLogger } from "../src/log.js";
import type { Availability, SourceResult } from "../src/model.js";
import type { AvailabilityProvider, ProviderContext } from "../src/provider.js";
import { unlimited } from "../src/rate-limit.js";

const ctx = (): ProviderContext => ({
  signal: new AbortController().signal,
  rateLimiter: unlimited,
  logger: silentLogger,
});

function provider(
  id: string,
  answers: Record<string, Availability>,
  opts: { tlds?: string[]; calls?: string[][] } = {},
): AvailabilityProvider {
  return {
    id,
    supports: (tld) => !opts.tlds || opts.tlds.includes(tld),
    async check(domains) {
      opts.calls?.push(domains);
      return domains.map(
        (d): SourceResult => ({
          source: id,
          availability: answers[d] ?? "error",
          checkedAt: "2026-09-30T12:00:00.000Z",
          latencyMs: 1,
        }),
      );
    },
  };
}

function mapCache(): CacheStore & { entries: Map<string, { value: unknown; ttl: number }> } {
  const entries = new Map<string, { value: unknown; ttl: number }>();
  return {
    entries,
    get: async <T>(k: string) => entries.get(k)?.value as T | undefined,
    set: async (k, value, ttl) =>
      void entries.set(k, { value: JSON.parse(JSON.stringify(value)), ttl }),
  };
}

describe("expandCandidates", () => {
  it("crosses names with extensions, in order, without duplicates", () => {
    expect(expandCandidates(["Acme", "acme", "Beta"], ["com", ".io"])).toEqual([
      "acme.com",
      "acme.io",
      "beta.com",
      "beta.io",
    ]);
  });

  it("takes a name with a dot as a full domain", () => {
    expect(expandCandidates(["acme.co.uk", "beta"], ["com"])).toEqual(["acme.co.uk", "beta.com"]);
  });

  it("uses the default extensions", () => {
    expect(expandCandidates(["acme"])).toEqual([
      "acme.com",
      "acme.io",
      "acme.co",
      "acme.ai",
      "acme.app",
      "acme.dev",
    ]);
  });

  it("caps names at 20", () => {
    const names = Array.from({ length: 21 }, (_, i) => `n${i}`);
    expect(() => expandCandidates(names, ["com"])).toThrow(RequestLimitError);
  });

  it("caps domains at 50", () => {
    const names = Array.from({ length: 9 }, (_, i) => `n${i}`);
    expect(
      expandCandidates(names.slice(0, 8), ["com", "io", "co", "ai", "app", "dev"]),
    ).toHaveLength(48);
    expect(() => expandCandidates(names, ["com", "io", "co", "ai", "app", "dev"])).toThrow(
      /At most 50 domains/,
    );
  });

  it("rejects an empty name list", () => {
    expect(() => expandCandidates([])).toThrow(RequestLimitError);
  });
});

describe("checkDomains", () => {
  it("runs every provider that supports the extension and reconciles", async () => {
    const results = await checkDomains(["acme.com", "acme.io"], ctx(), {
      providers: [
        provider("rdap", { "acme.com": "unregistered_at_registry", "acme.io": "registered" }),
        provider("godaddy", { "acme.com": "available" }, { tlds: ["com"] }),
      ],
    });
    expect(results).toMatchObject([
      { domain: "acme.com", availability: "available", availabilityReason: "agreed" },
      {
        domain: "acme.io",
        availability: "registered",
        availabilityReason: "registry_only_registered",
      },
    ]);
    expect(results[0]?.sources.map((s) => s.source)).toEqual(["rdap", "godaddy"]);
    expect(results[1]?.sources.map((s) => s.source)).toEqual(["rdap"]);
  });

  it("reports unconfirmed with every source when they disagree", async () => {
    const [r] = await checkDomains(["bank.app"], ctx(), {
      providers: [
        provider("rdap", { "bank.app": "registered" }),
        provider("godaddy", { "bank.app": "premium" }),
      ],
    });
    expect(r?.availability).toBe("unconfirmed");
    expect(r?.sources).toHaveLength(2);
  });

  it("turns a throwing provider into error sources, not a failed call", async () => {
    const broken: AvailabilityProvider = {
      id: "broken",
      supports: () => true,
      check: async () => {
        throw new Error("boom");
      },
    };
    const [r] = await checkDomains(["acme.com"], ctx(), {
      providers: [provider("rdap", { "acme.com": "registered" }), broken],
    });
    expect(r?.availability).toBe("registered");
    expect(r?.sources[1]).toMatchObject({
      source: "broken",
      availability: "error",
      error: { code: "provider_failed" },
    });
  });

  it("rejects a provider that returns the wrong number of results", async () => {
    const short: AvailabilityProvider = {
      id: "short",
      supports: () => true,
      check: async () => [],
    };
    const [r] = await checkDomains(["acme.com"], ctx(), { providers: [short] });
    expect(r?.sources[0]?.error?.code).toBe("invalid_provider_result");
    expect(r?.availability).toBe("error");
  });

  it("rejects a malformed source result", async () => {
    const bad: AvailabilityProvider = {
      id: "bad",
      supports: () => true,
      check: async () => [{ source: "bad", availability: "free" } as unknown as SourceResult],
    };
    const [r] = await checkDomains(["acme.com"], ctx(), { providers: [bad] });
    expect(r?.sources[0]?.error?.code).toBe("invalid_provider_result");
  });

  it("normalizes and dedupes input", async () => {
    const results = await checkDomains(["ACME.com", "acme.com."], ctx(), {
      providers: [provider("rdap", { "acme.com": "registered" })],
    });
    expect(results.map((r) => r.domain)).toEqual(["acme.com"]);
  });

  it("caps a call at 50 domains", async () => {
    const domains = Array.from({ length: 51 }, (_, i) => `d${i}.com`);
    await expect(checkDomains(domains, ctx(), { providers: [] })).rejects.toThrow(
      RequestLimitError,
    );
  });

  describe("caching", () => {
    it("caches by the TTL policy and serves hits without calling providers", async () => {
      const cache = mapCache();
      const calls: string[][] = [];
      const providers = [
        provider(
          "rdap",
          { "taken.com": "registered", "free.com": "unregistered_at_registry" },
          { calls },
        ),
      ];
      await checkDomains(["taken.com", "free.com"], ctx(), { providers, cache });
      expect(cache.entries.get(cacheKeys.availability("taken.com", ["rdap"]))?.ttl).toBe(6 * 3600);
      expect(cache.entries.get(cacheKeys.availability("free.com", ["rdap"]))?.ttl).toBe(600);
      const again = await checkDomains(["taken.com", "free.com"], ctx(), { providers, cache });
      expect(calls).toHaveLength(1);
      expect(again.map((r) => r.availability)).toEqual(["registered", "unregistered_at_registry"]);
    });

    it("doesn't cache unconfirmed or error results", async () => {
      const cache = mapCache();
      await checkDomains(["x.com", "y.com"], ctx(), {
        providers: [
          provider("rdap", { "x.com": "registered" }),
          provider("godaddy", { "x.com": "available" }),
        ],
        cache,
      });
      expect(cache.entries.size).toBe(0);
    });

    it("keys by provider set", async () => {
      const cache = mapCache();
      await checkDomains(["acme.com"], ctx(), {
        providers: [provider("rdap", { "acme.com": "registered" })],
        cache,
      });
      const calls: string[][] = [];
      await checkDomains(["acme.com"], ctx(), {
        providers: [
          provider("rdap", { "acme.com": "registered" }, { calls }),
          provider("godaddy", { "acme.com": "registered" }),
        ],
        cache,
      });
      expect(calls).toHaveLength(1);
    });

    it("ignores a corrupt cache entry", async () => {
      const cache = mapCache();
      await cache.set(
        cacheKeys.availability("acme.com", ["rdap"]),
        { domain: "acme.com", availability: "available" },
        60,
      );
      const [r] = await checkDomains(["acme.com"], ctx(), {
        providers: [provider("rdap", { "acme.com": "registered" })],
        cache,
      });
      expect(r?.availability).toBe("registered");
    });

    it("keeps working when the cache fails", async () => {
      const failing: CacheStore = {
        get: async () => {
          throw new Error("disk");
        },
        set: async () => {
          throw new Error("disk");
        },
      };
      const [r] = await checkDomains(["acme.com"], ctx(), {
        providers: [provider("rdap", { "acme.com": "registered" })],
        cache: failing,
      });
      expect(r?.availability).toBe("registered");
    });
  });
});
