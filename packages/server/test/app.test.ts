import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MemoryStore } from "@titlesearch/cache";
import {
  type Availability,
  type AvailabilityProvider,
  cacheKeys,
  type PresenceProbe,
  silentLogger,
  unlimited,
} from "@titlesearch/core";
import type { TitlesearchServices } from "@titlesearch/mcp";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { LocalAuth } from "../src/auth.js";
import type { Settings, SettingsHandler } from "../src/settings.js";

const PORT = 4717;
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://${HOST}`;
const TOKEN = "t".repeat(40);

const provider = (id: string, a: (d: string) => Availability): AvailabilityProvider => ({
  id,
  supports: () => true,
  check: async (ds) =>
    ds.map((d) => ({
      source: id,
      availability: a(d),
      checkedAt: "2026-09-30T12:00:00.000Z",
      latencyMs: 1,
    })),
});

const probe: PresenceProbe = async (domain) => ({
  evidence: {
    domain,
    dns: { hasA: true, hasAAAA: false, hasNS: true, hasMX: false, nameservers: [] },
    page: { title: "Acme", jsonLdTypes: [] },
    untrustedSiteText: "Invoices for freelancers.",
    parkingSignals: [],
    clientRedirects: [],
    probeErrors: [],
    contentConfidence: "normal",
  },
  occupancy: "unassessed",
});

function setup(
  overrides: Partial<Parameters<typeof createApp>[0]> = {},
  services: Partial<TitlesearchServices> = {},
) {
  const auth = new LocalAuth({ token: TOKEN, port: PORT });
  const blobs = new MemoryStore();
  const svc: TitlesearchServices = {
    providers: [
      provider("rdap", (d) => (d.startsWith("free") ? "unregistered_at_registry" : "registered")),
    ],
    probe,
    blobs,
    context: (signal) => ({ signal, rateLimiter: unlimited, logger: silentLogger }),
    ...services,
  };
  const app = createApp({ services: () => svc, auth, version: "0.0.0-test", ...overrides });
  type Init = Omit<RequestInit, "headers"> & { headers?: Record<string, string> };
  const req = (path: string, init: Init = {}) =>
    app.request(path, { ...init, headers: { host: HOST, ...init.headers } });
  const authed = (path: string, init: Init = {}) =>
    req(path, { ...init, headers: { authorization: `Bearer ${TOKEN}`, ...init.headers } });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    authed(path, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", ...headers },
    });
  return { app, auth, req, authed, post, blobs };
}

describe("local surface checks (invariant 5)", () => {
  it.each(["evil.example:4717", "127.0.0.1:9999", "192.168.1.5:4717", undefined])(
    "refuses Host %s",
    async (host) => {
      const { app } = setup();
      const res = await app.request("/api/check", { headers: host ? { host } : {} });
      expect(res.status).toBe(403);
    },
  );

  it("accepts localhost as well as 127.0.0.1", async () => {
    const { app } = setup();
    const res = await app.request("/", { headers: { host: `localhost:${PORT}` } });
    expect(res.status).toBe(200);
  });

  it.each(["https://evil.example", "null", "http://127.0.0.1:9999"])(
    "refuses Origin %s",
    async (origin) => {
      const { authed } = setup();
      expect((await authed("/api/settings", { headers: { origin } })).status).toBe(403);
    },
  );

  it("requires credentials on the API and MCP", async () => {
    const { req } = setup();
    for (const path of ["/api/providers/health", "/api/settings", "/mcp"]) {
      expect((await req(path)).status).toBe(401);
    }
    expect((await req("/api/check", { headers: { authorization: "Bearer wrong" } })).status).toBe(
      401,
    );
  });

  it("sets security headers everywhere", async () => {
    const { req } = setup();
    const res = await req("/");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
  });
});

describe("login codes and sessions", () => {
  const login = (req: ReturnType<typeof setup>["req"], code: string) =>
    req("/api/session", {
      method: "POST",
      body: JSON.stringify({ code }),
      headers: { "content-type": "application/json", origin: ORIGIN },
    });

  it("exchanges a one-time code for an HttpOnly, SameSite=Strict cookie", async () => {
    const { auth, req } = setup();
    const code = auth.issueLoginCode();
    const res = await login(req, code.toLowerCase());
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/ts_session=[0-9a-f]{64}/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    const session = cookie.split(";")[0] ?? "";
    expect((await req("/api/session", { headers: { cookie: session } })).status).toBe(200);
    expect(await (await req("/api/settings", { headers: { cookie: session } })).status).not.toBe(
      401,
    );
    // The code works once.
    expect((await login(req, code)).status).toBe(401);
  });

  it("locks the code after five wrong tries", async () => {
    const { auth, req } = setup();
    const code = auth.issueLoginCode();
    for (let i = 0; i < 5; i++) expect((await login(req, "WRONGCODE0")).status).toBe(401);
    expect((await login(req, code)).status).toBe(401);
  });

  it("requires Origin on cookie-authenticated changes", async () => {
    const { auth, req } = setup({ rotateToken: async () => "n".repeat(40) });
    const res = await login(req, auth.issueLoginCode());
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect((await req("/api/token/rotate", { method: "POST", headers: { cookie } })).status).toBe(
      403,
    );
    expect(
      (await req("/api/token/rotate", { method: "POST", headers: { cookie, origin: ORIGIN } }))
        .status,
    ).toBe(200);
  });

  it("rotates the token: the old one stops working", async () => {
    const { req, authed } = setup({ rotateToken: async () => "n".repeat(40) });
    const res = await authed("/api/token/rotate", { method: "POST" });
    expect(await res.json()).toEqual({ token: "n".repeat(40) });
    expect((await authed("/api/variants", { method: "POST", body: "{}" })).status).toBe(401);
    expect(
      (
        await req("/api/providers/health", {
          headers: { authorization: `Bearer ${"n".repeat(40)}` },
        })
      ).status,
    ).toBe(200);
  });
});

describe("limits", () => {
  it("rate-limits each principal", async () => {
    const { authed } = setup({ limits: { perMinute: 3 } });
    for (let i = 0; i < 3; i++) expect((await authed("/api/providers/health")).status).toBe(200);
    const res = await authed("/api/providers/health");
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("caps concurrent outbound work", async () => {
    let release: () => void = () => {};
    const slow: AvailabilityProvider = {
      id: "slow",
      supports: () => true,
      check: (ds) =>
        new Promise((resolve) => {
          release = () =>
            resolve(
              ds.map(() => ({
                source: "slow",
                availability: "registered",
                checkedAt: "2026-09-30T12:00:00.000Z",
                latencyMs: 1,
              })),
            );
        }),
    };
    const { post } = setup({ limits: { concurrency: 1, queued: 0 } }, { providers: [slow] });
    const first = post("/api/check", { names: ["a"], tlds: ["com"] });
    await new Promise((r) => setTimeout(r, 10));
    const second = await post("/api/check", { names: ["b"], tlds: ["com"] });
    expect(second.status).toBe(503);
    release();
    expect((await first).status).toBe(200);
  });
});

describe("REST routes", () => {
  it("POST /api/check", async () => {
    const { post } = setup();
    const res = await post("/api/check", { names: ["acme", "free"], tlds: ["com"] });
    const body = (await res.json()) as { results: { domain: string; availability: string }[] };
    expect(body.results.map((r) => [r.domain, r.availability])).toEqual([
      ["acme.com", "registered"],
      ["free.com", "unregistered_at_registry"],
    ]);
  });

  it.each([
    [{ names: Array.from({ length: 21 }, (_, i) => `n${i}`) }, /names/],
    [{ names: Array.from({ length: 9 }, (_, i) => `n${i}`) }, /At most 50 domains/],
    [{ names: ["acme"], extra: true }, /Unrecognized|unrecognized|extra/],
    [{ names: ["has space"] }, /./],
  ])("rejects %j", async (body, message) => {
    const { post } = setup();
    const res = await post("/api/check", body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(message);
  });

  it("rejects invalid JSON and oversized bodies", async () => {
    const { authed } = setup();
    expect((await authed("/api/check", { method: "POST", body: "{" })).status).toBe(400);
    expect((await authed("/api/check", { method: "POST", body: "x".repeat(70_000) })).status).toBe(
      400,
    );
  });

  it("GET /api/domain/:domain", async () => {
    const { authed } = setup();
    const r = (await (await authed("/api/domain/Acme.io")).json()) as {
      domain: string;
      occupancy: string;
    };
    expect(r).toMatchObject({ domain: "acme.io", occupancy: "unassessed" });
    expect((await authed("/api/domain/not%20a%20domain")).status).toBe(400);
  });

  it("POST /api/assess returns evidence and the trademark notice", async () => {
    const { post } = setup();
    const res = await post("/api/assess", {
      name: "acme",
      market: "Invoicing for freelancers",
      tlds: ["com"],
    });
    const body = (await res.json()) as { mode: string; notice: string; results: unknown[] };
    expect(body.mode).toBe("off");
    expect(body.notice).toMatch(/isn't a trademark search/);
    expect(body.results).toHaveLength(1);
  });

  it("POST /api/variants", async () => {
    const { post } = setup();
    const res = await post("/api/variants", {
      seed: "acme",
      strategies: ["tld"],
      tlds: ["com", "io"],
    });
    expect(await res.json()).toEqual({
      candidates: [
        { domain: "acme.com", strategy: "seed" },
        { domain: "acme.io", strategy: "tld" },
      ],
    });
  });

  it("GET /api/providers/health", async () => {
    const { authed } = setup(
      {},
      {
        providers: [
          provider("rdap", () => "registered"),
          provider("odd", () => "available"),
          provider("down", () => "error"),
        ],
      },
    );
    const body = (await (await authed("/api/providers/health")).json()) as {
      providers: { id: string; status: string }[];
    };
    expect(body.providers.map((p) => [p.id, p.status])).toEqual([
      ["rdap", "ok"],
      ["odd", "degraded"],
      ["down", "error"],
    ]);
  });

  it("GET /api/preview/:hash serves stored WebP only", async () => {
    const { authed, blobs } = setup();
    const hash = "f".repeat(64);
    await blobs.putBlob(cacheKeys.previewImage(hash), Uint8Array.from([1, 2]), "image/webp", 60);
    const res = await authed(`/api/preview/${hash}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect((await authed("/api/preview/..%2F..%2Fetc")).status).toBe(400);
  });

  it("returns JSON 404 for unknown API routes", async () => {
    const { authed } = setup();
    const res = await authed("/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("/api/suggest", () => {
  const suggester = {
    id: "stub:model",
    async suggest(description: string, o: { count?: number; avoid?: readonly string[] } = {}) {
      if (description.includes("fail")) {
        const { SuggestionError } = await import("@titlesearch/assess");
        throw new SuggestionError("No usable names came back. Try again.");
      }
      return Array.from({ length: o.count ?? 2 }, (_, i) => ({
        name: `crewly${i}`,
        rationale: "Crews, dispatched.",
        style: "coined" as const,
      }));
    },
  };
  const post = (s: ReturnType<typeof setup>, body: unknown) =>
    s.post("/api/suggest", body, { origin: ORIGIN });

  it("returns validated suggestions with the not-a-trademark notice", async () => {
    const res = await post(setup({}, { suggester }), {
      description: "Dispatch for crews",
      count: 3,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      suggestions: unknown[];
      suggestedBy: string;
      notice: string;
    };
    expect(body.suggestions).toHaveLength(3);
    expect(body.suggestedBy).toBe("stub:model");
    expect(body.notice).toMatch(/trademark/);
  });

  it("says why when the server has no model", async () => {
    const res = await post(setup(), { description: "Dispatch for crews" });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "unavailable" } });
  });

  it("rejects a bad request and reports a failed suggestion", async () => {
    expect((await post(setup({}, { suggester }), { description: "" })).status).toBe(400);
    expect((await post(setup({}, { suggester }), { description: "x", count: 99 })).status).toBe(
      400,
    );
    const failed = await post(setup({}, { suggester }), { description: "please fail" });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ error: { code: "suggestions_failed" } });
  });
});

describe("settings", () => {
  const settings: Settings = {
    providers: {
      rdap: { enabled: true },
      godaddy: { enabled: true },
      porkbun: { enabled: false, configured: false },
      namecom: { enabled: false, configured: false },
    },
    assessment: {
      mode: "client",
      model: {
        provider: "anthropic",
        id: "claude-opus-5-5",
        label: "Anthropic · claude-opus-5-5 (Anthropic API)",
        local: false,
      },
      ready: false,
      unavailableReason: "Add an Anthropic API key.",
      keyConfigured: false,
    },
    suggestions: { available: false },
    previews: { mode: "local", browser: "system" },
    keys: {
      storage: "keychain",
      set: {
        ANTHROPIC_API_KEY: false,
        OPENAI_COMPATIBLE_API_KEY: false,
        PORKBUN_API_KEY: false,
        PORKBUN_SECRET_API_KEY: false,
        NAMECOM_USERNAME: false,
        NAMECOM_TOKEN: false,
      },
    },
    siteChecks: { timeoutSeconds: 5, maxRedirects: 3, pageKilobytes: 512, cacheHours: 6 },
  };
  const handler = (): SettingsHandler & {
    patches: unknown[];
    keys: [string, string | null][];
  } => {
    const patches: unknown[] = [];
    const keys: [string, string | null][] = [];
    return {
      patches,
      keys,
      get: () => settings,
      update: async (p) => {
        patches.push(p);
        return settings;
      },
      setKey: async (name, value) => {
        keys.push([name, value]);
        return settings;
      },
    };
  };

  it("accepts a model choice, and the old mode name", async () => {
    const h = handler();
    const { authed } = setup({ settings: h });
    const res = await authed("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({
        assessment: { mode: "anthropic", model: { provider: "ollama", id: "llama3.1:8b" } },
      }),
    });
    expect(res.status).toBe(200);
    expect(h.patches).toEqual([
      { assessment: { mode: "server", model: { provider: "ollama", id: "llama3.1:8b" } } },
    ]);
    const bad = await authed("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ assessment: { model: { provider: "openai-compatible", id: "x" } } }),
    });
    expect(bad.status).toBe(400);
  });

  it("lists local model runtimes where the server offers it", async () => {
    const h = {
      ...handler(),
      detectModels: async () => [
        { provider: "ollama" as const, baseUrl: "http://127.0.0.1:11434", models: ["llama3.1:8b"] },
      ],
    };
    const { authed } = setup({ settings: h });
    expect(await (await authed("/api/models/local")).json()).toEqual({
      runtimes: [
        { provider: "ollama", baseUrl: "http://127.0.0.1:11434", models: ["llama3.1:8b"] },
      ],
    });
    const { authed: none } = setup({ settings: handler() });
    expect((await none("/api/models/local")).status).toBe(404);
  });

  it("saves and removes keys, and never returns them", async () => {
    const h = handler();
    const { authed } = setup({ settings: h });
    const put = await authed("/api/keys/ANTHROPIC_API_KEY", {
      method: "PUT",
      body: JSON.stringify({ value: "  sk-ant-abc123  " }),
    });
    expect(put.status).toBe(200);
    expect(await put.text()).not.toContain("sk-ant-abc123");
    expect((await authed("/api/keys/ANTHROPIC_API_KEY", { method: "DELETE" })).status).toBe(200);
    expect(h.keys).toEqual([
      ["ANTHROPIC_API_KEY", "sk-ant-abc123"],
      ["ANTHROPIC_API_KEY", null],
    ]);
  });

  it.each([
    ["an unknown key", "/api/keys/AWS_SECRET_ACCESS_KEY", { value: "abcdef" }, 404],
    ["a key with spaces", "/api/keys/PORKBUN_API_KEY", { value: "pk1 abc def" }, 400],
    ["an extra field", "/api/keys/PORKBUN_API_KEY", { value: "pk1_abc", also: 1 }, 400],
  ])("refuses %s", async (_l, path, body, status) => {
    const { authed } = setup({ settings: handler() });
    const res = await authed(path, { method: "PUT", body: JSON.stringify(body) });
    expect(res.status).toBe(status);
  });

  it("explains when keys come from the environment", async () => {
    const h = handler();
    delete (h as { setKey?: unknown }).setKey;
    const { authed } = setup({ settings: h });
    const res = await authed("/api/keys/ANTHROPIC_API_KEY", {
      method: "PUT",
      body: JSON.stringify({ value: "sk-ant-abc123" }),
    });
    expect(await res.json()).toMatchObject({ error: { code: "keys_from_environment" } });
  });

  it("reads and patches non-secret settings", async () => {
    const h = handler();
    const { authed } = setup({ settings: h });
    expect(await (await authed("/api/settings")).json()).toMatchObject({
      settings,
      version: "0.0.0-test",
    });
    const res = await authed("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({
        providers: { godaddy: { enabled: false } },
        previews: { mode: "off" },
      }),
    });
    expect(res.status).toBe(200);
    expect(h.patches).toEqual([
      { providers: { godaddy: { enabled: false } }, previews: { mode: "off" } },
    ]);
  });

  it.each([
    { anthropicApiKey: "sk-ant-x" },
    { assessment: { apiKey: "sk-ant-x" } },
    { providers: { rdap: { enabled: false } } },
  ])("refuses to change %j", async (patch) => {
    const h = handler();
    const { authed } = setup({ settings: h });
    const res = await authed("/api/settings", { method: "PATCH", body: JSON.stringify(patch) });
    expect(res.status).toBe(400);
    expect(h.patches).toEqual([]);
  });
});

describe("/mcp (stateless Streamable HTTP)", () => {
  it("serves the tools to the SDK client", async () => {
    const { app } = setup();
    const transport = new StreamableHTTPClientTransport(new URL(`http://${HOST}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
      fetch: async (input, init) => await app.request(new Request(input, init)),
    });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "assess_market_conflicts",
      "check_domains",
      "generate_variants",
      "inspect_domain",
    ]);
    const res = await client.callTool({
      name: "check_domains",
      arguments: { names: ["acme"], tlds: ["com"] },
    });
    expect(res.structuredContent).toMatchObject({
      results: [{ domain: "acme.com", availability: "registered" }],
    });
    expect(transport.sessionId).toBeUndefined();
    await client.close();
  });
});

describe("the UI", () => {
  it("serves a placeholder when no UI is built", async () => {
    const { req } = setup();
    expect(await (await req("/")).text()).toMatch(/web UI isn't built/);
  });

  it("serves built assets and falls back to index.html for routes", async () => {
    const files: Record<string, { body: string; contentType: string }> = {
      "/index.html": {
        body: "<!doctype html><title>Titlesearch</title>",
        contentType: "text/html; charset=utf-8",
      },
      "/assets/app-1a2b.js": { body: "console.log(1)", contentType: "text/javascript" },
    };
    const { req } = setup({ ui: (p) => files[p] });
    const js = await req("/assets/app-1a2b.js");
    expect(js.headers.get("cache-control")).toContain("immutable");
    expect(await (await req("/results")).text()).toContain("<title>Titlesearch</title>");
    expect((await req("/assets/missing.js")).status).toBe(404);
  });
});
