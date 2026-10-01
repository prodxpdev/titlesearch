// Deployed-server auth (CLAUDE.md, HTTP API): Titlesearch is an OAuth 2.1
// resource server in front of the deployer's identity provider. It never
// issues access tokens itself; it validates them.
//
// - MCP and API clients send an access token from the IdP. It's checked
//   against the issuer, audience, and the IdP's JWKS (asymmetric algorithms
//   only). Clients find the IdP from the protected-resource metadata
//   (RFC 9728) named in the WWW-Authenticate header of a 401.
// - The browser UI signs in with the authorization-code flow and PKCE, then
//   holds a signed, HttpOnly session cookie. Nothing is stored server-side, so
//   any instance can serve any request.
// - Who may use the server is an explicit allowlist: subjects, verified email
//   addresses or domains, or a required scope. With no rule configured, the
//   server refuses to start.
//
// Every request to the IdP goes through createOriginFetch, locked to the
// issuer's origin and the endpoints its own discovery document names.
// See docs/decisions/0019-deployed-auth.md.

import { createOriginFetch, type OriginFetch, type Transport } from "@titlesearch/core";
import { createLocalJWKSet, type JSONWebKeySet, type JWTPayload, jwtVerify, SignJWT } from "jose";
import * as z from "zod";
import type { Principal, ServerAuth } from "./auth.js";

const ASYMMETRIC = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "EdDSA",
];
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const LOGIN_TTL_SECONDS = 10 * 60;
const JWKS_TTL_MS = 10 * 60 * 1000;
const JWKS_REFRESH_MIN_MS = 30 * 1000;

export const OidcAllowlist = z
  .object({
    subjects: z.array(z.string().min(1)).default([]),
    emails: z.array(z.string().email()).default([]),
    emailDomains: z.array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i)).default([]),
    /** A scope the IdP grants only to people allowed to use this server. */
    scope: z.string().min(1).optional(),
    /** An app role the IdP assigns only to permitted users, in the `roles` claim (Entra ID, for example). */
    role: z.string().min(1).optional(),
  })
  .refine(
    (a) => a.subjects.length + a.emails.length + a.emailDomains.length > 0 || !!a.scope || !!a.role,
    {
      message:
        "Give at least one allowlist rule: subjects, emails, email domains, a scope, or a role.",
    },
  );
export type OidcAllowlist = z.infer<typeof OidcAllowlist>;

export interface OidcAuthOptions {
  /** Where this server is reached, such as https://titlesearch.example.com. HTTPS only. */
  publicUrl: string;
  /** The identity provider's issuer URL. HTTPS only. */
  issuer: string;
  /** More Host values to accept, such as a Lambda function URL's host behind CloudFront. */
  extraHosts?: readonly string[];
  /** The `aud` access tokens must carry. Defaults to the MCP resource URL, `${publicUrl}/mcp`. */
  audience?: string;
  /** For browser sign-in. Without it, the UI can't sign in; tokens still work. */
  clientId?: string;
  /** Omit for a public client: PKCE alone protects the code exchange. */
  clientSecret?: string;
  /** At least 32 bytes of randomness; signs session and sign-in cookies. */
  sessionSecret: string;
  allow: z.input<typeof OidcAllowlist>;
  transport?: Transport;
  now?: () => number;
}

const Discovery = z.object({
  issuer: z.string().url(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  jwks_uri: z.string().url(),
});
type Discovery = z.infer<typeof Discovery>;

const TokenResponse = z.object({ id_token: z.string().min(1) });

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function random(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function cookieValue(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

function httpsUrl(value: string, what: string): URL {
  const u = new URL(value);
  if (u.protocol !== "https:") throw new Error(`${what} must use HTTPS.`);
  return u;
}

export class OidcAuth implements ServerAuth {
  readonly loginMethod = "oidc";
  readonly sessionCookie = { name: "__Host-ts_session", secure: true };
  static readonly LOGIN_COOKIE = "__Host-ts_login";

  readonly #public: URL;
  readonly #resource: string;
  readonly #issuer: string;
  readonly #audience: string;
  readonly #options: OidcAuthOptions;
  readonly #allow: OidcAllowlist;
  readonly #key: Uint8Array;
  readonly #now: () => number;
  readonly #issuerFetch: OriginFetch;
  #discovery: Promise<{ doc: Discovery; idpFetch: OriginFetch }> | undefined;
  #jwks: { set: ReturnType<typeof createLocalJWKSet>; at: number } | undefined;

  constructor(options: OidcAuthOptions) {
    this.#public = httpsUrl(options.publicUrl, "The public URL");
    if (this.#public.pathname !== "/" || this.#public.search)
      throw new Error("The public URL must be an origin, such as https://titlesearch.example.com.");
    this.#issuer = httpsUrl(options.issuer, "The issuer").href.replace(/\/$/, "");
    this.#resource = `${this.#public.origin}/mcp`;
    this.#audience = options.audience ?? this.#resource;
    this.#key = new TextEncoder().encode(options.sessionSecret);
    if (this.#key.byteLength < 32) throw new Error("The session secret must be at least 32 bytes.");
    this.#allow = OidcAllowlist.parse(options.allow);
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#issuerFetch = createOriginFetch({
      origins: [new URL(this.#issuer).origin],
      ...(options.transport ? { transport: options.transport } : {}),
    });
  }

  hostAllowed(host: string | undefined): boolean {
    const h = host?.toLowerCase();
    return h === this.#public.host || (!!h && (this.#options.extraHosts ?? []).includes(h));
  }

  originAllowed(origin: string | undefined): boolean {
    return origin === undefined || origin === this.#public.origin;
  }

  isAllowedOrigin(origin: string): boolean {
    return origin === this.#public.origin;
  }

  challenge(): Record<string, string> {
    return {
      "www-authenticate": `Bearer resource_metadata="${this.#public.origin}/.well-known/oauth-protected-resource/mcp"`,
    };
  }

  /** The issuer's discovery document, fetched once; its endpoints fix the other allowed origins. */
  #discover(): Promise<{ doc: Discovery; idpFetch: OriginFetch }> {
    this.#discovery ??= (async () => {
      const res = await this.#issuerFetch(`${this.#issuer}/.well-known/openid-configuration`);
      if (!res.ok) throw new Error(`The issuer's discovery document returned HTTP ${res.status}.`);
      const doc = Discovery.parse(await res.json());
      if (doc.issuer.replace(/\/$/, "") !== this.#issuer)
        throw new Error("The discovery document names a different issuer.");
      const origins = [doc.authorization_endpoint, doc.token_endpoint, doc.jwks_uri].map(
        (u) => httpsUrl(u, "An IdP endpoint").origin,
      );
      const idpFetch = createOriginFetch({
        origins: [...new Set(origins)],
        ...(this.#options.transport ? { transport: this.#options.transport } : {}),
      });
      return { doc, idpFetch };
    })().catch((err) => {
      this.#discovery = undefined;
      throw err;
    });
    return this.#discovery;
  }

  async #keys(force = false): Promise<ReturnType<typeof createLocalJWKSet>> {
    const now = this.#now();
    if (this.#jwks && !force && now - this.#jwks.at < JWKS_TTL_MS) return this.#jwks.set;
    if (this.#jwks && force && now - this.#jwks.at < JWKS_REFRESH_MIN_MS) return this.#jwks.set;
    const { doc, idpFetch } = await this.#discover();
    const res = await idpFetch(doc.jwks_uri);
    if (!res.ok) throw new Error(`The JWKS returned HTTP ${res.status}.`);
    const set = createLocalJWKSet((await res.json()) as JSONWebKeySet);
    this.#jwks = { set, at: now };
    return set;
  }

  async #verifyIdp(token: string, audience: string): Promise<JWTPayload> {
    const opts = {
      issuer: (await this.#discover()).doc.issuer,
      audience,
      algorithms: ASYMMETRIC,
      currentDate: new Date(this.#now()),
    };
    try {
      return (await jwtVerify(token, await this.#keys(), opts)).payload;
    } catch (err) {
      // A key we haven't seen may be a rotation: refetch the JWKS once, then retry.
      if ((err as { code?: string }).code !== "ERR_JWKS_NO_MATCHING_KEY") throw err;
      return (await jwtVerify(token, await this.#keys(true), opts)).payload;
    }
  }

  /** Whether the allowlist admits these claims. */
  allowed(claims: JWTPayload): boolean {
    const a = this.#allow;
    if (typeof claims.sub === "string" && a.subjects.includes(claims.sub)) return true;
    const email = typeof claims.email === "string" ? claims.email.toLowerCase() : undefined;
    if (email && claims.email_verified === true) {
      if (a.emails.some((e) => e.toLowerCase() === email)) return true;
      const domain = email.slice(email.lastIndexOf("@") + 1);
      if (a.emailDomains.some((d) => d.toLowerCase() === domain)) return true;
    }
    if (a.scope) {
      // `scope` (RFC 9068, Auth0) is a space-separated string; `scp` is an array
      // at Okta and a space-separated string at Entra ID.
      const words = (v: unknown): unknown[] =>
        typeof v === "string" ? v.split(" ") : Array.isArray(v) ? v : [];
      if ([...words(claims.scope), ...words(claims.scp)].includes(a.scope)) return true;
    }
    if (a.role && Array.isArray(claims.roles) && claims.roles.includes(a.role)) return true;
    return false;
  }

  async authenticate(
    request: Request,
    session: string | undefined,
  ): Promise<Principal | undefined> {
    const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
    if (bearer !== undefined) {
      try {
        const claims = await this.#verifyIdp(bearer, this.#audience);
        if (typeof claims.sub !== "string" || !this.allowed(claims)) return undefined;
        return { kind: "user", id: claims.sub };
      } catch {
        return undefined;
      }
    }
    if (!session) return undefined;
    try {
      const { payload } = await jwtVerify(session, this.#key, {
        algorithms: ["HS256"],
        issuer: this.#public.origin,
        audience: "titlesearch-session",
        currentDate: new Date(this.#now()),
      });
      return typeof payload.sub === "string" ? { kind: "user", id: payload.sub } : undefined;
    } catch {
      return undefined;
    }
  }

  #sign(claims: JWTPayload, audience: string, ttlSeconds: number): Promise<string> {
    const now = Math.floor(this.#now() / 1000);
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(this.#public.origin)
      .setAudience(audience)
      .setIssuedAt(now)
      .setExpirationTime(now + ttlSeconds)
      .sign(this.#key);
  }

  #cookie(name: string, value: string, maxAge: number, sameSite: "Strict" | "Lax"): string {
    return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=${sameSite}`;
  }

  routes(): ReturnType<NonNullable<ServerAuth["routes"]>> {
    const metadata = async () =>
      Response.json(
        {
          resource: this.#resource,
          authorization_servers: [this.#issuer],
          bearer_methods_supported: ["header"],
          resource_name: "Titlesearch",
        },
        { headers: { "cache-control": "public, max-age=3600" } },
      );
    return [
      { method: "GET", path: "/.well-known/oauth-protected-resource", handler: metadata },
      { method: "GET", path: "/.well-known/oauth-protected-resource/mcp", handler: metadata },
      { method: "GET", path: "/auth/login", handler: () => this.#login() },
      { method: "GET", path: "/auth/callback", handler: (r) => this.#callback(r) },
    ];
  }

  /**
   * The identity provider's authorization URL for a sign-in (code flow, PKCE
   * S256). Shared by the browser sign-in and the Workers authorization
   * server's upstream step.
   */
  async authorizationUrl(p: {
    redirectUri: string;
    state: string;
    nonce: string;
    verifier: string;
  }): Promise<string> {
    const clientId = this.#options.clientId;
    if (!clientId) throw new Error("Sign-in through the identity provider needs OIDC_CLIENT_ID.");
    const { doc } = await this.#discover();
    const challenge = b64url(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(p.verifier))),
    );
    const url = new URL(doc.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: p.redirectUri,
      scope: "openid email",
      state: p.state,
      nonce: p.nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    return url.href;
  }

  /**
   * Redeems the provider's code, verifies the identity token (issuer,
   * audience, signature, nonce), and applies the allowlist.
   */
  async redeemCode(p: {
    code: string;
    redirectUri: string;
    verifier: string;
    nonce: string;
  }): Promise<{ ok: true; subject: string } | { ok: false; status: 400 | 403; message: string }> {
    const clientId = this.#options.clientId;
    if (!clientId) return { ok: false, status: 400, message: "browser sign-in isn't configured." };
    const { doc, idpFetch } = await this.#discover();
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: p.code,
      redirect_uri: p.redirectUri,
      code_verifier: p.verifier,
      client_id: clientId,
    });
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    };
    if (this.#options.clientSecret) {
      const basic = `${encodeURIComponent(clientId)}:${encodeURIComponent(this.#options.clientSecret)}`;
      headers.authorization = `Basic ${btoa(basic)}`;
    }
    const res = await idpFetch(doc.token_endpoint, {
      method: "POST",
      headers,
      body: form.toString(),
    });
    if (!res.ok)
      return { ok: false, status: 400, message: "the identity provider didn't accept the code." };
    const tokens = TokenResponse.safeParse(await res.json().catch(() => undefined));
    if (!tokens.success)
      return {
        ok: false,
        status: 400,
        message: "the identity provider's answer failed validation.",
      };
    let claims: JWTPayload;
    try {
      claims = await this.#verifyIdp(tokens.data.id_token, clientId);
    } catch {
      return { ok: false, status: 400, message: "the identity token didn't verify." };
    }
    if (claims.nonce !== p.nonce || typeof claims.sub !== "string")
      return { ok: false, status: 400, message: "the identity token didn't match this sign-in." };
    if (!this.allowed(claims))
      return { ok: false, status: 403, message: "This account isn't allowed to use this server." };
    return { ok: true, subject: claims.sub };
  }

  async #login(): Promise<Response> {
    if (!this.#options.clientId)
      return new Response("Browser sign-in isn't configured on this server.", { status: 404 });
    const state = random();
    const nonce = random();
    const verifier = random(48);
    const login = await this.#sign(
      { state, nonce, verifier },
      "titlesearch-login",
      LOGIN_TTL_SECONDS,
    );
    const location = await this.authorizationUrl({
      redirectUri: `${this.#public.origin}/auth/callback`,
      state,
      nonce,
      verifier,
    });
    return new Response(null, {
      status: 302,
      headers: {
        location,
        // Lax: the IdP's redirect back is a cross-site top-level navigation.
        "set-cookie": this.#cookie(OidcAuth.LOGIN_COOKIE, login, LOGIN_TTL_SECONDS, "Lax"),
        "cache-control": "no-store",
      },
    });
  }

  async #callback(request: Request): Promise<Response> {
    const clear = this.#cookie(OidcAuth.LOGIN_COOKIE, "", 0, "Lax");
    const fail = (message: string, status = 400) =>
      new Response(status === 403 ? message : `Sign-in failed: ${message}`, {
        status,
        headers: { "content-type": "text/plain; charset=utf-8", "set-cookie": clear },
      });
    if (!this.#options.clientId) return fail("browser sign-in isn't configured.");
    const params = new URL(request.url).searchParams;
    if (params.get("error")) return fail("the identity provider refused.");
    const code = params.get("code");
    const state = params.get("state");
    const cookie = cookieValue(request, OidcAuth.LOGIN_COOKIE);
    if (!code || !state || !cookie) return fail("the sign-in expired. Try again.");

    let login: JWTPayload;
    try {
      login = (
        await jwtVerify(cookie, this.#key, {
          algorithms: ["HS256"],
          issuer: this.#public.origin,
          audience: "titlesearch-login",
          currentDate: new Date(this.#now()),
        })
      ).payload;
    } catch {
      return fail("the sign-in expired. Try again.");
    }
    if (
      login.state !== state ||
      typeof login.verifier !== "string" ||
      typeof login.nonce !== "string"
    )
      return fail("the sign-in didn't match. Try again.");

    const result = await this.redeemCode({
      code,
      redirectUri: `${this.#public.origin}/auth/callback`,
      verifier: login.verifier,
      nonce: login.nonce,
    });
    if (!result.ok) return fail(result.message, result.status);

    const session = await this.#sign(
      { sub: result.subject },
      "titlesearch-session",
      SESSION_TTL_SECONDS,
    );
    const out = new Headers({ location: "/", "cache-control": "no-store" });
    out.append(
      "set-cookie",
      this.#cookie(this.sessionCookie.name, session, SESSION_TTL_SECONDS, "Strict"),
    );
    out.append("set-cookie", clear);
    return new Response(null, { status: 302, headers: out });
  }
}
