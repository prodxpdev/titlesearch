// The Titlesearch HTTP app (Hono): REST routes that mirror the MCP tools,
// stateless Streamable HTTP MCP at /mcp, the preview image route, and the web
// UI. Runtime-agnostic: only Hono and Web APIs, so it runs on Bun, Node, and
// Workers. See docs/decisions/0015-http-server.md.

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { assessMarketConflicts, NOT_A_TRADEMARK_SEARCH } from "@titlesearch/assess";
import {
  checkDomains,
  DomainError,
  expandCandidates,
  generateVariants,
  inspectDomain,
  type Logger,
  normalizeDomain,
  RequestLimitError,
  silentLogger,
} from "@titlesearch/core";
import {
  AssessMarketConflictsInput,
  CheckDomainsInput,
  createTitlesearchMcpServer,
  GenerateVariantsInput,
  type TitlesearchServices,
} from "@titlesearch/mcp";
import { previewImageResponse } from "@titlesearch/render/preview-response";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import * as z from "zod";
import type { Principal, ServerAuth } from "./auth.js";
import { createHealthCheck } from "./health.js";
import { ConcurrencyLimit, PrincipalRateLimit } from "./limits.js";
import { SettingsError, type SettingsHandler, SettingsPatch } from "./settings.js";
import { type UiAssets, uiResponse } from "./static/ui.js";

export interface AppOptions {
  /** The current services. A function, because a settings change rebuilds them. */
  services: () => TitlesearchServices;
  auth: ServerAuth;
  version: string;
  ui?: UiAssets;
  settings?: SettingsHandler;
  /** Generates and stores a new bearer token, returning it. */
  rotateToken?: () => Promise<string>;
  logger?: Logger;
  limits?: { perMinute?: number; concurrency?: number; queued?: number };
}

type Env = { Variables: { principal: Principal } };

const PUBLIC_API = new Set(["/api/session"]);

function apiError(
  c: Context,
  status: 400 | 401 | 403 | 404 | 429 | 500 | 503,
  code: string,
  message: string,
) {
  return c.json({ error: { code, message } }, status);
}

/** Parses JSON against a Zod shape; returns the data or an error response. */
async function parseBody<T extends z.ZodRawShape>(c: Context, shape: T) {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return { error: apiError(c, 400, "invalid_json", "The request body isn't valid JSON.") };
  }
  const parsed = z.object(shape).strict().safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      error: apiError(
        c,
        400,
        "invalid_request",
        `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`,
      ),
    };
  }
  return { data: parsed.data as z.infer<z.ZodObject<T>> };
}

function inputError(err: unknown): string | undefined {
  if (err instanceof RequestLimitError || err instanceof DomainError || err instanceof RangeError)
    return err.message;
  return undefined;
}

export function createApp(options: AppOptions): Hono<Env> {
  const app = new Hono<Env>();
  const logger = options.logger ?? silentLogger;
  const rate = new PrincipalRateLimit(options.limits?.perMinute ?? 120);
  const outbound = new ConcurrencyLimit(
    options.limits?.concurrency ?? 8,
    options.limits?.queued ?? 32,
  );
  const health = createHealthCheck();
  const cookie = options.auth.sessionCookie;

  // Security headers on everything.
  app.use("*", async (c, next) => {
    await next();
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");
    c.header("x-frame-options", "DENY");
    c.header("cross-origin-opener-policy", "same-origin");
    if (c.req.path.startsWith("/api/") && !c.req.path.startsWith("/api/preview/"))
      c.header("cache-control", "no-store");
  });

  // Liveness for platform health checks, which send their own Host. Says nothing else.
  app.get("/healthz", (c) => c.json({ ok: true }));

  // Host and Origin checks on everything else, including the UI shell (invariant 5).
  app.use("*", async (c, next) => {
    if (c.req.path === "/healthz") return next();
    // HTTP/1.1 always sends Host; a Request built in-process can't, so fall back to the URL.
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    if (!options.auth.hostAllowed(host)) {
      return c.text(
        options.auth.loginMethod === "code"
          ? "Forbidden: this server only answers to 127.0.0.1 and localhost."
          : "Forbidden: unexpected Host.",
        403,
      );
    }
    if (!options.auth.originAllowed(c.req.header("origin")))
      return c.text("Forbidden: cross-origin request.", 403);
    return next();
  });

  app.use(
    "/api/*",
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) => apiError(c, 400, "too_large", "The request body is too large."),
    }),
  );

  // Routes the auth brings, such as OAuth resource metadata and browser sign-in.
  for (const r of options.auth.routes?.() ?? []) {
    app.on(r.method, r.path, (c) => r.handler(c.req.raw));
  }

  // Auth and per-principal rate limits on the API and MCP.
  const requireAuth = async (c: Context<Env>, next: () => Promise<void>) => {
    if (PUBLIC_API.has(c.req.path)) return next();
    const principal = await options.auth.authenticate(c.req.raw, getCookie(c, cookie.name));
    if (!principal) {
      for (const [k, v] of Object.entries(options.auth.challenge?.() ?? {})) c.header(k, v);
      return apiError(
        c,
        401,
        "unauthenticated",
        options.auth.loginMethod === "code"
          ? "Sign in with the code shown by `titlesearch serve`, or send the bearer token."
          : "Sign in, or send an OAuth access token.",
      );
    }
    // A cookie-authenticated change must come from our own page: Origin is required.
    if (principal.kind === "session" && c.req.method !== "GET" && c.req.method !== "HEAD") {
      const origin = c.req.header("origin");
      if (!origin || !options.auth.isAllowedOrigin(origin))
        return apiError(c, 403, "origin_required", "Missing Origin.");
    }
    const wait = rate.take(
      principal.kind === "token" ? "token" : `${principal.kind}:${principal.id}`,
    );
    if (wait > 0) {
      c.header("retry-after", String(wait));
      return apiError(c, 429, "rate_limited", "Too many requests. Try again shortly.");
    }
    c.set("principal", principal);
    return next();
  };
  app.use("/api/*", requireAuth);
  app.use("/mcp", requireAuth);

  /** Runs outbound work under the global ceiling. */
  const outboundWork = async (c: Context, fn: () => Promise<Response>): Promise<Response> => {
    const r = await outbound.run(fn);
    if (!r) {
      c.header("retry-after", "5");
      return apiError(c, 503, "busy", "The server is busy with other checks. Try again shortly.");
    }
    return r.value;
  };

  // --- Session ---
  app.get("/api/session", async (c) => {
    const principal = await options.auth.authenticate(c.req.raw, getCookie(c, cookie.name));
    return c.json({ authenticated: !!principal, login: options.auth.loginMethod });
  });
  app.post("/api/session", async (c) => {
    const exchange = options.auth.exchangeLoginCode?.bind(options.auth);
    if (!exchange)
      return apiError(c, 404, "not_found", "Sign in through your identity provider instead.");
    const body = await parseBody(c, { code: z.string().min(1).max(64) });
    if (body.error) return body.error;
    const id = exchange(body.data.code);
    if (!id)
      return apiError(
        c,
        401,
        "invalid_code",
        "That code didn't work. Codes expire after 5 minutes and work once.",
      );
    setCookie(c, cookie.name, id, {
      httpOnly: true,
      secure: cookie.secure,
      sameSite: "Strict",
      path: "/",
      maxAge: 12 * 60 * 60,
    });
    return c.json({ authenticated: true });
  });
  app.delete("/api/session", (c) => {
    const id = getCookie(c, cookie.name);
    if (id) options.auth.endSession?.(id);
    deleteCookie(c, cookie.name, { path: "/", secure: cookie.secure });
    return c.json({ authenticated: false });
  });

  // --- Tools, mirrored ---
  app.post("/api/check", async (c) => {
    const body = await parseBody(c, CheckDomainsInput);
    if (body.error) return body.error;
    let domains: string[];
    try {
      domains = expandCandidates(body.data.names, body.data.tlds);
    } catch (err) {
      const m = inputError(err);
      if (m) return apiError(c, 400, "invalid_request", m);
      throw err;
    }
    return outboundWork(c, async () => {
      const s = options.services();
      const results = await checkDomains(domains, s.context(c.req.raw.signal), {
        providers: s.providers,
        ...(s.cache ? { cache: s.cache } : {}),
      });
      return c.json({ results });
    });
  });

  app.get("/api/domain/:domain", async (c) => {
    let domain: string;
    try {
      domain = normalizeDomain(c.req.param("domain"));
    } catch (err) {
      return apiError(c, 400, "invalid_domain", (err as Error).message);
    }
    return outboundWork(c, async () => {
      const s = options.services();
      if (!s.probe) return apiError(c, 503, "unavailable", "Site inspection isn't configured.");
      const result = await inspectDomain(domain, s.context(c.req.raw.signal), {
        providers: s.providers,
        probe: s.probe,
        ...(s.cache ? { cache: s.cache } : {}),
      });
      return c.json(result);
    });
  });

  app.post("/api/assess", async (c) => {
    const body = await parseBody(c, AssessMarketConflictsInput);
    if (body.error) return body.error;
    let domains: string[];
    try {
      if (body.data.name.includes("."))
        throw new DomainError(body.data.name, "Give a name without an extension.");
      domains = expandCandidates([body.data.name], body.data.tlds);
    } catch (err) {
      const m = inputError(err);
      if (m) return apiError(c, 400, "invalid_request", m);
      throw err;
    }
    return outboundWork(c, async () => {
      const s = options.services();
      if (!s.probe) return apiError(c, 503, "unavailable", "Site inspection isn't configured.");
      const mode = s.assessment?.mode ?? "client";
      const classifier = s.assessment?.classifier;
      try {
        const assessed = await assessMarketConflicts(
          domains,
          body.data.market,
          s.context(c.req.raw.signal),
          {
            providers: s.providers,
            probe: s.probe,
            // A browser has no client model: "client" means evidence only here.
            mode: mode === "anthropic" && classifier ? "anthropic" : "off",
            ...(classifier ? { classifier } : {}),
            ...(s.cache ? { cache: s.cache } : {}),
          },
        );
        return c.json({ ...assessed, notice: NOT_A_TRADEMARK_SEARCH });
      } catch (err) {
        const m = inputError(err);
        if (m) return apiError(c, 400, "invalid_request", m);
        throw err;
      }
    });
  });

  app.post("/api/variants", async (c) => {
    const body = await parseBody(c, GenerateVariantsInput);
    if (body.error) return body.error;
    try {
      return c.json({
        candidates: generateVariants(body.data.seed, body.data.strategies, body.data.tlds),
      });
    } catch (err) {
      const m = inputError(err);
      if (m) return apiError(c, 400, "invalid_request", m);
      throw err;
    }
  });

  app.get("/api/providers/health", (c) =>
    outboundWork(c, async () => {
      const s = options.services();
      return c.json({ providers: await health(s.providers, s.context(c.req.raw.signal)) });
    }),
  );

  app.get("/api/preview/:hash", async (c) => {
    const blobs = options.services().blobs;
    if (!blobs) return apiError(c, 404, "not_found", "No preview store.");
    return previewImageResponse(blobs, c.req.param("hash"));
  });

  // --- Settings and token ---
  app.get("/api/settings", (c) => {
    if (!options.settings) return apiError(c, 404, "not_found", "Settings aren't available here.");
    return c.json({ settings: options.settings.get(), version: options.version });
  });
  app.patch("/api/settings", async (c) => {
    if (!options.settings) return apiError(c, 404, "not_found", "Settings aren't available here.");
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return apiError(c, 400, "invalid_json", "The request body isn't valid JSON.");
    }
    const patch = SettingsPatch.safeParse(json);
    if (!patch.success)
      return apiError(c, 400, "invalid_request", "That setting can't be changed here.");
    try {
      return c.json({ settings: await options.settings.update(patch.data) });
    } catch (err) {
      if (err instanceof SettingsError) return apiError(c, 400, "invalid_setting", err.message);
      throw err;
    }
  });
  app.post("/api/token/rotate", async (c) => {
    if (!options.rotateToken || !options.auth.setToken)
      return apiError(c, 404, "not_found", "Token rotation isn't available here.");
    const token = await options.rotateToken();
    options.auth.setToken(token);
    // Shown once, so the user can update other tools. Never logged.
    return c.json({ token });
  });

  // --- MCP, stateless ---
  app.all("/mcp", async (c) => {
    const server = createTitlesearchMcpServer(options.services(), options.version);
    // No sessionIdGenerator: stateless mode, with no session IDs or server-held state.
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  });

  app.all("/api/*", (c) => apiError(c, 404, "not_found", "No such API route."));

  // --- The UI ---
  app.get("*", (c) => uiResponse(options.ui, c.req.path));

  app.onError((err, c) => {
    logger.error("Request failed", { path: c.req.path, error: err });
    return apiError(c, 500, "internal", "Something went wrong.");
  });

  return app;
}
