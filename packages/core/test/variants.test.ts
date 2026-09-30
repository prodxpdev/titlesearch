import { describe, expect, it } from "vitest";
import { DomainError } from "../src/domain.js";
import { generateVariants, seedLabel } from "../src/variants.js";

describe("generateVariants", () => {
  it("is deterministic", () => {
    expect(generateVariants("Acme")).toEqual(generateVariants("Acme"));
  });

  it("starts with the seed on the primary extension, then other extensions", () => {
    const v = generateVariants("acme", ["tld"], ["io", "com", "dev"]);
    expect(v).toEqual([
      { domain: "acme.io", strategy: "seed" },
      { domain: "acme.com", strategy: "tld" },
      { domain: "acme.dev", strategy: "tld" },
    ]);
  });

  it("applies each strategy on the primary extension", () => {
    const v = generateVariants("acme", ["prefix", "suffix", "plural"], ["com"]);
    expect(v[0]).toEqual({ domain: "acme.com", strategy: "seed" });
    expect(v).toContainEqual({ domain: "acmes.com", strategy: "plural" });
    expect(v).toContainEqual({ domain: "getacme.com", strategy: "prefix" });
    expect(v).toContainEqual({ domain: "acmehq.com", strategy: "suffix" });
    expect(v.every((x) => x.domain.endsWith(".com"))).toBe(true);
  });

  it.each([
    ["box", "boxes.com"],
    ["story", "stories.com"],
    ["day", "days.com"],
    ["match", "matches.com"],
  ])("pluralizes %s", (seed, expected) => {
    expect(generateVariants(seed, ["plural"], ["com"])).toContainEqual({
      domain: expected,
      strategy: "plural",
    });
  });

  it("skips the plural when the seed already ends in s", () => {
    expect(generateVariants("atlas", ["plural"], ["com"])).toEqual([
      { domain: "atlas.com", strategy: "seed" },
    ]);
  });

  it("compacts multi-word seeds and normalizes case and IDN", () => {
    expect(seedLabel("Acme Cloud")).toBe("acmecloud");
    expect(generateVariants("Café", [], ["com"])).toEqual([
      { domain: "xn--caf-dma.com", strategy: "seed" },
    ]);
  });

  it("never returns duplicates and respects the limit", () => {
    const v = generateVariants("acme", undefined, ["com", "COM", ".com", "io"], 5);
    expect(v).toHaveLength(5);
    expect(new Set(v.map((x) => x.domain)).size).toBe(5);
  });

  it("drops combinations longer than a label allows", () => {
    const long = "a".repeat(62);
    const v = generateVariants(long, ["prefix", "suffix"], ["com"]);
    expect(v.every((x) => (x.domain.split(".")[0] ?? "").length <= 63)).toBe(true);
  });

  it.each(["", "acme.com", "has/slash"])("rejects the seed %j", (seed) => {
    expect(() => generateVariants(seed)).toThrow(DomainError);
  });
});
