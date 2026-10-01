# 19. Deployed auth: an OAuth resource server, not an authorization server

- Status: accepted
- Date: 2026-10-01

## Context

`CLAUDE.md` requires OAuth 2.1 per the MCP authorization spec on deployed instances, so a deployment works as a Claude custom connector. It says not to hand-roll an authorization server: Workers uses `workers-oauth-provider`, and Cloud Run and AWS validate tokens from an external identity provider (issuer, audience, JWKS). The local server keeps its token and one-time code (invariant 5).

## Decision

- **One interface, two implementations.** The Hono app takes a `ServerAuth`:
  - `LocalAuth`: unchanged behavior.
  - `OidcAuth`: for Cloud Run and AWS.

  Routes that only make sense locally, such as the code login and token rotation, answer 404 when the auth doesn't support them.
- **Access tokens (MCP and API clients).**
  - Checked with `jose` against the configured issuer and audience, using asymmetric algorithms only.
  - The audience defaults to the MCP resource URL, `https://<host>/mcp`. Deployers whose IdP can't issue resource-bound tokens can set another.
  - The JWKS is fetched by us through `createOriginFetch` (so `jose`'s own fetch isn't used). It's cached for 10 minutes and refetched at most every 30 seconds when an unknown key ID appears.
- **Discovery.** Clients find the IdP through RFC 9728 protected-resource metadata at `/.well-known/oauth-protected-resource/mcp`, which the `WWW-Authenticate` header of every 401 names. The IdP's discovery document must name the configured issuer. Its endpoints are the only other origins the server may contact for auth.
- **Browser sign-in.**
  - Authorization code with PKCE (S256), `state`, and `nonce`. The client can be public or confidential.
  - The in-progress sign-in lives in a signed `__Host-` cookie with `SameSite=Lax`, because the IdP's redirect back is cross-site.
  - The session is a signed, `HttpOnly`, `Secure`, `SameSite=Strict` `__Host-` cookie lasting 12 hours.
  - Both cookies are HS256 JWTs under a deploy-time secret. There's no server-side session state, so any instance can serve any request.
- **Who may use it.** There's an explicit allowlist:
  - OAuth subjects;
  - verified email addresses, or their domains;
  - or a scope the IdP grants only to permitted users.

  With no rule configured, the server refuses to start: it fails closed.
- **Host and Origin.** Only the configured public URL's host and origin are accepted, which keeps DNS-rebinding protection on deployed servers too.
- **Workers** uses `workers-oauth-provider` (step 11, Workers target). There the Worker is the authorization server Claude talks to, with sign-in delegated to the same upstream identity provider and allowlist.

## Consequences

- Deployers must register an OAuth client with their IdP, and, for MCP clients, allow dynamic client registration there or pre-register Claude. The setup guides cover Google, Microsoft Entra ID, Okta, and Auth0.
- Signing out ends the browser session only. Access tokens stay valid until they expire, as issued by the IdP.
