import { createRedactor, type Logger, reconcile } from "@titlesearch/core";
import { describe, expect, it } from "vitest";
import { GODADDY_MCP, godaddyMapping } from "../src/godaddy/godaddy.js";
import { builtInMappings } from "../src/index.js";
import { RdapProvider } from "../src/rdap/rdap-provider.js";
import { UpstreamMcpClient, UpstreamMcpError } from "../src/upstream-mcp/client.js";
import { describesWrite, UpstreamMcpConfig } from "../src/upstream-mcp/config.js";
import { MappingRegistry } from "../src/upstream-mcp/mapping.js";
import { UpstreamMcpProvider } from "../src/upstream-mcp/provider.js";
import {
  ctx,
  fakeTransport,
  fixtureJson,
  fixtureText,
  rdapFixture,
  sseFixture,
} from "./helpers.js";

interface RpcBody {
  id?: number;
  method: string;
  params?: { name?: string; arguments?: { domains?: string } };
}

/** A GoDaddy MCP double that replays recorded responses. */
function godaddyTransport(
  checks: Record<string, string>,
  overrides: { toolsList?: () => Response } = {},
) {
  return fakeTransport((_url, init) => {
    const msg = JSON.parse(init.body ?? "{}") as RpcBody;
    // Replace each recording's JSON-RPC id with the one this request used.
    const withId = (res: Response) =>
      res.text().then(
        (t) =>
          new Response(t.replace(/"id":\d+/, `"id":${msg.id}`), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      );
    switch (msg.method) {
      case "initialize":
        return withId(sseFixture("initialize"));
      case "notifications/initialized":
        return new Response(null, { status: 202 });
      case "tools/list":
        return withId(overrides.toolsList?.() ?? sseFixture("tools-list"));
      case "tools/call": {
        const file = checks[msg.params?.arguments?.domains ?? ""];
        if (!file) throw new Error(`Unexpected check for ${msg.params?.arguments?.domains}`);
        return withId(sseFixture(file));
      }
      default:
        throw new Error(`Unexpected method ${msg.method}`);
    }
  });
}

const NX = "titlesearch-nx-7c41e9";

describe("upstream MCP config", () => {
  it("accepts the GoDaddy config", () => {
    expect(UpstreamMcpConfig.parse(GODADDY_MCP)).toEqual(GODADDY_MCP);
  });

  it("requires checkTool to be allowlisted", () => {
    expect(
      UpstreamMcpConfig.safeParse({ ...GODADDY_MCP, checkTool: "domains_suggest" }).success,
    ).toBe(false);
  });

  it("requires a non-empty allowlist", () => {
    expect(UpstreamMcpConfig.safeParse({ ...GODADDY_MCP, allowedTools: [] }).success).toBe(false);
  });

  it("requires HTTPS", () => {
    expect(
      UpstreamMcpConfig.safeParse({ ...GODADDY_MCP, url: "http://api.godaddy.com/v1/domains/mcp" })
        .success,
    ).toBe(false);
  });

  it.each([
    "domain_register",
    "domains_purchase",
    "updateDnsRecord",
    "renew",
    "cart_add",
    "setNameservers",
  ])("refuses to allowlist %s", (tool) => {
    expect(describesWrite(tool)).toBe(true);
    expect(
      UpstreamMcpConfig.safeParse({ ...GODADDY_MCP, allowedTools: [GODADDY_MCP.checkTool, tool] })
        .success,
    ).toBe(false);
  });

  it.each(["domains_check_availability", "domains_suggest", "check_address", "get_settings"])(
    "allows %s",
    (tool) => {
      expect(describesWrite(tool)).toBe(false);
    },
  );
});

describe("UpstreamMcpClient", () => {
  it("refuses a tool that isn't allowlisted before sending anything", async () => {
    const transport = godaddyTransport({});
    const client = new UpstreamMcpClient(GODADDY_MCP, { transport });
    for (const name of ["domains_suggest", "domains_purchase", "domain_register"]) {
      await expect(client.callTool(name, {})).rejects.toMatchObject({ code: "tool_not_allowed" });
    }
    expect(transport.calls).toHaveLength(0);
  });

  it("initializes once, then calls the tool with the negotiated protocol version", async () => {
    const transport = godaddyTransport({ "google.com": "check-single-registered" });
    const client = new UpstreamMcpClient(GODADDY_MCP, { transport });
    await client.callTool("domains_check_availability", { domains: "google.com" });
    await client.listTools();
    const methods = transport.calls.map((c) => (JSON.parse(c.body ?? "{}") as RpcBody).method);
    expect(methods).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/list",
    ]);
    expect(transport.calls[0]?.headers.get("mcp-protocol-version")).toBeNull();
    expect(transport.calls[2]?.headers.get("mcp-protocol-version")).toBe("2025-06-18");
    expect(
      transport.calls.every(
        (c) => c.headers.get("accept") === "application/json, text/event-stream",
      ),
    ).toBe(true);
  });

  it("lists the recorded tools", async () => {
    const client = new UpstreamMcpClient(GODADDY_MCP, { transport: godaddyTransport({}) });
    const tools = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "domains_check_availability",
      "domains_suggest",
    ]);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it("sends the bearer token and echoes a session id", async () => {
    const config = { ...GODADDY_MCP, auth: { type: "bearer" as const, secretRef: "godaddy" } };
    let first = true;
    const inner = godaddyTransport({ "google.com": "check-single-registered" });
    const transport = {
      ...inner,
      async request(url: URL, init: Parameters<typeof inner.request>[1]) {
        const res = await inner.request(url, init);
        if (!first) return res;
        first = false;
        const headers = new Headers(res.headers);
        headers.set("mcp-session-id", "sess-123");
        return new Response(res.body, { status: res.status, headers });
      },
    };
    const client = new UpstreamMcpClient(config, { transport, bearerToken: "tok_abcdef123456" });
    await client.callTool("domains_check_availability", { domains: "google.com" });
    expect(
      inner.calls.every((c) => c.headers.get("authorization") === "Bearer tok_abcdef123456"),
    ).toBe(true);
    expect(inner.calls[1]?.headers.get("mcp-session-id")).toBe("sess-123");
  });

  it("reports a JSON-RPC error", async () => {
    const transport = fakeTransport((_u, init) => {
      const msg = JSON.parse(init.body ?? "{}") as RpcBody;
      if (msg.method === "initialize") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18" } }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (msg.method === "notifications/initialized") return new Response(null, { status: 202 });
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32602, message: "bad args" },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const client = new UpstreamMcpClient(GODADDY_MCP, { transport });
    await expect(client.listTools()).rejects.toMatchObject({ code: "rpc_error" });
  });

  it("reports rate limiting", async () => {
    const transport = fakeTransport(() => new Response("", { status: 429 }));
    const client = new UpstreamMcpClient(GODADDY_MCP, { transport });
    await expect(client.listTools()).rejects.toBeInstanceOf(UpstreamMcpError);
    await expect(client.listTools()).rejects.toMatchObject({ code: "rate_limited" });
  });
});

describe("GoDaddy mapping against recorded responses", () => {
  const result = (file: string) => {
    const raw = fixtureText(`godaddy/${file}.sse`);
    const data = raw
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => l.slice(6))
      .join("");
    return (JSON.parse(data) as { result: Parameters<typeof godaddyMapping.interpret>[0] }).result;
  };

  it.each([
    ["check-single-registered", "google.com", { availability: "registered" }],
    ["check-single-available", `${NX}.com`, { availability: "available", availabilityOnly: true }],
    // GoDaddy is availability-only: its "Registry Premium" and "Premium" map to available.
    [
      "check-single-premium-shoes.online",
      "shoes.online",
      { availability: "available", availabilityOnly: true },
    ],
    [
      "check-single-premium-bank.app",
      "bank.app",
      { availability: "available", availabilityOnly: true },
    ],
  ])("%s", (file, domain, expected) => {
    expect(godaddyMapping.interpret(result(file), domain)).toEqual(expected);
  });

  it("never reports a price, because GoDaddy's MCP returns none", () => {
    const outcome = godaddyMapping.interpret(result("check-single-available"), `${NX}.com`);
    expect("price" in outcome).toBe(false);
  });

  it("rejects the bulk shape, which can't tell premium from standard", () => {
    expect(godaddyMapping.interpret(result("check-bulk-premium"), "shoes.online")).toMatchObject({
      error: { code: "invalid_response" },
    });
  });

  it("rejects an answer for a different domain", () => {
    expect(godaddyMapping.interpret(result("check-single-available"), "other.com")).toMatchObject({
      error: { code: "inconsistent_response" },
    });
  });

  const base = result("check-single-available");
  const sc = base.structuredContent as { isAvailable: boolean; domains: Record<string, unknown>[] };
  const exact = sc.domains[0] as Record<string, unknown>;
  const variant = (patch: Record<string, unknown>, top: Record<string, unknown> = {}) => ({
    ...base,
    structuredContent: { ...sc, ...top, domains: [{ ...exact, ...patch }, ...sc.domains.slice(1)] },
  });

  it.each([
    ["an error result", { ...base, isError: true }, "upstream_error"],
    ["no structured content", { content: base.content }, "invalid_response"],
    ["an unknown inventory type", variant({ inventoryType: "Mystery" }), "unknown_inventory_type"],
    ["available but not purchasable", variant({ purchasable: false }), "inconsistent_response"],
    [
      "unavailable with an available exact match",
      variant({}, { isAvailable: false }),
      "inconsistent_response",
    ],
    [
      "isAvailable missing",
      { ...base, structuredContent: { domains: sc.domains } },
      "invalid_response",
    ],
  ])("returns an error for %s", (_label, input, code) => {
    expect(godaddyMapping.interpret(input, `${NX}.com`)).toMatchObject({ error: { code } });
  });

  it("maps Auction inventory to registered", () => {
    expect(godaddyMapping.interpret(variant({ inventoryType: "Auction" }), `${NX}.com`)).toEqual({
      availability: "registered",
    });
  });

  it("sends one domain per call", () => {
    expect(godaddyMapping.buildArguments("acme.io")).toEqual({ domains: "acme.io" });
  });
});

describe("UpstreamMcpProvider with GoDaddy", () => {
  const checks = {
    "google.com": "check-single-registered",
    [`${NX}.com`]: "check-single-available",
    "shoes.online": "check-single-premium-shoes.online",
    "bank.app": "check-single-premium-bank.app",
  };

  it("checks each domain and keeps order", async () => {
    const provider = new UpstreamMcpProvider(GODADDY_MCP, {
      mappings: builtInMappings(),
      transport: godaddyTransport(checks),
    });
    const results = await provider.check(["google.com", `${NX}.com`, "shoes.online"], ctx());
    expect(results.map((r) => [r.source, r.availability])).toEqual([
      ["godaddy", "registered"],
      ["godaddy", "available"],
      ["godaddy", "available"],
    ]);
  });

  it("reconciles GoDaddy's aftermarket listing against RDAP as unconfirmed", async () => {
    const godaddy = new UpstreamMcpProvider(GODADDY_MCP, {
      mappings: builtInMappings(),
      transport: godaddyTransport(checks),
    });
    const rdap = new RdapProvider({
      transport: fakeTransport((url) =>
        url.hostname === "data.iana.org"
          ? new Response(JSON.stringify(fixtureJson("rdap/iana-dns-bootstrap.json")))
          : rdapFixture("google-app-bank-registered"),
      ),
    });
    const sources = [
      ...(await rdap.check(["bank.app"], ctx())),
      ...(await godaddy.check(["bank.app"], ctx())),
    ];
    expect(sources.map((s) => s.availability)).toEqual(["registered", "available"]);
    expect(reconcile(sources)).toEqual({
      availability: "unconfirmed",
      reason: "registry_taken_registrar_free",
    });
  });

  it("refuses to run if the check tool stops declaring itself read-only", async () => {
    const tampered = fixtureText("godaddy/tools-list.sse").replaceAll(
      '"readOnlyHint":true',
      '"readOnlyHint":false',
    );
    const transport = godaddyTransport(checks, {
      toolsList: () => new Response(tampered, { headers: { "content-type": "text/event-stream" } }),
    });
    const provider = new UpstreamMcpProvider(GODADDY_MCP, {
      mappings: builtInMappings(),
      transport,
    });
    const results = await provider.check(["google.com"], ctx());
    expect(results[0]).toMatchObject({
      availability: "error",
      error: { code: "tool_not_allowed" },
    });
    const called = transport.calls.some(
      (c) => (JSON.parse(c.body ?? "{}") as RpcBody).method === "tools/call",
    );
    expect(called).toBe(false);
  });

  it("rejects a mapping written for a different tool", () => {
    const mappings = new MappingRegistry([
      { ...godaddyMapping, id: "wrong", tool: "domains_suggest" },
    ]);
    expect(
      () => new UpstreamMcpProvider({ ...GODADDY_MCP, mapping: "wrong" }, { mappings }),
    ).toThrow(/domains_suggest/);
  });

  it("rejects an unregistered mapping id", () => {
    expect(
      () =>
        new UpstreamMcpProvider(
          { ...GODADDY_MCP, mapping: "nope" },
          { mappings: builtInMappings() },
        ),
    ).toThrow(/No mapping/);
  });

  it("keeps the bearer token out of results and logs", async () => {
    const secret = "tok_supersecret_987654";
    const lines: string[] = [];
    const redact = createRedactor([secret]);
    const log = (m: string, f?: unknown) => lines.push(JSON.stringify(redact([m, f])));
    const logger: Logger = { debug: log, info: log, warn: log, error: log };
    const provider = new UpstreamMcpProvider(
      { ...GODADDY_MCP, auth: { type: "bearer", secretRef: "godaddy" } },
      {
        mappings: builtInMappings(),
        secrets: async () => secret,
        transport: fakeTransport(() => new Response("", { status: 500 })),
      },
    );
    const results = await provider.check(["google.com"], ctx({ logger }));
    expect(JSON.stringify(results)).not.toContain(secret);
    expect(lines.join("\n")).not.toContain(secret);
  });

  it("reports every domain as an error when the upstream is down", async () => {
    const provider = new UpstreamMcpProvider(GODADDY_MCP, {
      mappings: builtInMappings(),
      transport: fakeTransport(() => new Response("", { status: 503 })),
    });
    const results = await provider.check(["a.com", "b.com"], ctx());
    expect(results.map((r) => r.error?.code)).toEqual(["http_error", "http_error"]);
  });
});
