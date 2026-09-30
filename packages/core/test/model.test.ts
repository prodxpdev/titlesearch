import { describe, expect, it } from "vitest";
import {
  Assessment,
  DomainResult,
  SourceResult,
  toUntrustedSiteText,
  UNTRUSTED_SITE_TEXT_MAX,
  UntrustedSiteText,
} from "../src/model.js";

describe("toUntrustedSiteText", () => {
  it("collapses whitespace", () => {
    expect(toUntrustedSiteText("  Welcome\n\n to\tAcme  ")).toBe("Welcome to Acme");
  });

  it("strips control, zero-width, and bidi characters", () => {
    const nasty = "Buy\u0000 now\u0007\u001b[31m​‮evil⁦x⁩﻿\u0085 end";
    const out = toUntrustedSiteText(nasty);
    expect(out).toBe("Buy now [31m evil x end");
    expect(UntrustedSiteText.safeParse(out).success).toBe(true);
  });

  it("caps at 600 characters", () => {
    expect(toUntrustedSiteText("a".repeat(5000))).toHaveLength(UNTRUSTED_SITE_TEXT_MAX);
  });

  it("never splits a surrogate pair at the cap", () => {
    const out = toUntrustedSiteText("😀".repeat(700));
    expect(Array.from(out)).toHaveLength(UNTRUSTED_SITE_TEXT_MAX);
    expect(out.endsWith("😀")).toBe(true);
  });
});

describe("UntrustedSiteText schema", () => {
  it("rejects text over the cap", () => {
    expect(UntrustedSiteText.safeParse("a".repeat(601)).success).toBe(false);
  });

  it("rejects control characters", () => {
    expect(UntrustedSiteText.safeParse("a\u0000b").success).toBe(false);
  });

  it("is described as third-party data", () => {
    expect(UntrustedSiteText.description).toMatch(/not instructions/);
  });
});

describe("schemas", () => {
  const source = {
    source: "godaddy",
    availability: "available",
    price: { amount: 11.99, currency: "USD", period: "first_year" },
    checkedAt: "2026-09-30T12:00:00.000Z",
    latencyMs: 120,
  };

  it("accepts a valid SourceResult", () => {
    expect(SourceResult.parse(source)).toEqual(source);
  });

  it("rejects an unknown availability", () => {
    expect(SourceResult.safeParse({ ...source, availability: "free" }).success).toBe(false);
  });

  it("rejects a lowercase currency", () => {
    expect(
      SourceResult.safeParse({ ...source, price: { ...source.price, currency: "usd" } }).success,
    ).toBe(false);
  });

  it("requires 2 to 4 assessment reasons", () => {
    const a = { level: "competitor", assessedBy: "anthropic", market: "invoicing for freelancers" };
    expect(Assessment.safeParse({ ...a, reasons: ["one"] }).success).toBe(false);
    expect(Assessment.safeParse({ ...a, reasons: ["one", "two"] }).success).toBe(true);
    expect(Assessment.safeParse({ ...a, reasons: ["1", "2", "3", "4", "5"] }).success).toBe(false);
  });

  it("accepts a DomainResult with sources only", () => {
    expect(
      DomainResult.safeParse({ domain: "acme.io", availability: "available", sources: [source] })
        .success,
    ).toBe(true);
  });
});
