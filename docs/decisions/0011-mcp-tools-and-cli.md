# 11. MCP tools and the CLI (step 5)

- Status: accepted
- Date: 2026-09-30

## Context

Step 5 adds the MCP tools and the `titlesearch` CLI with `mcp` and `check`, so Claude Desktop works end to end.

## Decisions

### SDK

`@modelcontextprotocol/sdk` 1.31.0, which accepts Zod 3.25+ or Zod 4, so it shares the repo's Zod 4 instance. Tools use `McpServer.registerTool` with Zod input and output schemas; the SDK publishes them as JSON Schema in `tools/list`. `toolInputJsonSchemas()` exports the same schemas for docs and the REST API. `packages/mcp` stays transport-agnostic: the CLI connects the server to stdio, and the HTTP server will connect it to Streamable HTTP in step 8.

### Only the tools whose evidence exists

Step 5 registers `check_domains` and `generate_variants`. `inspect_domain` and `assess_market_conflicts` promise presence evidence (DNS, site fields, parking signals), which doesn't exist until step 6. Registering them now would give the model tools that return nothing useful under a description saying otherwise. They'll arrive with the probe (step 6) and the classifier (step 7), along with the `saas_naming_session` prompt, which calls both.

### One service behind every surface

`checkDomains` and `expandCandidates` in `packages/core/src/check.ts` are what the MCP tool, the CLI, and later `POST /api/check` call. The caps (20 names, 50 domains) are enforced there, and in the tool's input schema for names. The service:

- runs every provider that supports an extension, in parallel;
- turns a throwing provider, a wrong result count, or a result that fails `SourceResult` validation into `error` sources, never a failed call and never a dropped domain;
- reconciles, and records the rule in the new `DomainResult.availabilityReason`;
- caches by the TTL policy and re-validates cache hits with `DomainResult`.

The cache contract and TTL policy moved from `packages/cache` into core, so this service can use them without core depending on the cache package, which still re-exports them.

### Annotations

Every tool has `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, and `openWorldHint: true`, as the brief requires for every tool. `generate_variants` makes no network requests, so `openWorldHint` is conservative for it; its description says it's offline.

### CLI

- Bun-compiled single binary (`bun build --compile apps/cli/src/main.ts`), about 63 MB with the runtime included. CI builds it on every run.
- Logs go only to stderr, redacted, with the level from `TITLESEARCH_LOG`, since stdout carries the MCP protocol in `mcp` mode.
- Config is `config.json` in the platform config directory: `~/Library/Application Support/titlesearch` on macOS, `$XDG_CONFIG_HOME/titlesearch` on Linux, `%APPDATA%\titlesearch` on Windows. It's strict: unknown keys are rejected, so a secret pasted into it fails loudly instead of being ignored. The cache is SQLite in the platform cache directory; if it can't be opened, the CLI runs without it.
- Exit codes: 0 success, 1 unexpected failure, 2 usage or config error.
- Table labels: "Available", "Premium", and "Unconfirmed" come from the brief's vocabulary. "Registered", "Not at registry", and "Error" are placeholders, because the brief's labels for taken names come from the site check (step 6). They need reconciling with `docs/design/titlesearch-mockups.html`, which isn't in the repo yet.

## Verified

On 2026-09-30, the compiled binary served `titlesearch mcp` to the SDK's stdio client, listed both tools, and answered `check_domains` from the live RDAP, WHOIS, and GoDaddy sources. A cached re-run took 0.1 s against 5.7 s cold.
