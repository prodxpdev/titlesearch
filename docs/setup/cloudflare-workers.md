# Cloudflare Workers

One Worker, from `deploy/workers`: the UI, API, and MCP server, with D1 for the cache, Browser Rendering for screenshots, and `workers-oauth-provider` as the authorization server Claude talks to (ADR 21).

## 1. Pick an identity provider

Any OpenID Connect provider works here, including Google: the Worker issues Claude's tokens itself. Register a web client with two redirect URIs:

- `https://<server>/oauth/callback`, for MCP clients such as Claude;
- `https://<server>/auth/callback`, for the web UI.

See [identity-providers.md](identity-providers.md).

## 2. Create the resources

```sh
cd deploy/workers
npx wrangler d1 create titlesearch          # put the database_id in wrangler.jsonc
npx wrangler kv namespace create OAUTH_KV   # put the id in wrangler.jsonc
npx wrangler d1 migrations apply titlesearch --remote
```

## 3. Configure

In `wrangler.jsonc`, set `vars`: `PUBLIC_URL`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, and an allowlist rule such as `ALLOWED_EMAIL_DOMAINS`. Then add secrets:

```sh
openssl rand -hex 32 | npx wrangler secret put SESSION_SECRET
npx wrangler secret put OIDC_CLIENT_SECRET
npx wrangler secret put PORKBUN_API_KEY          # optional, and the rest of the settings table
npx wrangler secret put PORKBUN_SECRET_API_KEY
```

## 4. Deploy

```sh
pnpm --filter @titlesearch/workers deploy   # builds the UI, embeds it, and runs wrangler deploy
```

For a custom domain, add a route or custom domain in the dashboard and set `PUBLIC_URL` to match.

## 5. Connect Claude

Add a custom connector with `https://<server>/mcp`. Claude registers itself, and you see Titlesearch's consent page, then your provider's sign-in.

## Previews and their limits

Browser Rendering is billed to your Cloudflare account. The free plan allows 10 minutes of browser time a day and 3 concurrent browsers.

**It can't use Titlesearch's egress proxy.** Every request the page makes is checked against the address rules before it's sent, but Chromium resolves the name again itself. A DNS answer that changes in between (DNS rebinding) isn't caught. ADR 21 lists exactly what holds. For full egress control, you have two options:

- Deploy the container renderer service (see the Cloud Run or AWS guide) and set `RENDERER_URL` and `RENDERER_TOKEN`; the Worker uses it instead.
- Remove the `browser` binding; previews then fall back to the sites' share images, fetched through `safeFetch`.

## Notes

- **WHOIS** uses outbound TCP sockets (port 43). Not yet verified on a live account.
- The script is about 1.5 MB gzipped, within the free plan's limit.
