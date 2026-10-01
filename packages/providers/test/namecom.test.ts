// Name.com against fixtures built from its Core API spec (see each file's _source).

import { reconcile } from "@titlesearch/core";
import { describe, expect, it } from "vitest";
import { NamecomProvider } from "../src/namecom/namecom.js";
import { ctx, fakeTransport, fixtureJson, recordingLimiter } from "./helpers.js";

const USER = "titlesearch";
const TOKEN = "0123456789abcdef0123456789abcdef01234567";

const serving = (file: string, status = 200) =>
  fakeTransport(
    () =>
      new Response(JSON.stringify(fixtureJson(`namecom/${file}`)), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
const provider = (t: ReturnType<typeof serving>, environment?: "test") =>
  new NamecomProvider({
    username: USER,
    token: TOKEN,
    transport: t,
    retry: { maxRetries: 0 },
    ...(environment ? { environment } : {}),
  });

const DOMAINS = [
  "fieldloom.io",
  "dispatchwell.com",
  "google.com",
  "xn--mnchen-3ya.de",
  "bank.app",
  "missing.io",
];

describe("NamecomProvider", () => {
  it("maps standard, premium, and taken answers, matching results in any order", async () => {
    const results = await provider(serving("check-mixed.json")).check(DOMAINS, ctx());
    expect(results.map((r) => [r.availability, r.price?.amount, r.error?.code])).toEqual([
      ["available", 39.99, undefined],
      ["premium", 2450, undefined],
      ["registered", undefined, undefined],
      // Purchasable with no price: available, and the UI says there's no price.
      ["available", undefined, undefined],
      ["registered", undefined, undefined],
      ["error", undefined, "not_checked"],
    ]);
    expect(results[1]?.price).toEqual({ amount: 2450, currency: "USD", period: "first_year" });
    expect(results.every((r) => r.source === "namecom")).toBe(true);
  });

  it("sends Basic auth in a header, asks for registrations only, and batches by 50", async () => {
    const t = serving("check-mixed.json");
    const names = Array.from({ length: 60 }, (_, i) => `n${i}.com`);
    await provider(t).check(names, ctx());
    expect(t.calls).toHaveLength(2);
    expect(t.calls[0]?.url).toBe("https://api.name.com/core/v1/domains:checkAvailability");
    expect(t.calls[0]?.method).toBe("POST");
    expect(t.calls[0]?.headers.get("authorization")).toBe(`Basic ${btoa(`${USER}:${TOKEN}`)}`);
    expect(t.calls[0]?.body).not.toContain(TOKEN);
    const body = JSON.parse(t.calls[0]?.body ?? "{}");
    expect(body.purchaseType).toBe("registration");
    expect(body.domainNames).toHaveLength(50);
    expect(JSON.parse(t.calls[1]?.body ?? "{}").domainNames).toHaveLength(10);
  });

  it("uses the sandbox host in the test environment", async () => {
    const t = serving("check-mixed.json");
    await provider(t, "test").check(["a.com"], ctx());
    expect(t.calls[0]?.url).toBe("https://api.dev.name.com/core/v1/domains:checkAvailability");
  });

  it("charges the rate limit per request", async () => {
    const limiter = recordingLimiter();
    await provider(serving("check-mixed.json")).check(
      ["a.com", "b.com"],
      ctx({ rateLimiter: limiter }),
    );
    expect(limiter.keys).toEqual(["namecom"]);
  });

  it.each([
    ["bad credentials", "error-401.json", 401, "unauthorized"],
    ["only unsupported extensions", "error-422.json", 422, "unsupported_tld"],
    ["a 429", "error-429.json", 429, "rate_limited"],
  ])("reports %s as an error for every domain", async (_l, file, status, code) => {
    const results = await provider(serving(file, status)).check(["a.com", "b.com"], ctx());
    expect(results.map((r) => r.error?.code)).toEqual([code, code]);
  });

  it.each([
    ["a string price", { domainName: "a.com", purchasable: true, purchasePrice: "9.99" }],
    ["a negative price", { domainName: "a.com", purchasable: true, purchasePrice: -1 }],
    ["a missing purchasable", { domainName: "a.com", premium: false }],
    ["purchasable as a string", { domainName: "a.com", purchasable: "true" }],
  ])("rejects %s rather than coercing it", async (_l, entry) => {
    const t = fakeTransport(() => new Response(JSON.stringify({ results: [entry] })));
    const [r] = await provider(t).check(["a.com"], ctx());
    expect(r).toMatchObject({ availability: "error", error: { code: "invalid_response" } });
  });

  it("refuses a purchasable aftermarket listing despite the registration filter", async () => {
    const t = fakeTransport(
      () =>
        new Response(
          JSON.stringify({
            results: [
              {
                domainName: "a.com",
                purchasable: true,
                premium: true,
                purchasePrice: 5000,
                purchaseType: "aftermarket_s",
              },
            ],
          }),
        ),
    );
    const [r] = await provider(t).check(["a.com"], ctx());
    expect(r).toMatchObject({ availability: "error", error: { code: "inconsistent_response" } });
  });

  it("requires a username and token", () => {
    expect(() => new NamecomProvider({ username: USER, token: "" })).toThrow();
  });

  it("agrees with Porkbun-style premium when GoDaddy says available", async () => {
    const [namecom] = await provider(serving("check-mixed.json")).check(
      ["dispatchwell.com"],
      ctx(),
    );
    const at = "2026-10-01T12:00:00.000Z";
    const sources = [
      {
        source: "rdap",
        availability: "unregistered_at_registry" as const,
        checkedAt: at,
        latencyMs: 1,
      },
      {
        source: "godaddy",
        availability: "available" as const,
        availabilityOnly: true,
        checkedAt: at,
        latencyMs: 1,
      },
      namecom as NonNullable<typeof namecom>,
    ];
    expect(reconcile(sources)).toEqual({ availability: "premium", reason: "agreed" });
  });
});
