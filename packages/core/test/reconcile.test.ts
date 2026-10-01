// The reconciliation table from CLAUDE.md, row by row, plus multi-source cases.

import { describe, expect, it } from "vitest";
import type { Availability, SourceResult } from "../src/model.js";
import { type ReconcileReason, reconcile } from "../src/reconcile.js";

const at = "2026-09-30T12:00:00.000Z";

function src(
  source: string,
  availability: Availability,
  extra: Partial<SourceResult> = {},
): SourceResult {
  return { source, availability, checkedAt: at, latencyMs: 10, ...extra };
}

const rdap = {
  notFound: src("rdap", "unregistered_at_registry"),
  registered: src("rdap", "registered"),
  error: src("rdap", "error", { error: { code: "timeout", message: "RDAP timed out" } }),
};
const godaddy = {
  available: src("godaddy", "available", {
    price: { amount: 11.99, currency: "USD", period: "first_year" },
  }),
  premium: src("godaddy", "premium", {
    price: { amount: 2500, currency: "USD", period: "first_year" },
  }),
  taken: src("godaddy", "registered"),
  error: src("godaddy", "error", { error: { code: "rate_limited", message: "429" } }),
};

type Row = [
  rdap: string,
  registrar: string,
  sources: SourceResult[],
  expected: Availability,
  reason: ReconcileReason,
];

// Mirrors the table in CLAUDE.md, in the same order.
const table: Row[] = [
  ["not found", "available", [rdap.notFound, godaddy.available], "available", "agreed"],
  ["not found", "premium", [rdap.notFound, godaddy.premium], "premium", "agreed"],
  [
    "not found",
    "not available",
    [rdap.notFound, godaddy.taken],
    "unconfirmed",
    "registry_free_registrar_taken",
  ],
  ["registered", "not available", [rdap.registered, godaddy.taken], "registered", "agreed"],
  [
    "registered",
    "available",
    [rdap.registered, godaddy.available],
    "unconfirmed",
    "registry_taken_registrar_free",
  ],
  [
    "not found",
    "none configured",
    [rdap.notFound],
    "unregistered_at_registry",
    "registry_only_not_found",
  ],
  ["registered", "none configured", [rdap.registered], "registered", "registry_only_registered"],
  ["error", "available", [rdap.error, godaddy.available], "available", "registrar_only"],
  ["error", "premium", [rdap.error, godaddy.premium], "premium", "registrar_only"],
  ["error", "not available", [rdap.error, godaddy.taken], "registered", "registrar_only"],
  ["error", "error", [rdap.error, godaddy.error], "error", "no_answer"],
  ["error", "none configured", [rdap.error], "error", "no_answer"],
];

describe("reconcile: the CLAUDE.md table", () => {
  it.each(table)("RDAP %s, registrar %s", (_r, _g, sources, expected, reason) => {
    expect(reconcile(sources)).toEqual({ availability: expected, reason });
  });

  it("gives the same answer whatever order the sources arrive in", () => {
    for (const [, , sources, expected] of table) {
      expect(reconcile([...sources].reverse()).availability).toBe(expected);
    }
  });
});

describe("reconcile: honest status", () => {
  it("never reports available from RDAP alone", () => {
    expect(reconcile([rdap.notFound]).availability).toBe("unregistered_at_registry");
  });

  it("reports error with no sources at all", () => {
    expect(reconcile([])).toEqual({ availability: "error", reason: "no_answer" });
  });

  it("treats a failed registrar like an absent one", () => {
    expect(reconcile([rdap.notFound, godaddy.error]).availability).toBe("unregistered_at_registry");
    expect(reconcile([rdap.registered, godaddy.error]).availability).toBe("registered");
  });

  it("refuses to trust a registry source claiming available", () => {
    expect(reconcile([src("rdap", "available")])).toEqual({
      availability: "unconfirmed",
      reason: "invalid_source_state",
    });
  });

  it("refuses to trust a registrar source claiming a registry-only state", () => {
    expect(
      reconcile([rdap.notFound, src("porkbun", "unregistered_at_registry")]).availability,
    ).toBe("unconfirmed");
  });
});

describe("reconcile: several registrars", () => {
  const porkbun = {
    available: src("porkbun", "available", {
      price: { amount: 10.37, currency: "USD", period: "first_year" },
    }),
    premium: src("porkbun", "premium", {
      price: { amount: 1800, currency: "USD", period: "first_year" },
    }),
    taken: src("porkbun", "registered"),
  };

  it("agrees when every registrar agrees", () => {
    expect(reconcile([rdap.notFound, godaddy.available, porkbun.available]).availability).toBe(
      "available",
    );
  });

  it("is unconfirmed when registrars disagree on availability", () => {
    expect(reconcile([rdap.notFound, godaddy.available, porkbun.taken])).toEqual({
      availability: "unconfirmed",
      reason: "registrars_disagree",
    });
  });

  it("is unconfirmed when one says standard and another says premium", () => {
    expect(reconcile([rdap.notFound, godaddy.available, porkbun.premium])).toEqual({
      availability: "unconfirmed",
      reason: "registrars_disagree",
    });
  });

  it("is unconfirmed when registrars disagree even without RDAP", () => {
    expect(reconcile([rdap.error, godaddy.available, porkbun.taken]).reason).toBe(
      "registrars_disagree",
    );
  });

  it("differing prices alone aren't a disagreement", () => {
    expect(reconcile([rdap.notFound, godaddy.available, porkbun.available]).reason).toBe("agreed");
  });

  it("is unconfirmed when RDAP and WHOIS disagree", () => {
    expect(reconcile([rdap.notFound, src("whois", "registered")])).toEqual({
      availability: "unconfirmed",
      reason: "registries_disagree",
    });
  });
});

describe("reconcile: availability-only sources", () => {
  const gd = src("godaddy", "available", { availabilityOnly: true });
  const porkbun = {
    available: src("porkbun", "available", {
      price: { amount: 11.08, currency: "USD", period: "first_year" },
    }),
    premium: src("porkbun", "premium", {
      price: { amount: 2450, currency: "USD", period: "first_year" },
    }),
    taken: src("porkbun", "registered"),
  };

  it("agrees with a price source's premium", () => {
    expect(reconcile([rdap.notFound, gd, porkbun.premium])).toEqual({
      availability: "premium",
      reason: "agreed",
    });
  });

  it("agrees with a price source's standard price", () => {
    expect(reconcile([rdap.notFound, gd, porkbun.available])).toEqual({
      availability: "available",
      reason: "agreed",
    });
  });

  it("alone, still confirms the name can be registered", () => {
    expect(reconcile([rdap.notFound, gd])).toEqual({ availability: "available", reason: "agreed" });
  });

  it("disagrees with a registrar that says taken", () => {
    expect(reconcile([rdap.notFound, gd, porkbun.taken])).toEqual({
      availability: "unconfirmed",
      reason: "registrars_disagree",
    });
  });

  it("still disagrees with a registry that says registered (a resale listing)", () => {
    expect(reconcile([rdap.registered, gd]).reason).toBe("registry_taken_registrar_free");
  });
});
