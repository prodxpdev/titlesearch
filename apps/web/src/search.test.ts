import type { Availability, DomainResult } from "@titlesearch/core";
import { describe, expect, it } from "vitest";
import { rowVerdict } from "./search";
import type { NameRow } from "./store";

const TLDS = ["com", "io"];
const row = (by: Record<string, Availability>): NameRow => ({
  name: "acme",
  origin: "seed",
  status: "done",
  results: Object.entries(by).map(
    ([t, availability]) => ({ domain: `acme.${t}`, availability, sources: [] }) as DomainResult,
  ),
});

describe("rowVerdict", () => {
  it("calls a name viable only when a registrar confirmed an extension", () => {
    expect(rowVerdict(row({ com: "available", io: "registered" }), TLDS).verdict).toBe("Viable");
  });

  it("never calls an unrecorded name taken or open (invariant 4)", () => {
    const v = rowVerdict(
      row({ com: "unregistered_at_registry", io: "unregistered_at_registry" }),
      TLDS,
    );
    expect(v.verdict).toBe("Not registered");
    expect(v.note).toContain("no registrar confirmed");
  });

  it("calls a name taken when every extension is registered", () => {
    expect(rowVerdict(row({ com: "registered", io: "registered" }), TLDS).verdict).toBe("Taken");
  });
});
