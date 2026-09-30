import type { DomainResult } from "@titlesearch/core";
import { describe, expect, it } from "vitest";
import { detail, formatTable } from "../src/output.js";

const at = "2026-09-30T12:00:00.000Z";
const r = (
  partial: Partial<DomainResult> & Pick<DomainResult, "domain" | "availability">,
): DomainResult => ({
  sources: [],
  ...partial,
});

describe("output", () => {
  it("names the source of every detail", () => {
    const res = r({
      domain: "bank.app",
      availability: "unconfirmed",
      availabilityReason: "registry_taken_registrar_free",
      sources: [
        {
          source: "rdap",
          availability: "registered",
          raw: { registrar: "GoDaddy.com, LLC" },
          checkedAt: at,
          latencyMs: 1,
        },
        { source: "godaddy", availability: "premium", checkedAt: at, latencyMs: 1 },
      ],
    });
    expect(detail(res)).toBe(
      "RDAP: registered (GoDaddy.com, LLC); GoDaddy: premium; possibly a resale listing",
    );
  });

  it("says when no registrar confirmed a free-looking name", () => {
    const res = r({
      domain: "acme.com",
      availability: "unregistered_at_registry",
      sources: [
        { source: "rdap", availability: "unregistered_at_registry", checkedAt: at, latencyMs: 1 },
      ],
    });
    expect(detail(res)).toBe("RDAP: not found; no registrar confirmed it");
  });

  it("shows prices with their currency and errors by code", () => {
    const res = r({
      domain: "acme.io",
      availability: "available",
      sources: [
        {
          source: "whois",
          availability: "error",
          error: { code: "rate_limited", message: "" },
          checkedAt: at,
          latencyMs: 1,
        },
        {
          source: "porkbun",
          availability: "available",
          price: { amount: 32.5, currency: "USD", period: "first_year" },
          checkedAt: at,
          latencyMs: 1,
        },
      ],
    });
    expect(detail(res)).toBe("WHOIS: rate limited; porkbun: available 32.50 USD");
  });

  it("aligns columns and ends with the trademark reminder", () => {
    const table = formatTable([
      r({ domain: "a.com", availability: "available" }),
      r({ domain: "longer-name.io", availability: "registered" }),
    ]);
    const lines = table.split("\n");
    expect(lines[0]).toBe("Domain          Status      Detail");
    expect(lines[1]).toBe("a.com           Available");
    expect(lines.at(-1)).toBe("Availability only. This isn't a trademark search.");
  });
});
