import { MemoryStore } from "@titlesearch/cache";
import { describe, expect, it } from "vitest";
import { type BootstrapFile, parseBootstrap } from "../src/rdap/bootstrap.js";
import { RdapProvider } from "../src/rdap/rdap-provider.js";
import { parseRetryAfter } from "../src/retry.js";
import type { WhoisConnector } from "../src/whois/connector.js";
import {
  ctx,
  fakeTransport,
  fixtureJson,
  fixtureText,
  rdapFixture,
  recordingLimiter,
} from "./helpers.js";

const bootstrapFile = fixtureJson<BootstrapFile>("rdap/iana-dns-bootstrap.json");
const NX = "titlesearch-nx-7c41e9";
const noSleep = { sleep: async () => {}, random: () => 0.5 };

/** Serves the recorded bootstrap and RDAP fixtures by URL. */
function rdapTransport(routes: Record<string, () => Response>) {
  return fakeTransport((url) => {
    if (url.href === "https://data.iana.org/rdap/dns.json") {
      return new Response(JSON.stringify(bootstrapFile), {
        headers: { "content-type": "application/json" },
      });
    }
    const route = routes[url.href];
    if (!route) throw new Error(`Unexpected request: ${url.href}`);
    return route();
  });
}

describe("bootstrap", () => {
  const b = parseBootstrap(bootstrapFile);

  it("maps extensions to HTTPS base URLs", () => {
    expect(b.baseUrls("com")).toEqual(["https://rdap.verisign.com/com/v1/"]);
    expect(b.baseUrls("COM")).toEqual(["https://rdap.verisign.com/com/v1/"]);
  });

  it("has no RDAP for .io, .co, or .de", () => {
    for (const tld of ["io", "co", "de", "me", "jp"]) expect(b.baseUrls(tld)).toEqual([]);
  });

  it("ignores HTTP-only services", () => {
    expect(b.baseUrls("kg")).toEqual([]);
    expect(b.baseUrls("mg")).toEqual([]);
    expect(b.origins().every((o) => o.startsWith("https://"))).toBe(true);
  });
});

describe("RdapProvider", () => {
  it("reports registered with the registrar and creation date", async () => {
    const transport = rdapTransport({
      "https://rdap.verisign.com/com/v1/domain/google.com": () =>
        rdapFixture("verisign-com-registered"),
    });
    const [r] = await new RdapProvider({ transport }).check(["google.com"], ctx());
    expect(r).toMatchObject({
      source: "rdap",
      availability: "registered",
      raw: { registrar: "MarkMonitor Inc.", created: "1997-09-15T04:00:00Z" },
    });
  });

  it("reports not found as unregistered_at_registry, never available", async () => {
    const transport = rdapTransport({
      [`https://rdap.verisign.com/com/v1/domain/${NX}.com`]: () =>
        rdapFixture("verisign-com-notfound"),
    });
    const [r] = await new RdapProvider({ transport }).check([`${NX}.com`], ctx());
    expect(r?.availability).toBe("unregistered_at_registry");
  });

  it("handles a ccTLD and multi-label names", async () => {
    const transport = rdapTransport({
      "https://rdap.nominet.uk/uk/domain/google.co.uk": () => rdapFixture("nominet-uk-registered"),
      [`https://rdap.nominet.uk/uk/domain/${NX}.co.uk`]: () => rdapFixture("nominet-uk-notfound"),
    });
    const results = await new RdapProvider({ transport }).check(
      ["google.co.uk", `${NX}.co.uk`],
      ctx(),
    );
    expect(results.map((r) => r.availability)).toEqual(["registered", "unregistered_at_registry"]);
    expect(results[0]?.raw?.registrar).toBe("Markmonitor Inc.");
  });

  it("treats a 403 as an error, not as not found", async () => {
    const transport = rdapTransport({
      "https://rdap.verisign.com/com/v1/domain/x-403.com": () =>
        rdapFixture("centralnic-403-unserved-tld"),
    });
    const [r] = await new RdapProvider({ transport }).check(["x-403.com"], ctx());
    expect(r).toMatchObject({ availability: "error", error: { code: "http_403" } });
  });

  it("rejects a 200 that describes a different domain", async () => {
    const transport = rdapTransport({
      "https://rdap.verisign.com/com/v1/domain/other.com": () =>
        rdapFixture("verisign-com-registered"),
    });
    const [r] = await new RdapProvider({ transport }).check(["other.com"], ctx());
    expect(r).toMatchObject({ availability: "error", error: { code: "invalid_response" } });
  });

  it("rejects a 200 that isn't a domain object", async () => {
    const transport = rdapTransport({
      "https://rdap.verisign.com/com/v1/domain/weird.com": () =>
        new Response("{}", { status: 200 }),
    });
    const [r] = await new RdapProvider({ transport }).check(["weird.com"], ctx());
    expect(r?.availability).toBe("error");
  });

  // Synthetic: a real 429 isn't something to provoke from a shared registry
  // server. The shape follows RFC 9110 (Retry-After in seconds).
  const tooMany = () => new Response("", { status: 429, headers: { "retry-after": "1" } });

  it("retries a 429, honoring Retry-After", async () => {
    let n = 0;
    const sleeps: number[] = [];
    const transport = rdapTransport({
      "https://rdap.verisign.com/com/v1/domain/google.com": () =>
        n++ === 0 ? tooMany() : rdapFixture("verisign-com-registered"),
    });
    const provider = new RdapProvider({
      transport,
      retry: { sleep: async (ms) => void sleeps.push(ms), random: () => 0 },
    });
    const [r] = await provider.check(["google.com"], ctx());
    expect(r?.availability).toBe("registered");
    expect(sleeps).toEqual([1000]);
  });

  it("gives up after two retries", async () => {
    let n = 0;
    const transport = rdapTransport({
      "https://rdap.verisign.com/com/v1/domain/google.com": () => {
        n++;
        return tooMany();
      },
    });
    const [r] = await new RdapProvider({ transport, retry: noSleep }).check(["google.com"], ctx());
    expect(r).toMatchObject({ availability: "error", error: { code: "rate_limited" } });
    expect(n).toBe(3);
  });

  it("doesn't wait out a long Retry-After", async () => {
    let n = 0;
    const transport = rdapTransport({
      "https://rdap.verisign.com/com/v1/domain/google.com": () => {
        n++;
        return new Response("", { status: 429, headers: { "retry-after": "3600" } });
      },
    });
    const [r] = await new RdapProvider({ transport, retry: noSleep }).check(["google.com"], ctx());
    expect(r?.error?.code).toBe("rate_limited");
    expect(n).toBe(1);
  });

  it("retries a 503", async () => {
    let n = 0;
    const transport = rdapTransport({
      "https://rdap.verisign.com/com/v1/domain/google.com": () =>
        n++ === 0 ? new Response("", { status: 503 }) : rdapFixture("verisign-com-registered"),
    });
    const [r] = await new RdapProvider({ transport, retry: noSleep }).check(["google.com"], ctx());
    expect(r?.availability).toBe("registered");
  });

  it("rate-limits per RDAP base URL", async () => {
    const limiter = recordingLimiter();
    const transport = rdapTransport({
      "https://rdap.verisign.com/com/v1/domain/google.com": () =>
        rdapFixture("verisign-com-registered"),
      "https://pubapi.registry.google/rdap/domain/google.app": () =>
        rdapFixture("google-app-registered"),
    });
    await new RdapProvider({ transport }).check(
      ["google.com", "google.app"],
      ctx({ rateLimiter: limiter }),
    );
    expect(limiter.keys.sort()).toEqual([
      "rdap:https://pubapi.registry.google/rdap/",
      "rdap:https://rdap.verisign.com/com/v1/",
    ]);
  });

  it("caches the bootstrap", async () => {
    const cache = new MemoryStore();
    const transport = rdapTransport({
      "https://rdap.verisign.com/com/v1/domain/google.com": () =>
        rdapFixture("verisign-com-registered"),
    });
    await new RdapProvider({ transport, cache }).check(["google.com"], ctx());
    await new RdapProvider({ transport, cache }).check(["google.com"], ctx());
    expect(transport.calls.filter((c) => c.url.includes("iana.org"))).toHaveLength(1);
  });

  it("reports every domain as an error when the bootstrap can't load", async () => {
    const transport = fakeTransport(() => new Response("", { status: 500 }));
    const results = await new RdapProvider({ transport }).check(["a.com", "b.com"], ctx());
    expect(results.map((r) => r.error?.code)).toEqual([
      "bootstrap_unavailable",
      "bootstrap_unavailable",
    ]);
  });

  it("returns one result per domain, in order", async () => {
    const transport = rdapTransport({
      "https://rdap.verisign.com/com/v1/domain/google.com": () =>
        rdapFixture("verisign-com-registered"),
      [`https://rdap.verisign.com/com/v1/domain/${NX}.com`]: () =>
        rdapFixture("verisign-com-notfound"),
    });
    const domains = [`${NX}.com`, "google.com", `${NX}.com`];
    const results = await new RdapProvider({ transport }).check(domains, ctx());
    expect(results.map((r) => r.availability)).toEqual([
      "unregistered_at_registry",
      "registered",
      "unregistered_at_registry",
    ]);
  });

  it("reports extensions with no RDAP and no WHOIS as errors", async () => {
    const [r] = await new RdapProvider({ transport: rdapTransport({}) }).check(
      ["google.io"],
      ctx(),
    );
    expect(r).toMatchObject({ availability: "error", error: { code: "no_registry_source" } });
  });
});

describe("WHOIS fallback", () => {
  function whoisFrom(files: Record<string, string>): WhoisConnector & { hosts: string[] } {
    const hosts: string[] = [];
    return {
      hosts,
      async query(host, query) {
        hosts.push(host);
        const file = files[`${host} ${query}`];
        if (!file) throw new Error(`Unexpected WHOIS query ${host} ${query}`);
        return fixtureText(`whois/${file}`);
      },
    };
  }

  it("answers .io from WHOIS", async () => {
    const connector = whoisFrom({
      "whois.nic.io google.io": "io-registered.txt",
      [`whois.nic.io ${NX}.io`]: "io-notfound.txt",
    });
    const provider = new RdapProvider({ transport: rdapTransport({}), whois: { connector } });
    const results = await provider.check(["google.io", `${NX}.io`], ctx());
    expect(results).toMatchObject([
      { source: "whois", availability: "registered", raw: { registrar: "MarkMonitor Inc." } },
      { source: "whois", availability: "unregistered_at_registry" },
    ]);
  });

  it("rate-limits per WHOIS host", async () => {
    const limiter = recordingLimiter();
    const connector = whoisFrom({ "whois.registry.co google.co": "co-registered.txt" });
    const provider = new RdapProvider({ transport: rdapTransport({}), whois: { connector } });
    await provider.check(["google.co"], ctx({ rateLimiter: limiter }));
    expect(limiter.keys).toEqual(["whois:whois.registry.co"]);
  });

  it("leaves .de off unless enabled", async () => {
    const connector = whoisFrom({ "whois.denic.de google.de": "de-registered.txt" });
    const off = new RdapProvider({ transport: rdapTransport({}), whois: { connector } });
    expect((await off.check(["google.de"], ctx()))[0]?.error?.code).toBe("no_registry_source");
    const on = new RdapProvider({
      transport: rdapTransport({}),
      whois: { connector, enable: ["de"] },
    });
    expect((await on.check(["google.de"], ctx()))[0]?.availability).toBe("registered");
  });

  it("never queries .eu or .ch", async () => {
    const connector = whoisFrom({});
    const provider = new RdapProvider({
      transport: rdapTransport({}),
      whois: { connector, enable: ["eu", "ch"] },
    });
    const results = await provider.check(["google.eu", "google.ch"], ctx());
    expect(results.map((r) => r.error?.code)).toEqual(["no_registry_source", "no_registry_source"]);
    expect(connector.hosts).toEqual([]);
  });

  it("reports an unrecognized response as an error", async () => {
    const connector: WhoisConnector = { query: async () => fixtureText("whois/ch-refused.txt") };
    const provider = new RdapProvider({ transport: rdapTransport({}), whois: { connector } });
    const [r] = await provider.check(["google.io"], ctx());
    expect(r).toMatchObject({
      source: "whois",
      availability: "error",
      error: { code: "unrecognized_response" },
    });
  });

  it("reports a connection failure as an error", async () => {
    const connector: WhoisConnector = {
      query: async () => {
        throw new Error("ECONNREFUSED");
      },
    };
    const provider = new RdapProvider({ transport: rdapTransport({}), whois: { connector } });
    const [r] = await provider.check(["google.io"], ctx());
    expect(r?.error?.code).toBe("network");
  });
});

describe("parseRetryAfter", () => {
  it("parses seconds and HTTP dates", () => {
    expect(parseRetryAfter("5", 0)).toBe(5000);
    expect(
      parseRetryAfter("Wed, 30 Sep 2026 15:00:10 GMT", Date.parse("2026-09-30T15:00:00Z")),
    ).toBe(10_000);
    expect(parseRetryAfter("soon", 0)).toBeUndefined();
    expect(parseRetryAfter(null, 0)).toBeUndefined();
  });
});
