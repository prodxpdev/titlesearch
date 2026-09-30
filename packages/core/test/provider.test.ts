// Invariant 1 at the type level: the provider contract has exactly these
// members. Adding any method (a write or otherwise) fails typecheck and this test.

import { describe, expect, expectTypeOf, it } from "vitest";
import type { AvailabilityProvider } from "../src/provider.js";

describe("AvailabilityProvider", () => {
  it("has only id, supports, and check", () => {
    expectTypeOf<keyof AvailabilityProvider>().toEqualTypeOf<"id" | "supports" | "check">();
    const members: (keyof AvailabilityProvider)[] = ["id", "supports", "check"];
    expect(members).toHaveLength(3);
  });
});
