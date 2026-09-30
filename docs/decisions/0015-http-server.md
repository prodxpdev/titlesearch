# 15. The HTTP server and `serve`

- Status: accepted
- Date: 2026-09-30

## Context

Build step 9 adds the Hono app (REST routes, `/mcp`, local auth, static UI hosting) and `titlesearch serve`. The brief asks for a decision between `@hono/mcp` and the SDK's own Streamable HTTP transport.

## Decisions

### MCP transport: the SDK's web-standard transport

`@modelcontextprotocol/sdk` 1.31 ships `WebStandardStreamableHTTPServerTransport`, which works on Web `Request` and `Response` objects and so on Bun, Node, and Workers alike. Its own docs show it mounted in Hono.

`/mcp` creates a fresh server and transport per request, with no `sessionIdGenerator` (stateless: no session IDs, no server-held state) and JSON responses. `@hono/mcp` 0.3.2 mostly adds OAuth helpers and a rate-limiter peer dependency. For deployed OAuth, the brief names `workers-oauth-provider` and external-IdP token validation instead (step 11), so `@hono/mcp` would add a dependency without adding anything the brief needs.

### One runtime-agnostic app

`packages/server` uses only Hono and Web APIs, and its whole test suite runs unchanged in workerd (no Node compatibility flag) as well as on Node and Bun. The preview-image handler moved to `@titlesearch/render/preview-response`, so the server never imports the Node-only renderer.

### Middleware, in order

1. **Security headers:** `nosniff`, `no-referrer`, `X-Frame-Options: DENY`, COOP, and `no-store` on API responses.
2. **The `Host` check:** only `127.0.0.1:<port>` or `localhost:<port>`, which blocks DNS rebinding. If a request has no `Host` header, the URL's host is used; a Request built in-process can't set one.
3. **The `Origin` check:** absent is allowed (curl, MCP clients); present must be ours; `null` never is.
4. **A 64 KB body limit** on the API.
5. **Auth** on `/api/*` (except the session endpoint) and `/mcp`: the bearer token, compared in constant time, or a session cookie. A cookie-authenticated change must also carry our `Origin`.
6. **Per-principal rate limit:** 120 requests a minute, returning 429 with `Retry-After`.
7. **Global concurrency ceiling** on routes that reach the network: 8 at a time, with 32 queued, then 503.

### Getting the browser signed in without a secret in a URL

Invariant 6 rules out a token in the URL, as in `?token=…`. Instead, `serve` prints a one-time login code: 10 characters of Crockford base32, about 50 bits. It works once, expires in 5 minutes, and dies after 5 wrong tries; pressing Enter prints a new one. The UI exchanges it at `POST /api/session` for an `HttpOnly`, `SameSite=Strict` session cookie lasting 12 hours. API and MCP clients use the bearer token instead.

### The token

The token is 32 random bytes, stored as hex in `<config dir>/local-token` with mode 0600. It's created on first run, and never printed except when it's replaced: `POST /api/token/rotate` returns the new token once so the user can update their tools. Replacing it doesn't sign out browser sessions.

### Routes

The API mirrors the MCP tools and uses the same Zod schemas and core functions:

- `POST /api/check`
- `GET /api/domain/:domain`
- `POST /api/assess`
- `POST /api/variants`
- `GET /api/providers/health`

In a browser, "client" assessment mode means evidence only, since there's no client model.

Also:

- **`GET /api/providers/health`** has each provider check `example.com` through its normal, read-only `check` method, cached for 5 minutes.
- **`GET /api/preview/:hash`** serves stored WebP previews.
- **`GET` and `PATCH /api/settings`** back the Providers screen. A patch may change only non-secret settings (GoDaddy on or off, assessment mode, preview mode), and the schema is strict, so a key in a patch is rejected. Keys come from the environment or, on desktop, the keychain. Choosing "anthropic" without a key is refused.

### The UI shell

The UI shell is served without auth, since it holds no data. HTML gets a strict CSP: same-origin only, no frames, no third-party anything. Hashed assets are cached as immutable. A compiled binary embeds `apps/web/dist` through a generated module (`scripts/embed-ui.mjs`, using Bun file imports). Without a build, `serve` shows a placeholder page.

## Verified

A compiled binary on 2026-09-30, checked with curl:

- It listened on `127.0.0.1` only, and the token file was `-rw-------`.
- A spoofed `Host` got 403, and no credentials got 401.
- The bearer token ran a live check.
- The printed code signed in and yielded a working cookie.
- MCP initialized over HTTP.
