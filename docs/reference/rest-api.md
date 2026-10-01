# REST API

The HTTP API mirrors the MCP tools one to one, with the same schemas and the same core functions. Requests and responses are JSON. Request bodies are limited to 64 KB, and unknown fields are rejected.

## Authentication

- **Local server** (`titlesearch serve`, the desktop app): send `Authorization: Bearer <token>`, using the token from the `local-token` file in the config directory (the keychain on desktop). Browsers use a session cookie from a one-time code. Requests must use the host `127.0.0.1:<port>` or `localhost:<port>`, and an `Origin` header, when present, must be the server's own.
- **Deployed server:** send an OAuth access token from your identity provider, or use the browser session. A `401` carries `WWW-Authenticate` with the resource metadata URL. See [deployed auth](/decisions/0019-deployed-auth).

Requests are rate-limited per user (120 a minute by default). Requests that reach out to other sites share a server-wide concurrency limit; when it's full, the answer is `503` with `Retry-After`.

## Routes

| Method and path | Body or parameters | Returns |
|---|---|---|
| `POST /api/check` | `{ names, tlds? }` | `{ results }`: [check_domains](/reference/mcp-tools#check_domains) |
| `GET /api/domain/:domain` | | One result with presence evidence: [inspect_domain](/reference/mcp-tools#inspect_domain) |
| `POST /api/assess` | `{ name, market, tlds? }` | Results with evidence and assessments, plus `notice`: [assess_market_conflicts](/reference/mcp-tools#assess_market_conflicts) |
| `POST /api/suggest` | `{ description, count?, avoid? }` | `{ suggestions, suggestedBy, notice }`: [suggest_names](/reference/mcp-tools#suggest_names). `503` when the server has no model. |
| `POST /api/variants` | `{ seed, strategies?, tlds? }` | `{ candidates }`: [generate_variants](/reference/mcp-tools#generate_variants) |
| `GET /api/providers/health` | | Each source's status: `ok`, `degraded`, or `error` |
| `GET /api/preview/:hash` | | A stored preview image (`image/webp`), served from this origin |
| `GET /api/settings`, `PATCH /api/settings` | Patch: `{ providers?, assessment?, previews? }` | Current settings. Deployed servers are read-only (`400`). |
| `GET`, `POST`, or `DELETE /api/session` | `POST`: `{ code }` (local only) | `{ authenticated, login }` |
| `POST /api/token/rotate` | | `{ token }`, shown once (local only) |
| `POST /mcp` | MCP JSON-RPC | Streamable HTTP, stateless |
| `GET /healthz` | | `{ "ok": true }`, for platform health checks |

## Errors

Errors are `{ "error": { "code", "message" } }`, with the message written for people. Common codes are `invalid_json`, `invalid_request`, `unauthenticated`, `rate_limited` (`429`, with `Retry-After`), `busy` (`503`), and `unavailable` (`503`).
