// Every signature in signatures/parking.json must fire on every fixture it
// lists, and must never fire on the real-site controls.

import { describe, expect, it } from "vitest";
import { decodeBody, extractPage } from "../src/extract/extract.js";
import { readSafeFetchBody, safeFetch } from "../src/net/safe-fetch.js";
import { extractAskingPrice, matchSignals, PARKING_SIGNATURES } from "../src/parking.js";
import { probePresence, USER_AGENT } from "../src/presence.js";
import { replayDns, replayTransport, SITE_CASES, type SiteCase, siteCase } from "./sites.js";

const CONTROLS = ["bluerealty.com", "greengames.com"];

/** Signals for a case: a full probe, or for a case recorded from a non-root URL, the same fetch and extraction from there. */
async function signalsFor(
  c: SiteCase,
): Promise<{ ids: string[]; price: ReturnType<typeof extractAskingPrice> }> {
  const start = c.hops[0]?.url ?? "";
  if (start === `https://${c.domain}/` || start === `http://${c.domain}/`) {
    const { evidence } = await probePresence(c.domain, {
      dns: replayDns(c),
      transport: replayTransport(c),
      signal: new AbortController().signal,
    });
    return { ids: evidence.parkingSignals, price: evidence.askingPrice };
  }
  const res = await safeFetch(start, {
    resolver: replayDns(c),
    transport: replayTransport(c),
    userAgent: USER_AGENT,
  });
  const page = extractPage(decodeBody(readSafeFetchBody(res), res.contentType), res.url);
  const urls = res.chain.flatMap((h) => [
    h.url,
    ...(h.location ? [new URL(h.location, h.url).href] : []),
  ]);
  const texts = [page.fields.title ?? "", page.fields.description ?? "", page.visibleText];
  const ids = matchSignals({
    domain: c.domain,
    nameservers: c.dns.NS.map((n) => n.toLowerCase().replace(/\.$/, "")),
    urls,
    clientRedirects: page.clientRedirects,
    texts,
  }).map((s) => s.id);
  return { ids, price: extractAskingPrice(texts.join(" ")) };
}

describe("parking signatures", () => {
  it("have unique ids", () => {
    const ids = PARKING_SIGNATURES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("each list fixtures that exist", () => {
    for (const s of PARKING_SIGNATURES) {
      for (const f of s.fixtures) expect(SITE_CASES.has(f), `${s.id} → ${f}`).toBe(true);
    }
  });

  const pairs = PARKING_SIGNATURES.flatMap((s) => s.fixtures.map((f) => [s.id, f] as const));
  it.each(pairs)("%s fires on %s", async (id, fixture) => {
    const { ids } = await signalsFor(siteCase(fixture));
    expect(ids).toContain(id);
  });

  it.each(CONTROLS)("nothing fires on the real site %s", async (name) => {
    const { ids } = await signalsFor(siteCase(name));
    expect(ids).toEqual([]);
  });

  it("reads GoDaddy's for-sale page and its asking price", async () => {
    const { ids, price } = await signalsFor(siteCase("godaddy-lander"));
    expect(ids).toEqual(
      expect.arrayContaining(["ns-afternic", "redirect-godaddy-forsale", "text-for-sale"]),
    );
    expect(price).toEqual({ amount: 3995, currency: "$", source: "page" });
  });
});

describe("matchSignals", () => {
  const base = { domain: "acme.io", nameservers: [], urls: [], clientRedirects: [], texts: [] };

  it("matches nameserver suffixes on label boundaries only", () => {
    expect(
      matchSignals({ ...base, nameservers: ["ns1.sedoparking.com"] }).map((s) => s.id),
    ).toEqual(["ns-sedoparking"]);
    expect(matchSignals({ ...base, nameservers: ["ns1.notsedoparking.com"] })).toEqual([]);
  });

  it("doesn't treat the domain's own host as a marketplace redirect", () => {
    const sig = [
      {
        id: "r",
        kind: "redirect_host" as const,
        host: "acme.io",
        verdict: "for_sale" as const,
        description: "",
        fixtures: ["x"],
      },
    ];
    expect(matchSignals({ ...base, urls: ["https://www.acme.io/"] }, sig)).toEqual([]);
  });

  it("only counts /lander on the same host", () => {
    expect(
      matchSignals({ ...base, clientRedirects: ["https://acme.io/lander"] }).map((s) => s.id),
    ).toEqual(["lander-godaddy"]);
    expect(matchSignals({ ...base, clientRedirects: ["https://other.com/lander"] })).toEqual([]);
  });

  it.each([
    ["This domain is for sale!", true],
    ["This website may be for sale.", true],
    ["ACME.IO is for sale", true],
    ["acmexio is for sale", false],
    ["This 3-bedroom home is for sale in Denver", false],
    ["Our inventory is for sale at great prices", false],
  ])("text %j → %s", (text, hit) => {
    expect(matchSignals({ ...base, texts: [text] }).some((s) => s.id === "text-for-sale")).toBe(
      hit,
    );
  });
});

describe("extractAskingPrice", () => {
  it.each([
    ["Buy now: $3,795", { amount: 3795, currency: "$" }],
    ["Buy for $3,995 or Lease to Own", { amount: 3995, currency: "$" }],
    ["Asking price: €1.200", { amount: 1200, currency: "€" }],
    ["Buy now €2.500,00", { amount: 2500, currency: "€" }],
    ["Price: USD 12,500.50", { amount: 12500.5, currency: "USD" }],
    ["for sale £450", { amount: 450, currency: "£" }],
  ])("%j", (text, expected) => {
    expect(extractAskingPrice(text)).toEqual({ ...expected, source: "page" });
  });

  it.each([
    "Call us for pricing",
    "Only $158.13/mo. for 24 months",
    "Rated 4.5 out of 5",
    "Buy now $1,5",
    "Price: $1,200.500",
  ])("finds no asking price in %j", (text) => {
    expect(extractAskingPrice(text)).toBeUndefined();
  });
});
