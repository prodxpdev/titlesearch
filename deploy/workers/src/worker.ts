// The Titlesearch Worker: the same Hono app as every other target, with D1
// for the cache, Cloudflare Browser Rendering for previews, and
// workers-oauth-provider as the authorization server for MCP clients
// (CLAUDE.md, HTTP API). Sign-in is delegated to the deployer's identity
// provider and the same allowlist as the container targets.
// See docs/decisions/0021-workers-deploy.md and docs/setup/cloudflare-workers.md.

import puppeteer from "@cloudflare/puppeteer";
import {
  AuthorizationError,
  authorizationErrorRedirect,
  CimdFetchError,
  type OAuthHelpers,
  OAuthProvider,
} from "@cloudflare/workers-oauth-provider";
import { D1Store } from "@titlesearch/cache/d1";
import { DohResolver, type LogFields, type Logger, redactingLogger } from "@titlesearch/core";
import {
  createDeployedApp,
  type DeployEnv,
  deploySecrets,
  parseDeployEnv,
} from "@titlesearch/deploy";
import { workersWhoisConnector } from "@titlesearch/providers/whois/workers";
import { CloudflareBrowserRenderer } from "@titlesearch/render/cloudflare";
import type { OidcAuth, ServerAuth } from "@titlesearch/server";
import { consentPage, escapeHtml } from "./consent.js";
import { uiFromFiles } from "./ui.js";
import { workersWasmLoader } from "./wasm.js";

export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  BROWSER?: Fetcher;
  OAUTH_PROVIDER: OAuthHelpers;
  [key: string]: unknown;
}

const VERSION = "0.0.0";
const SCOPE = "titlesearch";

/** Requests the OAuth provider has already authenticated, with their subject. */
const verified = new WeakMap<Request, string>();

/**
 * The OIDC auth, plus MCP requests the provider verified. Browser sessions
 * use the OIDC sign-in; MCP clients use tokens this Worker issued.
 */
class WorkersAuth implements ServerAuth {
  readonly loginMethod = "oidc";
  readonly sessionCookie;
  constructor(readonly inner: OidcAuth) {
    this.sessionCookie = inner.sessionCookie;
  }
  hostAllowed(host: string | undefined) {
    return this.inner.hostAllowed(host);
  }
  originAllowed(origin: string | undefined) {
    return this.inner.originAllowed(origin);
  }
  isAllowedOrigin(origin: string) {
    return this.inner.isAllowedOrigin(origin);
  }
  async authenticate(request: Request, session: string | undefined) {
    const subject = verified.get(request);
    if (subject) return { kind: "user" as const, id: subject };
    return this.inner.authenticate(request, session);
  }
  /** Browser sign-in only: the provider publishes the OAuth metadata itself. */
  routes() {
    return this.inner.routes().filter((r) => r.path.startsWith("/auth/"));
  }
}

function jsonLogger(level: DeployEnv["LOG_LEVEL"], secrets: string[]): Logger {
  const order = ["error", "warn", "info", "debug"];
  const write = (l: string) => (message: string, fields?: LogFields) => {
    if (order.indexOf(l) > order.indexOf(level)) return;
    // biome-ignore lint/suspicious/noConsole: on Workers, console is the log channel (Workers Logs).
    console.log(
      JSON.stringify({ level: l, message, ...fields }, (_k, v) =>
        v instanceof Error ? `${v.name}: ${v.message}` : v,
      ),
    );
  };
  return redactingLogger(
    { error: write("error"), warn: write("warn"), info: write("info"), debug: write("debug") },
    secrets,
  );
}

interface Built {
  env: DeployEnv;
  auth: WorkersAuth;
  app: ReturnType<typeof createDeployedApp>;
  provider: OAuthProvider<Env>;
}
let built: Built | undefined;

function build(bindings: Env): Built {
  if (built) return built;
  const env = parseDeployEnv(bindings);
  const logger = jsonLogger(env.LOG_LEVEL, deploySecrets(env));
  const browser = bindings.BROWSER;
  const renderer = browser
    ? new CloudflareBrowserRenderer({
        launch: () => puppeteer.launch(browser),
        resolver: new DohResolver(),
      })
    : undefined;
  let auth: WorkersAuth | undefined;
  const ui = uiFromFiles();
  const app = createDeployedApp(
    env,
    {
      whois: workersWhoisConnector,
      store: new D1Store(bindings.DB),
      ...(renderer ? { renderer } : {}),
      wasm: workersWasmLoader,
      logger,
    },
    {
      version: VERSION,
      ...(ui ? { ui } : {}),
      auth: (oidc) => {
        auth = new WorkersAuth(oidc);
        return auth;
      },
    },
  );
  const origin = new URL(env.PUBLIC_URL).origin;
  const provider = new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: {
      fetch(request, _env, ctx) {
        const props = (ctx as unknown as { props?: { sub?: unknown } }).props;
        if (typeof props?.sub === "string") verified.set(request, props.sub);
        return app.fetch(request);
      },
    },
    defaultHandler: {
      fetch: (request, env) => handleDefault(request, env as Env),
    },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: [SCOPE],
    requiredScopes: [SCOPE],
    resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
    clientIdMetadataDocumentEnabled: true,
  });
  built = { env, auth: auth as WorkersAuth, app, provider };
  return built;
}

const text = (body: string, status: number) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

function randomToken(bytes = 32): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

async function handleDefault(request: Request, env: Env): Promise<Response> {
  const b = build(env);
  const url = new URL(request.url);
  const oauth = env.OAUTH_PROVIDER;
  // The authorization pages answer only on the public host, like everything else.
  if (!b.auth.hostAllowed(request.headers.get("host") ?? url.host)) return text("Forbidden.", 403);
  const callback = `${new URL(b.env.PUBLIC_URL).origin}/oauth/callback`;
  try {
    if (url.pathname === "/authorize" && request.method === "GET") {
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      consent.headers.set("content-type", "text/html; charset=utf-8");
      consent.headers.set(
        "content-security-policy",
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      );
      return new Response(consentPage(details, consent.handle), { headers: consent.headers });
    }
    if (url.pathname === "/authorize" && request.method === "POST") {
      // Our own consent form's two fields, not third-party content.
      // biome-ignore lint/plugin: the consent form's body, not site content (invariant 3 doesn't apply).
      const form = await request.formData();
      const handle = String(form.get("handle") ?? "");
      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE] });
      // Consent is given; now, and only now, sign in at the identity provider.
      const verifier = randomToken(48);
      const nonce = randomToken();
      const { state, headers } = await oauth.beginUpstream(approved.request, {
        data: { verifier, nonce },
        headers: approved.headers,
      });
      headers.set(
        "location",
        await b.auth.inner.authorizationUrl({ redirectUri: callback, state, nonce, verifier }),
      );
      return new Response(null, { status: 302, headers });
    }
    if (url.pathname === "/oauth/callback" && request.method === "GET") {
      const {
        request: original,
        data,
        headers,
      } = await oauth.finishUpstream<{
        verifier: string;
        nonce: string;
      }>(request);
      const code = url.searchParams.get("code");
      if (url.searchParams.get("error") || !code) {
        headers.set("location", authorizationErrorRedirect(original, "access_denied"));
        return new Response(null, { status: 302, headers });
      }
      const result = await b.auth.inner.redeemCode({
        code,
        redirectUri: callback,
        verifier: data.verifier,
        nonce: data.nonce,
      });
      if (!result.ok) {
        if (result.status === 403) {
          headers.set(
            "location",
            authorizationErrorRedirect(original, "access_denied", "This account isn't allowed."),
          );
          return new Response(null, { status: 302, headers });
        }
        return text(`Sign-in failed: ${result.message}`, 400);
      }
      const { redirectTo } = await oauth.completeAuthorization({
        request: original,
        userId: result.subject,
        metadata: {},
        scope: original.scope,
        props: { sub: result.subject },
      });
      headers.set("location", redirectTo);
      return new Response(null, { status: 302, headers });
    }
  } catch (err) {
    if (err instanceof AuthorizationError && err.redirectTo)
      return Response.redirect(err.redirectTo, 302);
    if (err instanceof AuthorizationError)
      return text(
        `Authorization failed: ${escapeHtml(err.description)}. Start again from your app.`,
        400,
      );
    if (err instanceof CimdFetchError) return text("This app could not be verified.", 400);
    throw err;
  }
  return b.app.fetch(request);
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return build(env).provider.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
