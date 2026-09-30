import { describe, expect, it } from "vitest";
import { availabilityTtl, cacheKeys, normalizeMarket, TTL } from "../src/policy.js";

describe("TTL policy (CLAUDE.md)", () => {
  it.each([
    ["registered", 6 * 3600],
    ["available", 600],
    ["premium", 600],
    ["unregistered_at_registry", 600],
    ["unconfirmed", undefined],
    ["error", undefined],
  ] as const)("%s → %s", (availability, ttl) => {
    expect(availabilityTtl(availability)).toBe(ttl);
  });

  it("caches presence 6 hours, the bootstrap and assessments 24 hours", () => {
    expect(TTL.presence).toBe(6 * 3600);
    expect(TTL.rdapBootstrap).toBe(24 * 3600);
    expect(TTL.assessment).toBe(24 * 3600);
  });
});

describe("cache keys", () => {
  it("includes the providers consulted, in a stable order", () => {
    expect(cacheKeys.availability("acme.io", ["rdap", "godaddy"])).toBe(
      cacheKeys.availability("acme.io", ["godaddy", "rdap"]),
    );
    expect(cacheKeys.availability("acme.io", ["rdap"])).not.toBe(
      cacheKeys.availability("acme.io", ["rdap", "godaddy"]),
    );
  });

  it("keys assessments by domain, market, and classifier", async () => {
    const a = await cacheKeys.assessment("acme.io", "Invoicing for freelancers", "anthropic");
    expect(a).toMatch(/^ts:v1:assess:anthropic:[0-9a-f]{32}:acme\.io$/);
    expect(
      await cacheKeys.assessment("acme.io", "  invoicing   FOR freelancers ", "anthropic"),
    ).toBe(a);
    expect(await cacheKeys.assessment("acme.io", "invoicing for agencies", "anthropic")).not.toBe(
      a,
    );
    expect(await cacheKeys.assessment("acme.io", "Invoicing for freelancers", "client")).not.toBe(
      a,
    );
    expect(
      await cacheKeys.assessment("acme.dev", "Invoicing for freelancers", "anthropic"),
    ).not.toBe(a);
  });

  it("keeps market text out of the key", async () => {
    const key = await cacheKeys.assessment("acme.io", "secret stealth product", "anthropic");
    expect(key).not.toContain("secret");
  });

  it("normalizes market text", () => {
    expect(normalizeMarket("  Ｉnvoicing\tfor   Freelancers ")).toBe("invoicing for freelancers");
  });
});
