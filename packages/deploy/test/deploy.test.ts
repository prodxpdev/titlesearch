// The deployment configuration and wiring, with a fake identity provider.
// Runs on Node, Bun, and workerd.

import { MemoryStore } from "@titlesearch/cache";
import { silentLogger, type Transport } from "@titlesearch/core";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createDeployedApp,
  createDeployedServices,
  deploySecrets,
  parseDeployEnv,
} from "../src/index.js";

const BASE = {
  PUBLIC_URL: "https://titlesearch.example.com",
  OIDC_ISSUER: "https://idp.example.com",
  SESSION_SECRET: "s".repeat(40),
  ALLOWED_EMAIL_DOMAINS: "acme.dev",
};

describe("parseDeployEnv", () => {
  it("applies defaults", () => {
    const env = parseDeployEnv(BASE);
    expect(env).toMatchObject({
      GODADDY_ENABLED: true,
      ALLOWED_EMAIL_DOMAINS: ["acme.dev"],
      ASSESSMENT_MODEL: "claude-opus-5-5",
      RATE_LIMIT_PER_MINUTE: 120,
      CONCURRENCY: 8,
    });
  });

  it.each([
    ["no allowlist", { ...BASE, ALLOWED_EMAIL_DOMAINS: "" }, "Say who may use this server"],
    ["an HTTP public URL", { ...BASE, PUBLIC_URL: "http://titlesearch.example.com" }, "https://"],
    ["half a Porkbun key pair", { ...BASE, PORKBUN_API_KEY: "pk1_x" }, "PORKBUN_SECRET_API_KEY"],
    [
      "a renderer without a token",
      { ...BASE, RENDERER_URL: "https://r.internal" },
      "RENDERER_TOKEN",
    ],
    ["a short session secret", { ...BASE, SESSION_SECRET: "short" }, "SESSION_SECRET"],
    [
      "anthropic without a key",
      { ...BASE, ASSESSMENT_MODE: "anthropic" },
      "Add an Anthropic API key",
    ],
    [
      "an OpenAI-compatible model without its URL",
      { ...BASE, ASSESSMENT_PROVIDER: "openai-compatible", ASSESSMENT_MODEL: "llama-3.3-70b" },
      "base URL",
    ],
  ])("refuses %s", (_l, env, message) => {
    expect(() => parseDeployEnv(env)).toThrow(message);
  });

  it("never puts a value in the error", () => {
    try {
      parseDeployEnv({
        ...BASE,
        SESSION_SECRET: "hunter2-leaky",
        PORKBUN_API_KEY: "pk1_secretvalue",
      });
    } catch (err) {
      expect(String(err)).not.toContain("hunter2");
      expect(String(err)).not.toContain("pk1_secretvalue");
    }
  });

  it("lists every secret for redaction", () => {
    const env = parseDeployEnv({
      ...BASE,
      PORKBUN_API_KEY: "pk1_a",
      PORKBUN_SECRET_API_KEY: "sk1_b",
      ANTHROPIC_API_KEY: "sk-ant-c",
      RENDERER_URL: "https://r.internal",
      RENDERER_TOKEN: "t".repeat(32),
    });
    expect(deploySecrets(env).sort()).toEqual(
      ["pk1_a", "sk1_b", "sk-ant-c", "s".repeat(40), "t".repeat(32)].sort(),
    );
  });
});

const rt = () => ({
  store: new MemoryStore(),
  wasm: async () => {
    throw new Error("no wasm in tests");
  },
  logger: silentLogger,
});

describe("createDeployedServices", () => {
  it("adds sources from the configuration", () => {
    const ids = (extra: Record<string, string>) =>
      createDeployedServices(parseDeployEnv({ ...BASE, ...extra }), rt()).providers.map(
        (p) => p.id,
      );
    expect(ids({})).toEqual(["rdap", "godaddy"]);
    expect(
      ids({
        GODADDY_ENABLED: "false",
        PORKBUN_API_KEY: "pk1_a",
        PORKBUN_SECRET_API_KEY: "sk1_b",
        NAMECOM_USERNAME: "me",
        NAMECOM_TOKEN: "tok",
      }),
    ).toEqual(["rdap", "porkbun", "namecom"]);
  });

  it("lets the MCP client judge unless an Anthropic key is configured", () => {
    expect(createDeployedServices(parseDeployEnv(BASE), rt()).assessment?.mode).toBe("client");
    const withKey = createDeployedServices(
      parseDeployEnv({ ...BASE, ANTHROPIC_API_KEY: "sk-ant-x" }),
      rt(),
    );
    expect(withKey.assessment?.mode).toBe("server");
    expect(withKey.assessment?.classifier?.id).toBe("anthropic:claude-opus-5-5");
  });
});

describe("open models on a deployment", () => {
  it("judges and suggests with the team's own OpenAI-compatible server", () => {
    const env = parseDeployEnv({
      ...BASE,
      ASSESSMENT_PROVIDER: "openai-compatible",
      ASSESSMENT_MODEL: "meta-llama/Llama-3.3-70B-Instruct",
      ASSESSMENT_BASE_URL: "https://vllm.internal.acme.dev/v1",
      OPENAI_COMPATIBLE_API_KEY: "vllm-token-0123456789",
    });
    const s = createDeployedServices(env, rt());
    expect(s.assessment?.mode).toBe("server");
    expect(s.assessment?.classifier?.id).toBe(
      "openai-compatible:meta-llama/Llama-3.3-70B-Instruct",
    );
    expect(s.suggester).toBeDefined();
    expect(deploySecrets(env)).toContain("vllm-token-0123456789");
  });
});

describe("createDeployedApp", () => {
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  beforeAll(async () => {
    keys = await generateKeyPair("ES256");
  });

  const idp: Transport = {
    pinsAddress: false,
    async request(url) {
      if (url.pathname === "/.well-known/openid-configuration")
        return Response.json({
          issuer: BASE.OIDC_ISSUER,
          authorization_endpoint: `${BASE.OIDC_ISSUER}/authorize`,
          token_endpoint: `${BASE.OIDC_ISSUER}/token`,
          jwks_uri: `${BASE.OIDC_ISSUER}/jwks`,
        });
      if (url.pathname === "/jwks")
        return Response.json({
          keys: [{ ...(await exportJWK(keys.publicKey)), kid: "a", alg: "ES256" }],
        });
      return new Response("no", { status: 404 });
    },
  };

  const app = () =>
    createDeployedApp(parseDeployEnv(BASE), { ...rt(), transport: idp }, { version: "1.0.0" });
  const req = (
    a: ReturnType<typeof app>,
    path: string,
    init: RequestInit & { headers?: Record<string, string> } = {},
  ) =>
    a.request(`${BASE.PUBLIC_URL}${path}`, {
      ...init,
      headers: { host: "titlesearch.example.com", ...init.headers },
    });

  it("requires OAuth on /mcp and points at the resource metadata", async () => {
    const res = await req(app(), "/mcp", { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("oauth-protected-resource/mcp");
  });

  it("shows settings read-only to a signed-in user", async () => {
    const a = app();
    const token = await new SignJWT({ sub: "u1", email: "pat@acme.dev", email_verified: true })
      .setProtectedHeader({ alg: "ES256", kid: "a" })
      .setIssuer(BASE.OIDC_ISSUER)
      .setAudience(`${BASE.PUBLIC_URL}/mcp`)
      .setExpirationTime("5m")
      .sign(keys.privateKey);
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const got = await req(a, "/api/settings", { headers });
    expect(got.status).toBe(200);
    expect(
      ((await got.json()) as { settings: { previews: { mode: string } } }).settings.previews.mode,
    ).toBe("off");
    const patch = await req(a, "/api/settings", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ previews: { mode: "off" } }),
    });
    expect(patch.status).toBe(400);
    expect(await patch.text()).toContain("deployment configuration");
  });
});
