// DoH resolver tests against responses recorded from Cloudflare and Google
// (fixtures/doh/). No live network.

import { describe, expect, it } from "vitest";
import cfA from "../../../fixtures/doh/cloudflare-example.com-A.json" with { type: "json" };
import cfAAAA from "../../../fixtures/doh/cloudflare-example.com-AAAA.json" with { type: "json" };
import cfMX from "../../../fixtures/doh/cloudflare-example.com-MX.json" with { type: "json" };
import cfNS from "../../../fixtures/doh/cloudflare-example.com-NS.json" with { type: "json" };
import cfNx from "../../../fixtures/doh/cloudflare-nxdomain-A.json" with { type: "json" };
import cfCname from "../../../fixtures/doh/cloudflare-www.github.com-A.json" with { type: "json" };
import gA from "../../../fixtures/doh/google-example.com-A.json" with { type: "json" };
import gAAAA from "../../../fixtures/doh/google-example.com-AAAA.json" with { type: "json" };
import gNS from "../../../fixtures/doh/google-example.com-NS.json" with { type: "json" };
import { DnsError, DohResolver } from "../src/net/doh.js";
import { fakeTransport, json } from "./stubs.js";

type Routes = Record<string, unknown | (() => Response)>;

/** Routes keyed by "<host> <name> <type>". */
function dohTransport(routes: Routes) {
  return fakeTransport((url) => {
    const key = `${url.hostname} ${url.searchParams.get("name")} ${url.searchParams.get("type")}`;
    const route = routes[key];
    if (route === undefined) return new Response("not found", { status: 404 });
    return typeof route === "function" ? (route as () => Response)() : json(route);
  });
}

const CF = "cloudflare-dns.com";
const G = "dns.google";

describe("DohResolver.query", () => {
  it("parses A records", async () => {
    const r = new DohResolver({ transport: dohTransport({ [`${CF} example.com A`]: cfA }) });
    await expect(r.query("example.com", "A")).resolves.toEqual({
      status: "ok",
      records: ["104.20.23.154", "172.66.147.243"],
      endpoint: "cloudflare",
    });
  });

  it("parses AAAA records", async () => {
    const r = new DohResolver({ transport: dohTransport({ [`${CF} example.com AAAA`]: cfAAAA }) });
    const answer = await r.query("example.com", "AAAA");
    expect(answer.records).toEqual(["2606:4700:10::ac42:93f3", "2606:4700:10::6814:179a"]);
  });

  it("normalizes NS host names", async () => {
    const r = new DohResolver({ transport: dohTransport({ [`${CF} example.com NS`]: cfNS }) });
    const answer = await r.query("example.com", "NS");
    expect(answer.records).toEqual(["hera.ns.cloudflare.com", "elliott.ns.cloudflare.com"]);
  });

  it("treats a null MX as no mail", async () => {
    const r = new DohResolver({ transport: dohTransport({ [`${CF} example.com MX`]: cfMX }) });
    await expect(r.query("example.com", "MX")).resolves.toMatchObject({
      status: "ok",
      records: [],
    });
  });

  it("keeps normal MX records", async () => {
    const mx = {
      Status: 0,
      Answer: [{ name: "acme.io", type: 15, TTL: 300, data: "10 ASPMX.L.GOOGLE.COM." }],
    };
    const r = new DohResolver({ transport: dohTransport({ [`${CF} acme.io MX`]: mx }) });
    await expect(r.query("acme.io", "MX")).resolves.toMatchObject({
      records: ["10 aspmx.l.google.com"],
    });
  });

  it("follows a CNAME chain to the requested type", async () => {
    const r = new DohResolver({ transport: dohTransport({ [`${CF} www.github.com A`]: cfCname }) });
    await expect(r.query("www.github.com", "A")).resolves.toMatchObject({
      records: ["140.82.114.3"],
    });
  });

  it("reports NXDOMAIN", async () => {
    const name = "titlesearch-nonexistent-9f3a2c.com";
    const r = new DohResolver({ transport: dohTransport({ [`${CF} ${name} A`]: cfNx }) });
    await expect(r.query(name, "A")).resolves.toEqual({
      status: "nxdomain",
      records: [],
      endpoint: "cloudflare",
    });
  });

  it("falls back to Google when Cloudflare fails", async () => {
    const r = new DohResolver({
      transport: dohTransport({
        [`${CF} example.com A`]: () => new Response("busy", { status: 503 }),
        [`${G} example.com A`]: gA,
      }),
    });
    await expect(r.query("example.com", "A")).resolves.toMatchObject({
      endpoint: "google",
      records: ["104.20.23.154", "172.66.147.243"],
    });
  });

  it("falls back on SERVFAIL", async () => {
    const r = new DohResolver({
      transport: dohTransport({
        [`${CF} example.com NS`]: { Status: 2 },
        [`${G} example.com NS`]: gNS,
      }),
    });
    await expect(r.query("example.com", "NS")).resolves.toMatchObject({ endpoint: "google" });
  });

  it("falls back on a response that fails validation", async () => {
    const r = new DohResolver({
      transport: dohTransport({
        [`${CF} example.com A`]: { Status: "ok" },
        [`${G} example.com A`]: gA,
      }),
    });
    await expect(r.query("example.com", "A")).resolves.toMatchObject({ endpoint: "google" });
  });

  it("falls back on a malformed address instead of passing it on", async () => {
    const bad = { Status: 0, Answer: [{ name: "example.com", type: 1, data: "127.1" }] };
    const r = new DohResolver({
      transport: dohTransport({ [`${CF} example.com A`]: bad, [`${G} example.com A`]: gA }),
    });
    await expect(r.query("example.com", "A")).resolves.toMatchObject({ endpoint: "google" });
  });

  it("falls back on a truncated response", async () => {
    const r = new DohResolver({
      transport: dohTransport({
        [`${CF} example.com A`]: { ...cfA, TC: true },
        [`${G} example.com A`]: gA,
      }),
    });
    await expect(r.query("example.com", "A")).resolves.toMatchObject({ endpoint: "google" });
  });

  it("throws DnsError when every resolver fails", async () => {
    const r = new DohResolver({ transport: dohTransport({}) });
    const err = await r.query("example.com", "A").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DnsError);
    expect((err as DnsError).attempts.map((a) => a.endpoint)).toEqual(["cloudflare", "google"]);
  });

  it("sends the JSON accept header and nothing user-controlled in the path", async () => {
    const t = dohTransport({ [`${CF} example.com A`]: cfA });
    await new DohResolver({ transport: t }).query("example.com", "A");
    expect(t.calls[0]?.url).toBe("https://cloudflare-dns.com/dns-query?name=example.com&type=A");
    expect(t.calls[0]?.headers.get("accept")).toBe("application/dns-json");
  });
});

describe("DohResolver.resolveHost", () => {
  it("returns IPv4 and IPv6 addresses together", async () => {
    const r = new DohResolver({
      transport: dohTransport({ [`${CF} example.com A`]: cfA, [`${CF} example.com AAAA`]: cfAAAA }),
    });
    await expect(r.resolveHost("example.com")).resolves.toEqual([
      "104.20.23.154",
      "172.66.147.243",
      "2606:4700:10::ac42:93f3",
      "2606:4700:10::6814:179a",
    ]);
  });

  it("returns nothing for a name that doesn't exist", async () => {
    const name = "titlesearch-nonexistent-9f3a2c.com";
    const r = new DohResolver({
      transport: dohTransport({ [`${CF} ${name} A`]: cfNx, [`${CF} ${name} AAAA`]: { ...cfNx } }),
    });
    await expect(r.resolveHost(name)).resolves.toEqual([]);
  });

  it("throws when one address family can't be looked up", async () => {
    // A partial answer would let an unchecked AAAA address through.
    const r = new DohResolver({
      transport: dohTransport({ [`${CF} example.com A`]: cfA, [`${G} example.com A`]: gA }),
    });
    await expect(r.resolveHost("example.com")).rejects.toBeInstanceOf(DnsError);
  });

  it("uses Google's answers when Cloudflare is down", async () => {
    const r = new DohResolver({
      transport: dohTransport({ [`${G} example.com A`]: gA, [`${G} example.com AAAA`]: gAAAA }),
    });
    await expect(r.resolveHost("example.com")).resolves.toHaveLength(4);
  });
});
