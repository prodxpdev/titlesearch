import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ConflictClassifier } from "@titlesearch/assess";
import {
  type AvailabilityProvider,
  type DomainResult,
  type PresenceProbe,
  silentLogger,
  unlimited,
} from "@titlesearch/core";
import { describe, expect, it } from "vitest";
import { createTitlesearchMcpServer, type TitlesearchServices } from "../src/server.js";

const rdap: AvailabilityProvider = {
  id: "rdap",
  supports: () => true,
  check: async (ds) =>
    ds.map((d) => ({
      source: "rdap",
      availability: d.endsWith(".com") ? "registered" : "unregistered_at_registry",
      checkedAt: "2026-09-30T12:00:00.000Z",
      latencyMs: 1,
    })),
};

const probe: PresenceProbe = async (domain) => ({
  evidence: {
    domain,
    dns: { hasA: true, hasAAAA: false, hasNS: true, hasMX: true, nameservers: [] },
    page: { title: "Acme invoicing", jsonLdTypes: [] },
    untrustedSiteText: "Invoices for freelancers.",
    parkingSignals: [],
    clientRedirects: [],
    probeErrors: [],
    contentConfidence: "normal",
  },
  occupancy: "unassessed",
});

const classifier: ConflictClassifier = {
  id: "anthropic:test-model",
  assess: async (market, evidence) =>
    evidence.map((e) => ({
      domain: e.domain,
      level: "competitor",
      reasons: ["The title says invoicing.", "It targets freelancers."],
      assessedBy: "anthropic:test-model",
      market,
    })),
};

const context = (signal: AbortSignal) => ({ signal, rateLimiter: unlimited, logger: silentLogger });

async function connect(extra: Partial<TitlesearchServices> = {}): Promise<Client> {
  const [c, s] = InMemoryTransport.createLinkedPair();
  await createTitlesearchMcpServer({ providers: [rdap], probe, context, ...extra }).connect(s);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(c);
  return client;
}

const args = { name: "acme", market: "Invoicing for freelancers", tlds: ["com", "io"] };

describe("assess_market_conflicts", () => {
  it("in client mode asks the model to judge, and returns evidence unjudged", async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === "assess_market_conflicts");
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    expect(tool?.description).toMatch(/This server doesn't judge sites; you do/);
    expect(tool?.description).toMatch(/isn't a trademark search/);
    const res = await client.callTool({ name: "assess_market_conflicts", arguments: args });
    const out = res.structuredContent as { mode: string; results: DomainResult[]; notice: string };
    expect(out.mode).toBe("client");
    expect(out.results.map((r) => [r.domain, r.occupancy])).toEqual([
      ["acme.com", "unassessed"],
      ["acme.io", undefined],
    ]);
    expect(out.notice).toMatch(/isn't a trademark search/);
  });

  it("in server mode returns the classifier's assessments", async () => {
    const client = await connect({ assessment: { mode: "server", classifier } });
    const tool = (await client.listTools()).tools.find((t) => t.name === "assess_market_conflicts");
    expect(tool?.description).toMatch(/judges real sites with its own model/);
    const res = await client.callTool({ name: "assess_market_conflicts", arguments: args });
    const out = res.structuredContent as { assessedBy: string; results: DomainResult[] };
    expect(out.assessedBy).toBe("anthropic:test-model");
    expect(out.results[0]).toMatchObject({
      occupancy: "competitor",
      assessment: { level: "competitor" },
    });
    const text = (res.content as { text: string }[])[0]?.text ?? "";
    expect(text).toContain("Assessment (anthropic:test-model): competitor.");
    expect(text).toMatch(/isn't a trademark search\.$/);
  });

  it("in off mode says assessment is off", async () => {
    const client = await connect({ assessment: { mode: "off" } });
    const tool = (await client.listTools()).tools.find((t) => t.name === "assess_market_conflicts");
    expect(tool?.description).toMatch(/Assessment is turned off/);
  });

  it("refuses a name with an extension", async () => {
    const client = await connect();
    const res = await client.callTool({
      name: "assess_market_conflicts",
      arguments: { ...args, name: "acme.com" },
    });
    expect(res.isError).toBe(true);
  });

  it("refuses to start in server mode without a classifier", () => {
    expect(() =>
      createTitlesearchMcpServer({
        providers: [rdap],
        probe,
        context,
        assessment: { mode: "server" },
      }),
    ).toThrow(/classifier/);
  });
});

describe("saas_naming_session", () => {
  it("walks the five steps with the product and audience", async () => {
    const client = await connect();
    const { prompts } = await client.listPrompts();
    const p = prompts.find((x) => x.name === "saas_naming_session");
    expect(p?.arguments?.map((a) => a.name).sort()).toEqual(["audience", "product"]);
    const got = await client.getPrompt({
      name: "saas_naming_session",
      arguments: { product: "Invoicing app", audience: "Freelance designers" },
    });
    const content = got.messages[0]?.content;
    const text = content?.type === "text" ? content.text : "";
    expect(text).toContain("Product: Invoicing app");
    expect(text).toContain("Audience: Freelance designers");
    for (const step of ["1. ", "2. ", "3. ", "4. ", "5. "]) expect(text).toContain(step);
    for (const tool of ["generate_variants", "check_domains", "assess_market_conflicts"])
      expect(text).toContain(tool);
    expect(text).toMatch(/isn't a trademark search/);
  });
});
