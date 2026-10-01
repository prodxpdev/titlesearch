// suggest_names over the in-memory MCP transport, with a stub suggester.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type NameSuggester, SuggestionError } from "@titlesearch/assess";
import { type ProviderContext, silentLogger, unlimited } from "@titlesearch/core";
import { describe, expect, it } from "vitest";
import { createTitlesearchMcpServer, type TitlesearchServices } from "../src/server.js";

const context = (signal: AbortSignal): ProviderContext => ({
  signal,
  rateLimiter: unlimited,
  logger: silentLogger,
});

async function connect(services: TitlesearchServices): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createTitlesearchMcpServer(services).connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

function stub(
  fail = false,
): NameSuggester & { asked: { description: string; count?: number; avoid?: readonly string[] }[] } {
  const asked: { description: string; count?: number; avoid?: readonly string[] }[] = [];
  return {
    id: "stub:model",
    asked,
    async suggest(description, options = {}) {
      asked.push({
        description,
        ...(options.count ? { count: options.count } : {}),
        ...(options.avoid ? { avoid: options.avoid } : {}),
      });
      if (fail) throw new SuggestionError("No usable names came back. Try again.");
      return Array.from({ length: options.count ?? 10 }, (_, i) => ({
        name: `crewly${i}`,
        rationale: "Crews, dispatched.",
        style: "coined" as const,
      }));
    },
  };
}

const rdap = {
  id: "rdap",
  supports: () => true,
  async check(domains: string[]) {
    return domains.map(() => ({
      source: "rdap",
      availability: "unregistered_at_registry" as const,
      checkedAt: "2026-10-01T12:00:00.000Z",
      latencyMs: 1,
    }));
  },
};

describe("suggest_names", () => {
  it("is offered only when the server has a suggester", async () => {
    const without = await connect({ providers: [], context });
    expect((await without.listTools()).tools.map((t) => t.name)).not.toContain("suggest_names");
    const withIt = await connect({ providers: [], context, suggester: stub() });
    const tool = (await withIt.listTools()).tools.find((t) => t.name === "suggest_names");
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    expect(tool?.description).toMatch(/isn't a trademark search/);
  });

  it("returns suggestions, passing count and avoid through", async () => {
    const suggester = stub();
    const client = await connect({ providers: [], context, suggester });
    const res = await client.callTool({
      name: "suggest_names",
      arguments: {
        description: "Dispatch software for field crews",
        count: 3,
        avoid: ["fieldloom"],
      },
    });
    const out = res.structuredContent as {
      suggestions: { name: string }[];
      suggestedBy: string;
      results?: unknown;
    };
    expect(out.suggestions.map((s) => s.name)).toEqual(["crewly0", "crewly1", "crewly2"]);
    expect(out.suggestedBy).toBe("stub:model");
    expect(out.results).toBeUndefined();
    expect(suggester.asked[0]).toEqual({
      description: "Dispatch software for field crews",
      count: 3,
      avoid: ["fieldloom"],
    });
  });

  it("checks availability when given extensions, keeping within 50 domains", async () => {
    const suggester = stub();
    const client = await connect({ providers: [rdap], context, suggester });
    const res = await client.callTool({
      name: "suggest_names",
      arguments: {
        description: "Dispatch software",
        count: 20,
        tlds: ["com", "io", "app", "dev", "co", "ai"],
      },
    });
    const out = res.structuredContent as { suggestions: unknown[]; results: { domain: string }[] };
    // 50 domains / 6 extensions = 8 names.
    expect(suggester.asked[0]?.count).toBe(8);
    expect(out.results).toHaveLength(48);
    expect(out.results[0]?.domain).toBe("crewly0.com");
  });

  it("reports a failed suggestion as a tool error", async () => {
    const client = await connect({ providers: [], context, suggester: stub(true) });
    const res = await client.callTool({
      name: "suggest_names",
      arguments: { description: "x y z" },
    });
    expect(res.isError).toBe(true);
  });

  it("points the naming prompt at suggest_names only when it exists", async () => {
    const probe = async () => ({ evidence: {} as never, occupancy: "no_site" as const });
    const text = async (s?: NameSuggester) => {
      const c = await connect({ providers: [], context, probe, ...(s ? { suggester: s } : {}) });
      const p = await c.getPrompt({
        name: "saas_naming_session",
        arguments: { product: "dispatch", audience: "crews" },
      });
      const first = p.messages[0];
      return first ? (first.content as { text: string }).text : "";
    };
    expect(await text(stub())).toContain("Run suggest_names");
    expect(await text()).not.toContain("suggest_names");
  });
});
