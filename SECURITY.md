# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through [GitHub Security Advisories](../../security/advisories/new) on this repository. Don't open a public issue, pull request, or discussion for a security problem.

Include what you found, how to reproduce it, and which forms are affected (CLI, local web app, desktop, or a deployed instance). We'll acknowledge the report, keep you updated while we work on a fix, and credit you in the advisory unless you ask us not to.

## Supported versions

Only the latest release receives security fixes.

## Threat model

Titlesearch fetches pages from hosts that users name, passes third-party text toward language models, and talks to upstream registrar APIs. These are the threats it's built around, and the controls that address each one. The controls are the invariants in `CLAUDE.md`; changes that weaken them won't be accepted.

### Server-side request forgery (SSRF)

**Threat.** A user, or a model acting for one, supplies a domain whose DNS points at an internal address (a cloud metadata endpoint such as `169.254.169.254`, a private network, or loopback), or at a public site that redirects there. A deployed instance would then fetch internal resources on the attacker's behalf.

**Controls.**
- Every request to a user-derived host goes through `safeFetch` in `packages/core`. It resolves DNS first and rejects loopback, RFC 1918, link-local, CGNAT, unique-local IPv6, IPv4-mapped IPv6, multicast, and unspecified addresses.
- Only ports 80 and 443 are allowed. Every redirect is re-validated, with a maximum of 3. Requests time out after 5 seconds, and bodies are capped at 512 KB.
- The connection is pinned to the validated IP where the runtime allows it. Where it can't be pinned, the gap is documented in `docs/decisions/`.
- A lint rule (`tools/biome-plugins/no-direct-fetch.grit`) rejects any use of the global `fetch` outside `packages/core/src/net`.
- A dedicated SSRF test suite covers every blocked range, alternate IP encodings, redirects to private addresses, DNS answers that resolve to private addresses, and non-standard ports. It runs on Node, Bun, and Workers.

### Prompt injection through site text

**Threat.** A page on a taken domain contains text written to steer a model ("ignore previous instructions and…"). Titlesearch passes page content to Claude, either as an MCP client or through the server-side classifier.

**Controls.**
- Raw HTML never leaves the extractor. Clients and models receive extracted fields only. Any page text is in a single field, `untrustedSiteText`, capped at 600 characters with control characters stripped.
- MCP tool descriptions state that `untrustedSiteText` is third-party content and must not be followed as instructions.
- The server-side classifier puts site text inside clearly delimited data blocks, and validates the model's output against a schema. Output that fails validation becomes `unassessed`, never a guessed level.
- A lint rule (`tools/biome-plugins/no-raw-site-content.grit`) rejects reading raw response bodies or emitting raw HTML outside the extraction and networking modules.

### Upstream tool misuse

**Threat.** An upstream MCP server offers tools beyond availability checks, such as purchasing, renewing, or DNS changes. A bug, a malicious tool list, or an injected instruction could lead Titlesearch to call one.

**Controls.**
- Titlesearch is read-only by construction. The provider interface has no write methods.
- The upstream-MCP client calls only tools on an explicit, non-empty, per-provider allowlist. Any other tool name is refused before a request is made.
- Response mappings are code modules registered by ID, never user-supplied expressions.
- Upstreams that expose account-changing or purchasing tools (for example, Porkbun's hosted MCP) aren't used.
- A lint rule (`tools/biome-plugins/no-write-operations.grit`) flags identifiers and strings that name registration, transfer, purchase, or DNS-modification operations.

### The site-preview browser

**Threat.** Previews run a real browser on pages from domains users name, executing third-party JavaScript. A page could try to reach internal addresses itself (subresources, redirects, DNS rebinding, WebRTC), exploit the browser, or read credentials and cached data.

**Controls.**
- **All browser traffic goes through an egress proxy.** The proxy applies `safeFetch`'s address rules after DNS resolution and connects to the address it checked. Chromium flags leave no other path: loopback isn't bypassed, Chromium resolves no names itself, QUIC is off, and WebRTC can't use unproxied UDP.
- **Each capture is fresh.** It gets a new browser context: no profile, cookies, or credentials. Downloads and permission prompts are denied; service workers, WebRTC, geolocation, and notifications are removed; only http(s) navigations are allowed.
- **Deployed renderers stand alone.** In the container targets, the renderer is its own service, with an identity that has no permissions and no access to the cache. The API treats it as untrusted: every image must be a WebP of the expected size, and it's re-hashed before being stored.
- **The UI never loads a third-party site.** There are no iframes and no hotlinked images. Previews are served from Titlesearch's own origin, with `nosniff` and a restrictive CSP.
- **Tests.** An isolation suite drives a real browser against pages that load private subresources, redirect to metadata endpoints, use DNS rebinding, trigger downloads, and request permissions. Every one must be blocked.
- **Known gap: Cloudflare Browser Rendering.** On Workers it can't be routed through the proxy. Requests are checked before they're sent, but DNS rebinding between that check and Chromium's own lookup isn't caught. `docs/decisions/0021-workers-deploy.md` lists what holds, and the setup guide offers the container renderer for full control.

### Deployed authentication

- A deployed server is an OAuth resource server: it validates the deployer's identity-provider tokens (issuer, audience, signature, asymmetric algorithms only). It never issues its own, except on Workers, where `workers-oauth-provider` is the authorization server.
- An explicit allowlist (subjects, verified emails or domains, a scope, or a role) decides who gets in. A server configured without one refuses to start.
- Browser sessions are signed `__Host-` cookies (`HttpOnly`, `Secure`, `SameSite=Strict`), and sign-in uses PKCE, `state`, and `nonce`. Only the configured host and origin are answered.

### Supply chain

- GitHub Actions and container base images are pinned by digest.
- Release binaries ship with CycloneDX SBOMs, `SHA256SUMS`, and build-provenance attestations. Container images carry SBOM and provenance attestations, and the npm package is published with provenance through trusted publishing, with no stored token.
- The pinned Chromium download is verified against a SHA-256 in the repository before use.

### Local surfaces and secrets

- The local server binds to `127.0.0.1` only, requires a per-install bearer token, and checks the `Origin` header to block DNS rebinding.
- The desktop app keeps the local token in the OS keychain, and its webview signs in with a one-time code passed outside any URL.
- Registrar keys and the Anthropic API key come from the platform secret store, the OS keychain, or environment variables. They're never written to code, images, logs, or URLs, and they're redacted from log lines and error messages.
