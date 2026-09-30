// In-process MCP tests: a real SDK client talking to the server over the
// SDK's in-memory transport.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  type Availability,
  type AvailabilityProvider,
  type DomainResult,
  type ProviderContext,
  silentLogger,
  unlimited,
} from "@titlesearch/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createTitlesearchMcpServer, type TitlesearchServices } from "../src/server.js";

function provider(
  id: string,
  answers: Record<string, Availability>,
  calls: string[][] = [],
): AvailabilityProvider {
  return {
    id,
    supports: () => true,
    async check(domains) {
      calls.push(domains);
      return domains.map((d) => ({
        source: id,
        availability: answers[d] ?? "unregistered_at_registry",
        checkedAt: "2026-09-30T12:00:00.000Z",
        latencyMs: 1,
      }));
    },
  };
}

async function connect(services: TitlesearchServices): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createTitlesearchMcpServer(services).connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

const context = (signal: AbortSignal): ProviderContext => ({
  signal,
  rateLimiter: unlimited,
  logger: silentLogger,
});

describe("tool listing", () => {
  let client: Client;
  beforeEach(async () => {
    client = await connect({ providers: [], context });
  });

  it("offers check_domains and generate_variants, annotated read-only and open-world", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["check_domains", "generate_variants"]);
    for (const t of tools) {
      expect(t.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      });
      expect(t.inputSchema.type).toBe("object");
      expect(t.outputSchema?.type).toBe("object");
    }
  });

  it("describes what matters to the model", async () => {
    const { tools } = await client.listTools();
    const check = tools.find((t) => t.name === "check_domains");
    expect(check?.description).toMatch(/NOT the same as purchasable/);
    expect(check?.description).toMatch(/isn't a trademark search/);
    expect(check?.description).toMatch(/Read-only/);
    const properties = (check?.inputSchema.properties ?? {}) as Record<
      string,
      { maxItems?: number }
    >;
    const names = properties.names;
    expect(names?.maxItems).toBe(20);
  });
});

describe("check_domains", () => {
  it("checks every name on every extension and returns structured results", async () => {
    const calls: string[][] = [];
    const client = await connect({
      providers: [
        provider("rdap", { "acme.com": "registered" }, calls),
        provider("godaddy", { "acme.com": "registered", "acme.io": "available" }),
      ],
      context,
    });
    const res = await client.callTool({
      name: "check_domains",
      arguments: { names: ["Acme"], tlds: ["com", "io"] },
    });
    expect(res.isError).toBeFalsy();
    const results = (res.structuredContent as { results: DomainResult[] }).results;
    expect(results.map((r) => [r.domain, r.availability])).toEqual([
      ["acme.com", "registered"],
      ["acme.io", "available"],
    ]);
    expect(calls).toEqual([["acme.com", "acme.io"]]);
    const text = (res.content as { type: string; text: string }[])[0]?.text ?? "";
    expect(text).toContain(
      "acme.io: available [rdap: unregistered_at_registry; godaddy: available]",
    );
  });

  it("explains unregistered_at_registry in the text result", async () => {
    const client = await connect({ providers: [provider("rdap", {})], context });
    const res = await client.callTool({
      name: "check_domains",
      arguments: { names: ["acme"], tlds: ["com"] },
    });
    const text = (res.content as { text: string }[])[0]?.text ?? "";
    expect(text).toContain("not at the registry (unconfirmed by a registrar)");
  });

  it("refuses more than 50 domains without calling any provider", async () => {
    const calls: string[][] = [];
    const client = await connect({ providers: [provider("rdap", {}, calls)], context });
    const names = Array.from({ length: 9 }, (_, i) => `name${i}`);
    const res = await client.callTool({ name: "check_domains", arguments: { names } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]?.text).toMatch(/At most 50 domains/);
    expect(calls).toHaveLength(0);
  });

  it("refuses more than 20 names at the schema", async () => {
    const client = await connect({ providers: [provider("rdap", {})], context });
    const names = Array.from({ length: 21 }, (_, i) => `n${i}.com`);
    const res = await client.callTool({ name: "check_domains", arguments: { names } });
    expect(res.isError).toBe(true);
  });

  it("reports an invalid name as a tool error", async () => {
    const client = await connect({ providers: [provider("rdap", {})], context });
    const res = await client.callTool({
      name: "check_domains",
      arguments: { names: ["not a/name"] },
    });
    expect(res.isError).toBe(true);
  });
});

describe("generate_variants", () => {
  it("returns deterministic candidates", async () => {
    const client = await connect({ providers: [], context });
    const res = await client.callTool({
      name: "generate_variants",
      arguments: { seed: "acme", strategies: ["tld", "plural"], tlds: ["io", "com"] },
    });
    expect(res.structuredContent).toEqual({
      candidates: [
        { domain: "acme.io", strategy: "seed" },
        { domain: "acme.com", strategy: "tld" },
        { domain: "acmes.io", strategy: "plural" },
      ],
    });
  });

  it("reports a bad seed as a tool error", async () => {
    const client = await connect({ providers: [], context });
    const res = await client.callTool({
      name: "generate_variants",
      arguments: { seed: "acme.com" },
    });
    expect(res.isError).toBe(true);
  });
});
