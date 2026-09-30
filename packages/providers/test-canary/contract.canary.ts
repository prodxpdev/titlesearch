// Contract canary: calls the live services with fixed inputs and checks that
// the responses still match the schemas and mappings built from fixtures/.
// A failure here means drift; the workflow opens an issue.

import { silentLogger, unlimited } from "@titlesearch/core";
import { describe, expect, it } from "vitest";
import { GODADDY_CHECK_TOOL, GODADDY_MCP } from "../src/godaddy/godaddy.js";
import { builtInMappings } from "../src/index.js";
import { BootstrapSchema, IANA_BOOTSTRAP_URL, parseBootstrap } from "../src/rdap/bootstrap.js";
import { RdapProvider } from "../src/rdap/rdap-provider.js";
import { UpstreamMcpClient } from "../src/upstream-mcp/client.js";
import { UpstreamMcpProvider } from "../src/upstream-mcp/provider.js";

const ctx = () => ({
  signal: AbortSignal.timeout(50_000),
  rateLimiter: unlimited,
  logger: silentLogger,
});
// Long enough that nobody registers it by accident. If it's ever registered,
// replace it and note the change in the issue.
const NX = "titlesearch-contract-canary-5d1e8b.com";

describe("IANA RDAP bootstrap", () => {
  it("still validates and maps .com", async () => {
    const provider = new RdapProvider();
    const [registered, missing] = await provider.check(["google.com", NX], ctx());
    expect(registered?.availability).toBe("registered");
    expect(missing?.availability).toBe("unregistered_at_registry");
    // Validates the file directly too, through the same schema.
    const { createOriginFetch } = await import("@titlesearch/core");
    const f = createOriginFetch({ origins: [new URL(IANA_BOOTSTRAP_URL).origin] });
    const file = BootstrapSchema.parse(await (await f(IANA_BOOTSTRAP_URL)).json());
    expect(parseBootstrap(file).baseUrls("com").length).toBeGreaterThan(0);
  });
});

describe("GoDaddy MCP", () => {
  it("still offers the check tool as read-only", async () => {
    const tools = await new UpstreamMcpClient(GODADDY_MCP).listTools();
    const tool = tools.find((t) => t.name === GODADDY_CHECK_TOOL);
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.annotations?.destructiveHint).not.toBe(true);
    expect(Object.keys((tool?.inputSchema.properties as Record<string, unknown>) ?? {})).toContain(
      "domains",
    );
  });

  it("still maps a registered and an available domain", async () => {
    const provider = new UpstreamMcpProvider(GODADDY_MCP, { mappings: builtInMappings() });
    const results = await provider.check(["google.com", NX], ctx());
    expect(results.map((r) => [r.availability, r.error?.code])).toEqual([
      ["registered", undefined],
      ["available", undefined],
    ]);
  });
});
