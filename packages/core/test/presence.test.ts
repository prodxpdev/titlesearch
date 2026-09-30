// The probe end to end, against every recorded site: parked pages, for-sale
// marketplaces, and real sites as negative controls.

import { describe, expect, it } from "vitest";
import { PresenceEvidence } from "../src/model.js";
import { probePresence } from "../src/presence.js";
import { replayDns, replayTransport, siteCase } from "./sites.js";

const probe = (name: string) => {
  const c = siteCase(name);
  return probePresence(c.domain, {
    dns: replayDns(c),
    transport: replayTransport(c),
    signal: new AbortController().signal,
  });
};

describe("probePresence on recorded sites", () => {
  it.each([
    ["bluewidget.com", "for_sale", ["ns-afternic", "lander-godaddy"]],
    ["bluecandles.com", "for_sale", ["ns-namefind", "lander-godaddy"]],
    ["blueworks.com", "for_sale", ["ns-sedoparking", "text-for-sale"]],
    ["silvercoffee.com", "for_sale", ["ns-hugedomains", "redirect-hugedomains", "text-for-sale"]],
    ["greencoffee.com", "for_sale", ["ns-efty"]],
    ["quickcoffee.com", "for_sale", ["ns-atom", "redirect-atom"]],
    ["smarthub.com", "for_sale", ["ns-brandbucket", "redirect-brandbucket"]],
    ["blueyoga.com", "parked", ["ns-abovedomains"]],
    ["blueshoes.com", "parked", ["ns-parklogic"]],
    ["bluerealty.com", "unassessed", []],
    ["greengames.com", "unassessed", []],
  ])("%s → %s", async (name, occupancy, signals) => {
    const { evidence, occupancy: got } = await probe(name);
    expect(got).toBe(occupancy);
    expect([...evidence.parkingSignals].sort()).toEqual([...signals].sort());
    // Whatever the page held, the evidence fits the schema: capped, clean fields only.
    expect(PresenceEvidence.safeParse(evidence).success).toBe(true);
  });

  it("falls back to HTTP when HTTPS can't connect, and records why", async () => {
    const { evidence } = await probe("silvercoffee.com");
    expect(evidence.probeErrors).toEqual([
      { stage: "https", code: "network", message: expect.any(String) },
    ]);
    expect(evidence.http?.chain.map((h) => h.status)).toEqual([302, 200]);
    expect(evidence.http?.finalUrl).toBe(
      "https://www.hugedomains.com/domain_profile.cfm?d=silvercoffee.com",
    );
  });

  it("extracts the asking price from a for-sale page, labeled as from the page", async () => {
    const { evidence } = await probe("silvercoffee.com");
    expect(evidence.askingPrice).toEqual({ amount: 3795, currency: "$", source: "page" });
  });

  it("never extracts a price from a site that isn't for sale", async () => {
    const { evidence } = await probe("greengames.com");
    expect(evidence.askingPrice).toBeUndefined();
  });

  it("records a script redirect without following it", async () => {
    const c = siteCase("bluewidget.com");
    const transport = replayTransport(c);
    const { evidence } = await probePresence(c.domain, {
      dns: replayDns(c),
      transport,
      signal: new AbortController().signal,
    });
    expect(evidence.clientRedirects).toEqual(["https://bluewidget.com/lander"]);
    expect(transport.urls).toEqual(["https://bluewidget.com/"]);
    expect(evidence.contentConfidence).toBe("low");
  });

  it("keeps the signals when every fetch fails", async () => {
    const { evidence } = await probe("greencoffee.com");
    expect(evidence.http).toBeUndefined();
    expect(evidence.probeErrors.map((e) => e.stage)).toEqual(["https", "http"]);
  });

  it("describes a real site with normal confidence and valid TLS", async () => {
    const { evidence } = await probe("bluerealty.com");
    expect(evidence.contentConfidence).toBe("normal");
    expect(evidence.http?.tlsValid).toBe(true);
    expect(evidence.page?.title).toMatch(/^Blue Realty Team/);
    expect(evidence.untrustedSiteText?.length).toBeLessThanOrEqual(600);
    expect(evidence.dns.nameservers).toContain("ns67.domaincontrol.com");
  });

  it("follows a site through two redirects to another domain", async () => {
    const { evidence } = await probe("greengames.com");
    expect(evidence.http?.finalUrl).toBe("https://www.greentoys.com/");
    expect(evidence.page?.title).toMatch(/^Green Toys/);
  });
});

describe("probePresence without a site", () => {
  const dns = (
    records: Partial<Record<"A" | "AAAA" | "NS" | "MX", string[]>>,
    fail: string[] = [],
  ) => ({
    async query(_name: string, type: "A" | "AAAA" | "NS" | "MX") {
      if (fail.includes(type)) throw new Error("SERVFAIL");
      return { status: "ok" as const, records: records[type] ?? [], endpoint: "test" };
    },
    async resolveHost() {
      return [];
    },
  });
  const noTransport = {
    pinsAddress: false,
    request: async () => {
      throw new Error("should not fetch");
    },
  };

  it("reports no_site when there are no address records, and doesn't fetch", async () => {
    const r = await probePresence("acme.io", {
      dns: dns({ NS: ["ns1.example-dns.com"], MX: ["10 mx.acme.io"] }),
      transport: noTransport,
      signal: new AbortController().signal,
    });
    expect(r.occupancy).toBe("no_site");
    expect(r.evidence.dns).toEqual({
      hasA: false,
      hasAAAA: false,
      hasNS: true,
      hasMX: true,
      nameservers: ["ns1.example-dns.com"],
    });
  });

  it("keeps nameserver signals for a domain with no site", async () => {
    const r = await probePresence("acme.io", {
      dns: dns({ NS: ["ns1.afternic.com"] }),
      transport: noTransport,
      signal: new AbortController().signal,
    });
    expect(r.evidence.parkingSignals).toEqual(["ns-afternic"]);
    expect(r.occupancy).toBe("no_site");
  });

  it("says nothing about occupancy when the address lookups fail", async () => {
    const r = await probePresence("acme.io", {
      dns: dns({}, ["A", "AAAA"]),
      transport: noTransport,
      signal: new AbortController().signal,
    });
    expect(r.occupancy).toBeUndefined();
    expect(r.evidence.probeErrors[0]).toMatchObject({ stage: "dns" });
  });
});
