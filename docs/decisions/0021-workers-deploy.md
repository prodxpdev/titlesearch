# 21. Workers target: OAuth provider, D1, and Browser Rendering

- Status: accepted (not yet deployed to a live Cloudflare account)
- Date: 2026-10-01

## Context

`CLAUDE.md` asks for a Workers build of the same Hono app, with D1 for the cache, Cloudflare Browser Rendering for previews, and `workers-oauth-provider` for OAuth. It also asks us to confirm Browser Rendering's limits and pricing, and whether its traffic can be forced through an egress proxy, and to record which invariant 8 protections hold if it can't.

## Decision

- **One Worker** (`deploy/workers`), built from `@titlesearch/deploy` like the container, with the same settings table (ADR 20). Workers bindings and secrets are read as the environment.
- **Authorization.** `@cloudflare/workers-oauth-provider` 1.2 in its single-Worker form. The Worker is the authorization server and the `/mcp` resource:
  - It supports dynamic client registration and Client ID Metadata Documents (which need the `global_fetch_strictly_public` flag).
  - The scope is `titlesearch`.
  - `/authorize` shows our consent page, built with the library's consent helpers. Every client-supplied string is escaped, and framing is forbidden.
  - Only after consent does it hand the user to the deployer's identity provider, using the library's upstream helpers. The same code as the container targets redeems the code and applies the allowlist (`OidcAuth.redeemCode`, ADR 19).
  - A refused user goes back to the client with `access_denied`.
  - The provider publishes the resource and authorization-server metadata. The browser UI keeps the OIDC session cookie.
- **Cache:** D1 (ADR 18), with the schema also shipped as a Wrangler migration.
- **WebAssembly:** the image codecs are imported as `.wasm` modules, which Wrangler compiles at deploy time. Workers can't compile WebAssembly from bytes at run time.
- **UI:** embedded in the script by `scripts/embed-ui.mjs`. The bundle is about 4.8 MB, 1.5 MB gzipped, under the free plan's 3 MB limit.
- **WHOIS:** `connect()` from `cloudflare:sockets` (ADR 8). Workers documents outbound TCP sockets as allowed, including port 43. This isn't yet verified on a live account.
- **Tests:** the Worker runs in workerd from `wrangler.jsonc`, and Miniflare's outbound hook answers as a fake identity provider. The test covers discovery, registration, consent (including escaping), identity-provider sign-in, the allowlist, the PKCE token exchange, and an MCP `initialize` with the issued token. CI also bundles the Worker with `wrangler deploy --dry-run`.

## Browser Rendering and invariant 8

Confirmed from Cloudflare's documentation on 2026-10-01 (Browser Rendering is now named Browser Run):

- **Limits.**
  - Free plan: 10 minutes of browser time a day, 3 concurrent browsers, a new browser every 20 seconds.
  - Paid plan: 200 concurrent browsers and 3 new browsers a second; browser hours are billed.
  - Idle browsers close after 60 seconds, or up to 10 minutes with `keep_alive`.
- **No egress proxy is possible.** `puppeteer.launch(env.BROWSER)` takes only `keep_alive`, not Chromium flags. The browser runs on Cloudflare's network and resolves names itself.

So on Workers:

| Protection | Status |
|---|---|
| No credentials, cache, or secrets in the browser | Holds: it's a remote service, and each capture launches a fresh browser |
| http(s) navigations only, no downloads, no media, fonts capped, hardening script | Holds: the same page code as `local-chromium`, shared in `page-capture.ts` |
| UI never loads third-party content; images served from our origin | Holds |
| Every connection checked against the address rules | Partly. Each request is intercepted over CDP and refused unless its port is 80 or 443 and its host resolves, through our DoH resolver, only to public addresses. Chromium then resolves the name again itself, so a DNS answer that changes in between (rebinding) isn't caught. The egress proxy closes that gap by connecting to the address it checked |
| No access to cloud metadata | Not applicable: none of ours exists on Cloudflare's network |

Deployers who need the full guarantee can remove the `BROWSER` binding, so previews fall back to share images fetched through `safeFetch`. Or they can point `RENDERER_URL` at the container renderer service, which the Worker supports the same way the container does.

## Consequences

- Browser Rendering is billed to the deployer's account, and the free plan's 10 minutes a day is enough for only a few hundred captures.
- The rebinding gap is documented in the setup guide next to the `BROWSER` binding.
