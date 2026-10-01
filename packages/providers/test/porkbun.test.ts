// Porkbun against fixtures built from its OpenAPI spec (see each file's _source).

import { reconcile } from "@titlesearch/core";
import { describe, expect, it } from "vitest";
import { PorkbunProvider } from "../src/porkbun/porkbun.js";
import { ctx, fakeTransport, fixtureJson, recordingLimiter } from "./helpers.js";

const KEY = "pk1_test0123456789abcdef";
const SECRET = "sk1_test0123456789abcdef";

const serving = (file: string, status = 200) =>
  fakeTransport(
    () =>
      new Response(JSON.stringify(fixtureJson(`porkbun/${file}`)), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
const provider = (t: ReturnType<typeof serving>) =>
  new PorkbunProvider({
    apiKey: KEY,
    secretApiKey: SECRET,
    transport: t,
    retry: { maxRetries: 0 },
  });

const DOMAINS = [
  "fieldloom.io",
  "dispatchwell.com",
  "acme.dev",
  "google.com",
  "xn--mnchen-3ya.de",
  "slowregistry.example",
  "missing.io",
];

describe("PorkbunProvider", () => {
  it("maps standard, premium, promo, and taken answers with USD first-year prices", async () => {
    const results = await provider(serving("bulk-mixed.json")).check(DOMAINS, ctx());
    expect(results.map((r) => [r.availability, r.price?.amount])).toEqual([
      ["available", 28.12],
      ["premium", 2450],
      ["available", 9.73],
      ["registered", undefined],
      ["available", 5.99],
      ["error", undefined],
      ["error", undefined],
    ]);
    expect(results[1]?.price).toEqual({ amount: 2450, currency: "USD", period: "first_year" });
    expect(results.every((r) => r.source === "porkbun")).toBe(true);
  });

  it("treats unresolved as an error, never as taken or free", async () => {
    const [r] = await provider(serving("bulk-mixed.json")).check(["slowregistry.example"], ctx());
    expect(r).toMatchObject({ availability: "error", error: { code: "unresolved" } });
  });

  it("sends the keys only in headers, and one batch per 25 domains", async () => {
    const t = serving("bulk-mixed.json");
    const names = Array.from({ length: 30 }, (_, i) => `n${i}.com`);
    await provider(t).check(names, ctx());
    expect(t.calls).toHaveLength(2);
    expect(t.calls[0]?.url).toBe("https://api.porkbun.com/api/json/v3/domain/checkDomain");
    expect(t.calls[0]?.method).toBe("POST");
    expect(t.calls[0]?.headers.get("x-api-key")).toBe(KEY);
    expect(t.calls[0]?.headers.get("x-secret-api-key")).toBe(SECRET);
    expect(t.calls[0]?.body).not.toContain(KEY);
    expect(t.calls[0]?.body).not.toContain(SECRET);
    expect(JSON.parse(t.calls[0]?.body ?? "{}").domains).toHaveLength(25);
    expect(JSON.parse(t.calls[1]?.body ?? "{}").domains).toHaveLength(5);
  });

  it("charges the bulk budget per domain", async () => {
    const limiter = recordingLimiter();
    await provider(serving("bulk-mixed.json")).check(
      ["a.com", "b.com", "c.com"],
      ctx({ rateLimiter: limiter }),
    );
    expect(limiter.keys).toEqual(["porkbun:bulk", "porkbun:bulk", "porkbun:bulk"]);
  });

  it.each([
    ["a rate limit returned as 200", "error-rate-limit-200.json", 200, "rate_limited"],
    ["a 429", "error-429.json", 429, "rate_limited"],
    ["bad credentials, recorded live", "error-auth-recorded.json", 400, "unauthorized"],
    [
      "the error shape recorded from Porkbun's mock server",
      "error-mock-recorded.json",
      400,
      "invalid_domain",
    ],
  ])("reports %s as an error for every domain", async (_l, file, status, code) => {
    const results = await provider(serving(file, status)).check(["a.com", "b.com"], ctx());
    expect(results.map((r) => r.error?.code)).toEqual([code, code]);
  });

  it.each([
    ["a malformed price", { avail: "yes", price: "free!", premium: "no" }],
    ["a missing avail", { price: "9.73", premium: "no" }],
    ["avail as a boolean", { avail: true, price: "9.73", premium: "no" }],
  ])("rejects %s rather than coercing it", async (_l, entry) => {
    const t = fakeTransport(
      () => new Response(JSON.stringify({ status: "SUCCESS", domains: { "a.com": entry } })),
    );
    const [r] = await provider(t).check(["a.com"], ctx());
    expect(r).toMatchObject({ availability: "error", error: { code: "invalid_response" } });
  });

  it("accepts a sandbox key's answers, which carry sandbox: true", async () => {
    const t = fakeTransport(
      () =>
        new Response(
          JSON.stringify({
            status: "SUCCESS",
            sandbox: true,
            domains: { "a.com": { avail: "yes", price: "11.08", premium: "no" } },
          }),
        ),
    );
    const [r] = await provider(t).check(["a.com"], ctx());
    expect(r).toMatchObject({ availability: "available", price: { amount: 11.08 } });
  });

  it("requires both keys", () => {
    expect(() => new PorkbunProvider({ apiKey: KEY, secretApiKey: "" })).toThrow();
  });

  it("with GoDaddy's availability-only answer, reconciles a premium name as premium", async () => {
    const [porkbun] = await provider(serving("bulk-mixed.json")).check(["dispatchwell.com"], ctx());
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
      porkbun as NonNullable<typeof porkbun>,
    ];
    expect(reconcile(sources)).toEqual({ availability: "premium", reason: "agreed" });
  });
});
