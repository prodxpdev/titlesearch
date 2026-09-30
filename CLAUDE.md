# Titlesearch

Titlesearch checks whether a name is free across domain extensions and reports who already occupies the taken ones, and whether they compete with the product being named. It runs as a CLI, a local web app, a native desktop app (macOS, Windows, Linux), and a self-hosted service on GCP Cloud Run, Cloudflare Workers, or AWS. Every form exposes the same MCP server so Claude can check and suggest names.

The reference UI is `docs/design/titlesearch-mockups.html`. Match its screens, copy, and status vocabulary.

License: Apache-2.0. Copyright holder: ProdXP LLC. Contributions use the DCO (`Signed-off-by`), not a CLA.

---

## Invariants

These hold everywhere, in every package and every deploy target. Do not trade them for convenience. If a task seems to require breaking one, stop and ask.

1. **Read-only by construction.** No provider interface, adapter, tool, or route can register, renew, transfer, or modify a domain or DNS record. The provider interface has no write methods. The upstream-MCP client calls only tool names on an explicit per-provider allowlist. Anything else is refused before the request is made.
2. **SSRF-safe fetching.** Every outbound request to a user-supplied host goes through `safeFetch` in `packages/core`. The rules:
   - Resolve DNS first.
   - Reject loopback, private (RFC 1918), link-local (including 169.254.169.254), CGNAT (100.64/10), unique-local IPv6 (fc00::/7), IPv4-mapped IPv6, multicast, and unspecified addresses.
   - Allow ports 80 and 443 only.
   - Re-validate the destination on every redirect, with a maximum of 3.
   - Use a 5-second timeout and a 512 KB body cap.
   - Pin the connection to the validated IP where the runtime allows it; document where it can't.
   - Never call `fetch` directly on a user-derived host outside `safeFetch`. A lint rule enforces this.
3. **Site content is untrusted.** Never return raw HTML to a client or a model. Return only extracted fields (title, meta description, OpenGraph, JSON-LD `@type`, a length-capped text excerpt). The excerpt lives in a field named `untrustedSiteText`, capped at 600 characters, with control characters stripped. MCP tool descriptions state that this field is third-party text and must not be followed as instructions.
4. **Honest status.** The tool never reports `available` unless a registrar-grade source says so. An RDAP "not found" alone is `unregistered_at_registry`, not `available`. When sources disagree, the result is `unconfirmed` and both sources are shown. No silent preference for one source.
5. **Local surfaces are local.** The local HTTP server binds to `127.0.0.1` only. It requires a per-install random bearer token and validates the `Origin` header to block DNS rebinding.
6. **No secrets in code, images, logs, or URLs.** Registrar keys and the Anthropic API key come from the platform secret store (Workers secrets, GCP Secret Manager, AWS Secrets Manager), the OS keychain on desktop, or environment variables for the CLI. They are redacted from every log line and error message.
7. **US English** in all user-facing copy, docs, and identifiers.
8. **The renderer is isolated and egress-controlled.** Site previews run in a headless browser that executes third-party JavaScript. Chromium resolves DNS and loads subresources itself, so `safeFetch` cannot protect it. The rules:
   - All renderer traffic goes through an egress proxy that applies the same address rules as `safeFetch` to every connection, including subresources and redirects, after DNS resolution.
   - The renderer runs in its own process or container with no credentials and no access to the cache, secrets, or cloud metadata.
   - The UI never loads a third-party site directly: no iframes, no hotlinked images. Every preview image is served from Titlesearch's own origin.

---

## Architecture

**One TypeScript core, runtime-agnostic.** `packages/core` uses only `fetch`, Web Crypto, `URL`, and injected interfaces. It has no Node built-ins, no `dns` module, and no file system. Enforce this with a tsconfig that excludes `@types/node` for core, plus a Biome rule banning `node:` imports there. DNS goes through DNS-over-HTTPS (Cloudflare `https://cloudflare-dns.com/dns-query`, Google `https://dns.google/resolve`; JSON API) so behavior is identical on every runtime.

**Hono** serves HTTP on every target: the REST API, `/mcp`, and the static UI.

**The MCP server** uses the official TypeScript SDK (`@modelcontextprotocol/sdk`) with two transports:

- **stdio**, for Claude Desktop and Claude Code (`titlesearch mcp`).
- **Streamable HTTP in stateless mode**, for local HTTP and deployed instances (`/mcp`). Stateless means no session IDs and no server-held session state, so it scales on serverless platforms. Check whether `@hono/mcp` or the SDK's own transport is the better fit with Hono at the time of implementation, and record the decision in `docs/decisions/`.

**One binary with three modes.** `bun build --compile` produces `titlesearch` with these subcommands:

- `titlesearch serve`: the local UI and API on `127.0.0.1:4717`.
- `titlesearch mcp`: the stdio MCP server.
- `titlesearch check <names…> --market "<text>" --tlds com,io`: CLI output as a table or `--json`.

**The desktop app is a thin Tauri 2 shell.** It runs the compiled binary as a sidecar (`bundle.externalBin`) in `serve` mode and loads the UI in a webview. It adds no second implementation of any logic. Desktop-only concerns are the tray, auto-start, keychain storage through the Tauri keyring plugin, and auto-update.

**One container for Cloud Run and AWS.** The same image runs on Cloud Run, and on AWS Lambda through the AWS Lambda Web Adapter layer (`public.ecr.aws/awsguru/aws-lambda-adapter`). ECS/Fargate should also work unchanged. Workers gets its own build of the same Hono app.

### Repo layout

```
packages/
  core/        domain model, reconciliation, safeFetch, presence probe, parking detection,
               variant generation, evidence assembly. No runtime deps beyond zod.
  providers/   rdap, godaddy-mcp, porkbun, namecom, upstream-mcp (generic), doh
  cache/       CacheStore interface + sqlite, d1, firestore, dynamodb, memory
  assess/      ConflictClassifier interface + anthropic implementation
  render/      PreviewRenderer interface, local-chromium, cloudflare-browser-rendering,
               egress proxy, image encoding
  mcp/         tool and prompt definitions over core (transport-agnostic)
  server/      Hono app: REST routes, /mcp, auth middleware, static UI hosting
apps/
  web/         Vite + React UI (matches docs/design/titlesearch-mockups.html)
  cli/         bun entry: serve | mcp | check
  desktop/     Tauri 2 shell
deploy/
  container/   Dockerfile (Cloud Run + Lambda Web Adapter)
  workers/     wrangler.toml + worker entry
  terraform/   optional modules for Cloud Run and Lambda
docs/
  design/      titlesearch-mockups.html
  decisions/   ADRs, one per non-obvious choice
fixtures/      recorded provider responses and site pages for tests
```

Tooling: pnpm workspaces, Turborepo, TypeScript `strict` with `noUncheckedIndexedAccess`, ESM only, Biome for lint and format, Vitest, Playwright for UI end-to-end tests, and Changesets for versioning. Zod validates every external boundary: provider responses, MCP tool input, REST input, and config.

---

## Domain model

```ts
type Availability =
  | "available"                 // a registrar confirmed it can be registered; price only if a price source answered
  | "premium"                   // a price source reported a registry premium price
  | "registered"                // registry says registered
  | "unregistered_at_registry"  // RDAP not found, no registrar consulted
  | "unconfirmed"               // sources disagree
  | "error";                    // no source answered

type Occupancy =
  | "competitor" | "possible_overlap" | "unrelated"   // from assessment
  | "parked" | "for_sale" | "no_site"                  // deterministic
  | "unassessed";                                      // site found, no classifier run

interface SourceResult {
  source: "rdap" | string;      // provider id
  availability: Availability;
  price?: { amount: number; currency: string; period: "first_year" };
  raw?: { registrar?: string; created?: string };
  checkedAt: string;            // ISO 8601
  latencyMs: number;
  error?: { code: string; message: string };
}

interface DomainResult {
  domain: string;               // punycode-normalized, lowercase
  availability: Availability;
  sources: SourceResult[];      // every source consulted, always returned
  presence?: PresenceEvidence;  // only when registered
  occupancy?: Occupancy;
  assessment?: Assessment;      // only when a classifier ran
}
```

`PresenceEvidence` contains the DNS summary (A/AAAA/NS/MX presence, NS hostnames), the HTTP chain (URL and status per hop), TLS validity, extracted page fields, `untrustedSiteText`, and a `parkingSignals` list naming which signatures matched.

`Assessment` contains a `level` (`competitor | possible_overlap | none`), 2 to 4 plain-language `reasons`, the `assessedBy` identifier, and the `market` text it was compared against.

### Reconciliation rules

Implement these in `core/reconcile.ts` as a pure function with a table-driven test.

| RDAP | Registrar | Result |
|---|---|---|
| not found | available | `available` |
| not found | premium | `premium` |
| not found | not available | `unconfirmed` (reserved, blocked, or registered in the last few minutes) |
| registered | not available | `registered` |
| registered | available | `unconfirmed` (possibly pending delete) |
| not found | none configured | `unregistered_at_registry` |
| registered | none configured | `registered` |
| error | any answer | the registrar's answer, with the RDAP error kept in `sources` |
| error | error or none | `error` |

When several registrars are configured and they disagree with each other, the result is `unconfirmed`, and every price is reported.

---

## Providers

```ts
interface AvailabilityProvider {
  id: string;
  supports(tld: string): boolean;
  check(domains: string[], ctx: ProviderContext): Promise<SourceResult[]>;
}
```

There are no other methods. `ProviderContext` carries the abort signal, a rate limiter, and a logger with redaction.

**RDAP (built in, always on).**
- Load the IANA bootstrap file from `https://data.iana.org/rdap/dns.json` and cache it for 24 hours.
- Rate-limit each RDAP base URL with its own token bucket, because Verisign and others throttle, and a burst from a shared egress IP gets everyone 429s.
- Treat 404 as not found and 200 as registered. Retry 429 and 5xx with jittered backoff, a maximum of 2 retries, honoring `Retry-After`.
- Where a TLD has no RDAP service, fall back to WHOIS over TCP port 43. On Workers that means `connect()` from `cloudflare:sockets`; confirm port 43 egress is permitted on each target and document it. Parse WHOIS conservatively: when unsure, report `error`, never a guess.

**GoDaddy (default availability source).** GoDaddy's public MCP server lives at `https://api.godaddy.com/v1/domains/mcp` (streamable HTTP, no auth, read-only, rate-limited). It confirms availability but returns no prices, so it is never labeled as a price source.
- Implement it as a configuration of the generic upstream-MCP provider, not as bespoke code.
- **Do not guess tool names or schemas.** Connect, call `tools/list`, and record the real tool definitions and a set of real responses into `fixtures/godaddy/`. Write the Zod schemas and the response mapping from those recordings.
- If a response fails validation, return `error` for that domain. Never coerce it.
- Add a nightly CI job (`contract-canary`) that calls the live endpoint with a fixed set of domains, validates the responses, and opens a GitHub issue on schema drift.
- Its responses were designed to drive client-side widgets. Map availability only. If a future response carries prices, add them behind a fixture-backed schema change, not speculatively.

**Generic upstream-MCP provider.** Config shape:

```ts
{ id, url, transport: "streamable-http", auth?: { type: "bearer", secretRef },
  allowedTools: string[],                 // required, non-empty
  checkTool: string,                      // must be in allowedTools
  mapping: string }                       // id of a registered mapping module
```

- Mappings are code modules registered by id, never user-supplied expressions.
- The client refuses any call to a tool not in `allowedTools`.
- **Do not use Porkbun's hosted MCP as an upstream.** It exposes account-changing and purchasing tools.

**Porkbun and Name.com (price sources).** Prices and premium status come only from these. Use their REST APIs with API keys, implemented as direct adapters. Porkbun is the default price source. When no price source is configured or none answers, the UI shows "No price from this source", never a blank or an estimate. Keys come from the secret store. Documentation should recommend keys scoped without purchase permission where the registrar supports that.

---

## Presence probe and parking detection

For every domain whose result is `registered`:

1. **DNS over DoH.** Query A, AAAA, NS, and MX. No A or AAAA records means `no_site`, and the probe stops.
2. **`safeFetch` GET** of `https://<domain>/`, falling back to `http://` if that fails. Record the chain.
3. **Extract** `<title>`, meta description, OpenGraph title and description, JSON-LD `@type` and `name`, and visible text. Strip `script`, `style`, `nav`, and `footer`, then normalize whitespace. Use a streaming HTML tokenizer that works on every runtime; `HTMLRewriter` exists only on Workers, so choose one parser that runs everywhere and record the choice in an ADR.
4. **Classify parking and for-sale pages** from `packages/core/signatures/parking.json`:
   - NS hostname suffixes of parking services
   - Lander URL patterns
   - Text patterns ("is for sale", "make an offer", "related searches", and similar)
   - Known sale-marketplace redirect hosts

   The file is versioned data. Every signature needs at least one fixture page in `fixtures/sites/` and a test. An asking price is extracted only when it appears on the page, and it's labeled as coming from the page.

A thin body (under about 200 characters of visible text) on a JS-rendered site sets `contentConfidence: "low"`. When site previews are enabled, the renderer also returns rendered-DOM text. Extraction then uses that text instead, and `contentConfidence` rises to `"high"`. The same `untrustedSiteText` rules apply to it.

---

## Site previews

Occupied domains get a screenshot. It appears as a thumbnail in the results grid, as a larger popover on hover or keyboard focus, and in a modal on click; the domain report shows it too. See the mockup for all four states.

```ts
interface PreviewRenderer {
  id: "local-chromium" | "cloudflare-browser-rendering" | string;
  capture(domain: string, ctx: RenderContext): Promise<PreviewResult>;
}

interface PreviewResult {
  thumbnail: { contentHash: string; width: 480; height: 300; format: "webp" };
  full: { contentHash: string; width: 1280; height: 800; format: "webp" };
  finalUrl: string;
  renderedText: string;          // feeds extraction, treated as untrusted
  capturedAt: string;
  renderer: string;
}
```

**Renderers.**
- **`local-chromium`** runs on the CLI, desktop, and container targets. It drives an installed Chrome or Edge through CDP using `puppeteer-core` or `playwright-core`. It must not bundle Chromium into the binary. If no browser is installed, it offers a one-time download of a pinned Chromium build to the app's data directory, verified by checksum.
- **In the container image (Cloud Run and Lambda)**, the renderer runs as a separate service or sidecar with its own egress policy, not in the API process.
- **`cloudflare-browser-rendering`** is used for the Workers target and billed to the deployer's Cloudflare account. Confirm its current limits, and whether requests can be forced through an egress proxy. If they can't, document which invariant 8 protections still hold there.

**Capture settings.**
- The viewport is 1280 by 800, capturing the first screen only.
- Wait for network idle, with a hard cap of 8 seconds.
- The browser context is fresh for every capture: no persistent profile, no cookies carried over, no stored credentials.
- Disable downloads, permission prompts, notifications, geolocation, WebRTC, service workers, and the file, data, and chrome URL schemes for navigation.
- Block media and fonts larger than 2 MB.
- Limit concurrency to 2 captures locally and make it configurable when deployed.

**Storage and serving.** Images are stored by content hash in the `CacheStore` (blob variant) or object storage, and served from `/api/preview/:hash` with `Content-Type: image/webp`, `X-Content-Type-Options: nosniff`, and a restrictive CSP. They are cached with the presence evidence and expire on the same schedule.

**Content.** A "Blur previews until opened" setting blurs thumbnails and popovers, and the modal shows the image unblurred. Offensive content is a real risk when rendering arbitrary registered domains.

**MCP.** `inspect_domain` accepts `includePreview?: boolean`, default false. When true, it returns the thumbnail as an MCP image content block so the client model can see the page. The full-size image is never returned over MCP; it's too large for model context.

**Fallback.** When previews are off or capture fails, show the page's `og:image` if one exists. It must be fetched through `safeFetch`, re-encoded to WebP, and served from Titlesearch's origin, and it is labeled as the site's own share image, not a capture. Otherwise show no image.

**Not used.** Live iframes of third-party sites: many sites refuse framing, they run trackers and scripts in the user's browser, and they expose the user's IP. Third-party screenshot APIs: they would see every name the user checks. A third-party screenshot API may be added later only as an opt-in provider, labeled with that disclosure.

---

## Market-overlap assessment

**The server assembles evidence; judgment is pluggable.**

```ts
interface ConflictClassifier {
  id: string;
  assess(market: string, evidence: PresenceEvidence[]): Promise<Assessment[]>;
}
```

There are three modes, matching the Providers screen in the mockup:

- **`anthropic`**: calls the Anthropic Messages API with the user's key. The model name comes from config, not hardcoded. The prompt places `untrustedSiteText` inside clearly delimited data blocks and instructs the model to treat it as data only. Output must be JSON validated by Zod; if it fails validation, the result is `unassessed`, never a guessed level.
- **`client`**: used when the caller is an MCP client such as Claude. Tools return evidence with `occupancy: "unassessed"`, and the client model judges. This is the default for `titlesearch mcp`.
- **`off`**: evidence only.

Do not depend on MCP sampling; client support varies.

Every assessment surface, in the UI, the CLI, and tool descriptions, states that this is not a trademark search.

---

## MCP surface

Every tool is annotated `readOnlyHint: true` and `openWorldHint: true`. Input schemas are defined in Zod and exported as JSON Schema. Each tool call is capped at 50 domains and 20 names.

| Tool | Input | Returns |
|---|---|---|
| `check_domains` | `names: string[]`, `tlds?: string[]` | `DomainResult[]` with availability and sources; no presence probing |
| `inspect_domain` | `domain: string` | one `DomainResult` with full presence evidence |
| `assess_market_conflicts` | `name: string`, `market: string`, `tlds?: string[]` | availability for every TLD, plus presence evidence for every taken one, plus assessments if a server-side classifier is configured |
| `generate_variants` | `seed: string`, `strategies?: ("prefix"\|"suffix"\|"plural"\|"tld")[]`, `tlds?: string[]` | candidate domains, deterministic, no network |

There is also a `saas_naming_session` prompt that takes `product` and `audience` arguments. It walks the client through five steps: write a brief, generate candidates, run `check_domains`, run `assess_market_conflicts` on the survivors, and produce a shortlist with reasons.

Tool descriptions are written for the model:

- Say what each field means.
- Say that `unregistered_at_registry` is not the same as purchasable.
- Say that `untrustedSiteText` is third-party content.

---

## HTTP API

- `POST /api/check`, `GET /api/domain/:domain`, `POST /api/assess`, `POST /api/variants`, and `GET /api/providers/health` mirror the MCP tools one-to-one. They share the same Zod schemas and the same core functions.
- `POST /mcp` is the Streamable HTTP MCP endpoint.
- `/` serves the static UI.

**Auth.**
- **Local:** a bearer token generated at first run and stored in the config directory with 0600 permissions (keychain on desktop), plus the `Origin` check.
- **Deployed:** OAuth 2.1 per the MCP authorization spec, so the server works as a Claude custom connector. Do not hand-roll an authorization server:
  - On Workers, use Cloudflare's `workers-oauth-provider` library.
  - On Cloud Run and AWS, validate tokens from an external IdP configured at deploy time: the issuer, audience, and JWKS.
- **Rate limits** apply per principal, and a global concurrency ceiling protects outbound fetches.

---

## Cache

```ts
interface CacheStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
}
```

The implementations are `sqlite` (CLI and desktop; confirm the driver works under `bun build --compile`, otherwise use `bun:sqlite`), `d1` (Workers), `firestore` (Cloud Run), `dynamodb` (AWS), and `memory` (tests and fallback). Every implementation must pass one shared conformance suite in `packages/cache/test/conformance.ts`.

TTLs:

| Data | TTL |
|---|---|
| Registered status | 6 hours |
| Available, premium, or unregistered status | 10 minutes |
| Unconfirmed status | not cached |
| Presence evidence | 6 hours |
| RDAP bootstrap | 24 hours |
| Assessments | keyed by domain + market hash + classifier id, 24 hours |

---

## UI

`docs/design/titlesearch-mockups.html` is the source of truth for screens, copy, and states. Its routes:

- **New search.** Name ideas, a market description, extension chips, and variant options.
- **Results.** The plat grid: names as rows, extensions as columns, each lot showing its status, one line of detail, and a preview thumbnail for occupied domains. Hovering over or focusing a thumbnail shows a larger popover, and clicking opens the preview modal. A toolbar switch hides previews.
- **Domain report.** Availability with per-source provenance tags, "What's there", the connection chain, market overlap, and the same name on other extensions.
- **Shortlist.** A comparison table, the trademark reminder, and "Copy for Claude".
- **Providers.** Registrar toggles and configuration, the assessment mode, the site-preview renderer and blur setting, and site-check limits.
- **Connect Claude.** Config snippets for Desktop, Code, and remote, plus the local server details.

Design tokens:

- **Palette:** navy band `#16233B`, survey blue `#2F5D8C`, and the status colors defined in the mockup's `:root`.
- **Type:** Schibsted Grotesk for text; IBM Plex Mono for domain strings only.
- **Dark mode:** supported through `prefers-color-scheme` and `data-theme`.

Every figure shown carries a provenance tag naming its source (RDAP, GoDaddy, Porkbun, DNS, Site, Preview, Assessment). Status labels are exactly: Available, Premium, Competitor, Possible overlap, Unrelated site, Taken, Parked, For sale, No site, Not registered, Unconfirmed, Couldn't check. They map to the model as follows: Taken is `registered` with a site found but `occupancy: "unassessed"`, shown in the neutral style with the page title. Not registered is `unregistered_at_registry`. Couldn't check is `error`. Unconfirmed is reserved for sources that disagree.

Accessibility: full keyboard navigation of the plat grid, visible focus, WCAG AA contrast in both themes, and reduced motion respected.

---

## Testing

- **Unit:** reconciliation table, variant generation, punycode normalization, parking signatures, and extraction.
- **SSRF suite:** a dedicated test file covering every blocked range, IPv6 forms, decimal and octal IP encodings, redirect to a private address, DNS answers that resolve to a private address, and non-standard ports. It must pass on the Node, Bun, and Workers (Miniflare) test runners.
- **Provider fixtures:** recorded responses for RDAP (Verisign .com, a ccTLD, a 429), GoDaddy MCP, Porkbun, and Name.com. No live network calls in unit tests.
- **Cache conformance:** all five stores.
- **MCP:** in-process client tests for every tool, including the refusal of non-allowlisted upstream tools and the 50-domain cap.
- **End-to-end:** Playwright against `titlesearch serve` with providers stubbed, covering every mockup route.
- **Renderer isolation:** fixture sites that load subresources from private addresses, redirect to metadata endpoints, use DNS rebinding, trigger downloads, and request permissions. Every one must be blocked at the egress proxy, and the capture must still complete or fail cleanly.
- **Contract canary:** nightly, live, for GoDaddy MCP and the RDAP bootstrap. Failures open issues; they never block PRs.

---

## CI, releases, supply chain

- **GitHub Actions** pinned by commit SHA, running lint, typecheck, unit, SSRF, and e2e tests on Node LTS, Bun, and Miniflare.
- **CodeQL and Renovate.** Renovate groups minor updates weekly.
- **npm** publishing uses trusted publishing with provenance.
- **Release binaries** for macOS (arm64, x64), Windows (x64), and Linux (x64, arm64), each shipped with an SBOM (CycloneDX) and checksums. macOS builds are signed and notarized; Windows builds are signed.
- **Container images** go to GHCR with a signed SBOM and build provenance attestation.
- **Registry publication:** `server.json` for the official MCP Registry, updated on each release.
- **Repo files:** `SECURITY.md` (private disclosure via GitHub Security Advisories, plus the threat model covering SSRF, prompt injection through site text, and upstream tool allowlisting), `CONTRIBUTING.md` (DCO, fixture requirements for new parking signatures), `CODE_OF_CONDUCT.md`, and `LICENSE` (Apache-2.0) with a `NOTICE` file.

---

## Build order

This is dependency order, not a release schedule. The finished product includes all of it.

1. Workspace skeleton, tooling, CI, and the lint rules for invariants 1 to 3.
2. `core`: the domain model, reconciliation, `safeFetch` with the full SSRF suite, and DoH.
3. `providers/rdap` with bootstrap and rate limiting, then the upstream-MCP client with allowlisting, then the GoDaddy configuration built from recorded fixtures.
4. `cache` interface, the memory and sqlite stores, and the conformance suite.
5. `mcp` tools, then `apps/cli` with `mcp` and `check`. At this point Claude Desktop works end to end.
6. Presence probe, extraction, parking signatures, and the evidence bundle.
7. `assess` with the anthropic classifier and client mode.
8. `render`: the egress proxy and its isolation test suite first, then `local-chromium`, image storage, and the `/api/preview` route.
9. `server` (Hono): REST routes, `/mcp`, local auth, then `apps/web` built to the mockup, then `serve` mode.
10. The Porkbun adapter (the default price source), then Name.com.
11. Deploy targets: the container for Cloud Run and Lambda, and Workers with D1, each with an OAuth setup guide.
12. The Tauri desktop shell, signing, notarization, and auto-update.
13. The registry `server.json`, README with a demo GIF, and the docs site.

---

## Definition of done for any change

- The invariants still hold, and the lint rules that enforce them pass.
- New external responses are validated by Zod and covered by fixtures.
- User-facing strings follow the mockup's vocabulary, in sentence case and US English.
- There is an ADR in `docs/decisions/` for any choice a future contributor would otherwise have to rediscover.

---

## Verify before relying on these

These were not confirmed when this brief was written. Check each one, and record the finding in an ADR:

- GoDaddy MCP tool names, input and output schemas, and rate-limit behavior (use `tools/list`). Confirmed so far: it returns no prices.
- Porkbun's availability and pricing endpoints, what key permissions they need, and whether they flag premium names.
- GoDaddy's API Terms of Use regarding self-hosted instances calling the public MCP on behalf of their own users.
- Current `@modelcontextprotocol/sdk` APIs for the stateless Streamable HTTP server and client, and whether `@hono/mcp` is maintained.
- Cloudflare Browser Rendering limits and pricing, and whether its traffic can be routed through an egress proxy.
- Port 43 outbound availability on Workers, Cloud Run, and Lambda.
- Availability of the `titlesearch` name on npm, the GitHub org, Homebrew, and the domain; clear it with Titlesearch itself.
