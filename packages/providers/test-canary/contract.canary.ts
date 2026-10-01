// Contract canary: calls the live services with fixed inputs and checks that
// the responses still match the schemas and mappings built from fixtures/.
// A failure here means drift; the workflow opens an issue.

import { readFileSync } from "node:fs";
import { createOriginFetch, silentLogger, unlimited } from "@titlesearch/core";
import { describe, expect, it } from "vitest";
import { GODADDY_CHECK_TOOL, GODADDY_MCP } from "../src/godaddy/godaddy.js";
import { builtInMappings } from "../src/index.js";
import { NamecomProvider } from "../src/namecom/namecom.js";
import { PORKBUN_API, PorkbunProvider } from "../src/porkbun/porkbun.js";
import { BootstrapSchema, IANA_BOOTSTRAP_URL, parseBootstrap } from "../src/rdap/bootstrap.js";
import { RdapProvider } from "../src/rdap/rdap-provider.js";
import { UpstreamMcpClient } from "../src/upstream-mcp/client.js";
import { UpstreamMcpProvider } from "../src/upstream-mcp/provider.js";
import { resolveRefs, shape } from "./spec-shape.js";

// biome-ignore lint/suspicious/noExplicitAny: spec documents are free-form JSON.
type Loose = any;
const fixtureJson = (path: string): Loose =>
  JSON.parse(readFileSync(new URL(`../../../fixtures/${path}`, import.meta.url), "utf8"));

const fetchText = (url: string) =>
  createOriginFetch({ origins: [new URL(url).origin], maxBytes: 8 * 1024 * 1024 })(url);
const fetchSpec = async (url: string) => (await fetchText(url)).json();

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

// Price sources. The spec checks need no account. The live checks run only
// when CI has the keys as secrets; without them they're skipped, not passed.

describe("Porkbun spec", () => {
  it("still has the shape the adapter was written from", async () => {
    const saved = fixtureJson("porkbun/spec-contract.json");
    const spec = await fetchSpec(saved.source);
    const live = resolveRefs(spec, spec) as Loose;
    expect(live.servers.map((s: { url: string }) => s.url)).toContain(PORKBUN_API);
    expect(shape(live.paths["/domain/checkDomain"].post)).toEqual(shape(saved.checkDomainBulk));
    expect(shape(live.paths["/domain/checkDomain/{domain}"].post.responses["200"])).toEqual(
      shape(saved.checkDomainSingleResponse),
    );
  });
});

describe("Name.com spec", () => {
  it("still has the shape the adapter was written from", async () => {
    const saved = fixtureJson("namecom/spec-contract.json");
    const { parse } = await import("yaml");
    const spec = parse(await (await fetchText(saved.source)).text());
    const live = resolveRefs(spec, spec) as Loose;
    expect(live.info.description).toContain("api.name.com (production)");
    expect(shape(live.components.securitySchemes)).toEqual(shape(saved.securitySchemes));
    const op = live.paths["/core/v1/domains:checkAvailability"].post;
    expect(shape(op.requestBody)).toEqual(shape(saved.checkAvailability.requestBody));
    for (const code of Object.keys(saved.checkAvailability.responses))
      expect(shape(op.responses[code]), code).toEqual(
        shape(saved.checkAvailability.responses[code]),
      );
  });
});

const porkbunKeys =
  process.env.PORKBUN_API_KEY && process.env.PORKBUN_SECRET_API_KEY
    ? { apiKey: process.env.PORKBUN_API_KEY, secretApiKey: process.env.PORKBUN_SECRET_API_KEY }
    : undefined;
describe.skipIf(!porkbunKeys)("Porkbun live", () => {
  it("still maps a registered and an available domain", async () => {
    const provider = new PorkbunProvider(porkbunKeys as NonNullable<typeof porkbunKeys>);
    const results = await provider.check(["google.com", NX], ctx());
    expect(results.map((r) => r.availability)).toEqual(["registered", "available"]);
    expect(results[1]?.price?.currency).toBe("USD");
  });
});

const namecomKeys =
  process.env.NAMECOM_USERNAME && process.env.NAMECOM_TOKEN
    ? { username: process.env.NAMECOM_USERNAME, token: process.env.NAMECOM_TOKEN }
    : undefined;
describe.skipIf(!namecomKeys)("Name.com live", () => {
  it("still maps a registered and an available domain", async () => {
    const provider = new NamecomProvider({
      ...(namecomKeys as NonNullable<typeof namecomKeys>),
      ...(process.env.NAMECOM_ENVIRONMENT === "test" ? { environment: "test" as const } : {}),
    });
    const results = await provider.check(["google.com", NX], ctx());
    expect(results.map((r) => r.availability)).toEqual(["registered", "available"]);
  });
});
