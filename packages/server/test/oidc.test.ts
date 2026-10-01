// Deployed auth against a fake identity provider with real keys: access
// tokens, the allowlist, resource metadata, and the browser sign-in flow.

import { silentLogger, type Transport, unlimited } from "@titlesearch/core";
import type { TitlesearchServices } from "@titlesearch/mcp";
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { OidcAuth, type OidcAuthOptions } from "../src/oidc.js";

const PUBLIC = "https://titlesearch.example.com";
const ISSUER = "https://idp.example.com";
const JWKS_HOST = "https://keys.idp-cdn.example";
const CLIENT = "titlesearch-web";
const SECRET = "s".repeat(48);

type Keys = Awaited<ReturnType<typeof generateKeyPair>>;
let current: Keys;
let other: Keys;
let jwksServed: Keys[] = [];
let jwksFetches = 0;
let tokenHandler: (form: URLSearchParams, headers: Headers) => Promise<Response> = async () =>
  new Response("{}", { status: 500 });

beforeAll(async () => {
  current = await generateKeyPair("RS256");
  other = await generateKeyPair("RS256");
  jwksServed = [current];
});

const idp: Transport = {
  pinsAddress: false,
  async request(url, init) {
    if (url.href === `${ISSUER}/.well-known/openid-configuration`)
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${JWKS_HOST}/jwks.json`,
      });
    if (url.href === `${JWKS_HOST}/jwks.json`) {
      jwksFetches++;
      const keys = await Promise.all(
        jwksServed.map(async (k, i) => ({
          ...(await exportJWK(k.publicKey)),
          kid: `k${i}`,
          alg: "RS256",
        })),
      );
      return Response.json({ keys });
    }
    if (url.href === `${ISSUER}/token`)
      return tokenHandler(new URLSearchParams(init.body ?? ""), init.headers);
    return new Response("not found", { status: 404 });
  },
};

async function token(
  claims: JWTPayload,
  opts: { keys?: Keys; kid?: string; aud?: string; iss?: string } = {},
) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: opts.kid ?? "k0" })
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? `${PUBLIC}/mcp`)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign((opts.keys ?? current).privateKey);
}

let clock = Date.now();

function setup(
  allow: OidcAuthOptions["allow"] = { emailDomains: ["acme.dev"], subjects: ["user-1"] },
) {
  const auth = new OidcAuth({
    publicUrl: PUBLIC,
    issuer: ISSUER,
    clientId: CLIENT,
    clientSecret: "client-secret",
    sessionSecret: SECRET,
    allow,
    transport: idp,
    now: () => clock,
  });
  const services: TitlesearchServices = {
    providers: [],
    context: (signal) => ({ signal, rateLimiter: unlimited, logger: silentLogger }),
  };
  const app = createApp({ services: () => services, auth, version: "0.0.0-test" });
  const req = (path: string, headers: Record<string, string> = {}) =>
    app.request(`${PUBLIC}${path}`, { headers: { host: "titlesearch.example.com", ...headers } });
  return { app, auth, req };
}

describe("OidcAuth: access tokens", () => {
  it("admits an allowed subject's token and rejects others", async () => {
    const { req } = setup();
    const ok = await req("/api/session", {
      authorization: `Bearer ${await token({ sub: "user-1" })}`,
    });
    expect(await ok.json()).toEqual({ authenticated: true, login: "oidc" });

    const stranger = await token({ sub: "user-2" });
    expect(
      (await req("/api/providers/health", { authorization: `Bearer ${stranger}` })).status,
    ).toBe(401);
  });

  it.each([
    ["the wrong audience", () => token({ sub: "user-1" }, { aud: "https://other.example/mcp" })],
    ["the wrong issuer", () => token({ sub: "user-1" }, { iss: "https://evil.example" })],
    ["an unknown key", () => token({ sub: "user-1" }, { keys: other, kid: "k9" })],
    [
      "a symmetric signature",
      () =>
        new SignJWT({ sub: "user-1" })
          .setProtectedHeader({ alg: "HS256" })
          .setIssuer(ISSUER)
          .setAudience(`${PUBLIC}/mcp`)
          .setExpirationTime("5m")
          .sign(new TextEncoder().encode(SECRET)),
    ],
    ["garbage", async () => "not-a-jwt"],
  ])("rejects a token with %s", async (_l, make) => {
    const { req } = setup();
    const res = await req("/api/providers/health", { authorization: `Bearer ${await make()}` });
    expect(res.status).toBe(401);
  });

  it("admits verified emails in an allowed domain, not unverified ones", async () => {
    const { req } = setup();
    const verified = await token({ sub: "u9", email: "pat@acme.dev", email_verified: true });
    const unverified = await token({ sub: "u9", email: "pat@acme.dev" });
    const check = async (t: string) =>
      (
        (await (await req("/api/session", { authorization: `Bearer ${t}` })).json()) as {
          authenticated: boolean;
        }
      ).authenticated;
    expect(await check(verified)).toBe(true);
    expect(await check(unverified)).toBe(false);
  });

  it("admits a token carrying the required scope", async () => {
    const { req } = setup({ scope: "titlesearch" });
    const t = await token({ sub: "svc", scope: "openid titlesearch" });
    const res = await req("/api/session", { authorization: `Bearer ${t}` });
    expect(await res.json()).toMatchObject({ authenticated: true });
  });

  it("refetches the JWKS once when the IdP rotates keys", async () => {
    const { req } = setup();
    await req("/api/session", { authorization: `Bearer ${await token({ sub: "user-1" })}` });
    const before = jwksFetches;
    jwksServed = [current, other];
    clock += 31_000; // past the refetch throttle
    const rotated = await token({ sub: "user-1" }, { keys: other, kid: "k1" });
    const res = await req("/api/session", { authorization: `Bearer ${rotated}` });
    expect(await res.json()).toMatchObject({ authenticated: true });
    expect(jwksFetches).toBe(before + 1);
    jwksServed = [current];
  });

  it("points clients at the resource metadata on a 401", async () => {
    const { req } = setup();
    const res = await req("/mcp");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/mcp"`,
    );
    const meta = await (await req("/.well-known/oauth-protected-resource/mcp")).json();
    expect(meta).toEqual({
      resource: `${PUBLIC}/mcp`,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ["header"],
      resource_name: "Titlesearch",
    });
  });

  it("answers only to its public host", async () => {
    const { app } = setup();
    const res = await app.request(`${PUBLIC}/api/session`, { headers: { host: "evil.example" } });
    expect(res.status).toBe(403);
  });
});

describe("OidcAuth: browser sign-in", () => {
  async function signIn(
    claims: (nonce: string) => JWTPayload,
    opts: { tamperState?: boolean } = {},
  ) {
    const { req, app } = setup();
    const login = await req("/auth/login");
    expect(login.status).toBe(302);
    const location = new URL(login.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(`${ISSUER}/authorize`);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("redirect_uri")).toBe(`${PUBLIC}/auth/callback`);
    const loginCookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(login.headers.get("set-cookie")).toMatch(/HttpOnly; Secure; SameSite=Lax/);

    const challenge = location.searchParams.get("code_challenge");
    const nonce = location.searchParams.get("nonce") ?? "";
    tokenHandler = async (form, headers) => {
      // PKCE: the verifier must hash to the challenge sent at the start.
      const digest = new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(form.get("code_verifier") ?? ""),
        ),
      );
      const b64 = btoa(String.fromCharCode(...digest))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      if (b64 !== challenge || form.get("code") !== "the-code")
        return new Response("{}", { status: 400 });
      if (!headers.get("authorization")?.startsWith("Basic "))
        return new Response("{}", { status: 401 });
      return Response.json({ id_token: await token(claims(nonce), { aud: CLIENT }) });
    };
    const state = opts.tamperState ? "forged" : location.searchParams.get("state");
    const callback = await app.request(`${PUBLIC}/auth/callback?code=the-code&state=${state}`, {
      headers: { host: "titlesearch.example.com", cookie: loginCookie },
    });
    return { callback, req };
  }

  it("signs in with PKCE and holds a session cookie", async () => {
    const { callback, req } = await signIn((nonce) => ({
      sub: "u7",
      email: "pat@acme.dev",
      email_verified: true,
      nonce,
    }));
    expect(callback.status).toBe(302);
    const cookies = callback.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith("__Host-ts_session="));
    expect(session).toMatch(/HttpOnly; Secure; SameSite=Strict/);
    const res = await req("/api/session", { cookie: session?.split(";")[0] ?? "" });
    expect(await res.json()).toEqual({ authenticated: true, login: "oidc" });
  });

  it("refuses an account outside the allowlist", async () => {
    const { callback } = await signIn((nonce) => ({
      sub: "x",
      email: "x@other.dev",
      email_verified: true,
      nonce,
    }));
    expect(callback.status).toBe(403);
    expect(callback.headers.getSetCookie().some((c) => c.startsWith("__Host-ts_session="))).toBe(
      false,
    );
  });

  it("refuses a mismatched state or nonce", async () => {
    const forged = await signIn((nonce) => ({ sub: "user-1", nonce }), { tamperState: true });
    expect(forged.callback.status).toBe(400);
    const replay = await signIn(() => ({ sub: "user-1", nonce: "someone-elses" }));
    expect(replay.callback.status).toBe(400);
  });

  it("rejects a forged session cookie", async () => {
    const { req } = setup();
    const forged = await new SignJWT({ sub: "user-1" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(PUBLIC)
      .setAudience("titlesearch-session")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("x".repeat(48)));
    const res = await req("/api/session", { cookie: `__Host-ts_session=${forged}` });
    expect(await res.json()).toMatchObject({ authenticated: false });
  });
});

describe("OidcAuth: configuration", () => {
  const base = {
    publicUrl: PUBLIC,
    issuer: ISSUER,
    sessionSecret: SECRET,
    allow: { subjects: ["a"] },
  };
  it.each([
    ["no allowlist rule", { ...base, allow: {} }],
    ["an HTTP public URL", { ...base, publicUrl: "http://titlesearch.example.com" }],
    ["an HTTP issuer", { ...base, issuer: "http://idp.example.com" }],
    ["a short session secret", { ...base, sessionSecret: "short" }],
    ["a public URL with a path", { ...base, publicUrl: `${PUBLIC}/app` }],
  ])("refuses %s", (_l, options) => {
    expect(() => new OidcAuth(options as OidcAuthOptions)).toThrow();
  });
});
