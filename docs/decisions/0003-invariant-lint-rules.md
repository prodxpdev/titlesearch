# 3. Enforce invariants 1 to 3 with Biome GritQL plugins

- Status: accepted
- Date: 2026-09-29

## Context

`CLAUDE.md` requires lint rules for three invariants: read-only by construction (1), SSRF-safe fetching (2), and untrusted site content (3). The brief uses Biome, which has no built-in rules for these, but Biome 2 supports GritQL plugins and lets `overrides` scope a plugin to paths.

## Decision

Three plugins in `tools/biome-plugins/`, each applied through a path-scoped override in `biome.json`:

- **`no-direct-fetch.grit` (invariant 2)** flags any reference to the global `fetch`: calls, `globalThis.fetch`/`self.fetch`/`window.fetch`, and `fetch` passed or aliased as a value. It ignores `typeof fetch` in type positions and member calls such as Hono's `app.fetch`. It applies to `packages/`, `apps/`, and `deploy/`, including tests, and excludes only `packages/core/src/net/`.
- **`no-raw-site-content.grit` (invariant 3)** flags zero-argument body readers (`.text()`, `.arrayBuffer()`, `.bytes()`, `.blob()`, `.formData()`), streaming body access, and Hono's `c.html(...)`. It excludes `core/src/net/` (capped reads), `core/src/extract/` (field extraction), `server/src/static/` (the UI shell), and tests.
- **`no-write-operations.grit` (invariant 1)** flags identifiers and string literals that name domain or DNS write operations, such as `registerDomain`, `updateDnsRecords`, `"domains_purchase"`, and `"/dns/create/"`. It applies to `packages/`, `apps/cli/`, and `deploy/`, excluding tests (which must name refused tools). It isn't applied to `apps/web`, where UI state setters would cause false positives.

Core's runtime-agnostic rule uses Biome's built-in `noNodejsModules`, `noRestrictedImports` (`node:*`, `bun`, `bun:*`, `cloudflare:*`), and `noRestrictedGlobals` (`process`, `Buffer`, `require`, `Bun`, `Deno`, and others), scoped to `packages/core`.

### Fetching fixed origins

Some outbound requests go to fixed, configured origins rather than user-derived hosts: DoH resolvers, the IANA RDAP bootstrap, RDAP servers named by the bootstrap, registrar APIs, and the Anthropic API. These also go through `packages/core/src/net`, through a pinned-origin fetch that accepts only an allowlist of origins fixed at construction. Nothing outside `core/net` calls `fetch`, so the lint rule stays simple, with no per-call exemptions to review.

### Testing the rules

`tools/test/invariants.test.ts` writes each case to a temporary tree at the path it names, copies in the real `biome.json` and plugins, runs `biome lint --reporter=json`, and asserts exactly which rules fired. It also fails if any plugin reports a runtime error.

That last check matters. **GritQL treats regex capture groups as variable bindings**, and a plugin that errors at runtime is reported only as an info diagnostic, so `biome ci` passes while the rule enforces nothing. The first version of `no-write-operations.grit` had this bug and the suite caught it. Use `(?:...)` groups only.

`scripts/check-invariants.mjs` (run by `pnpm lint`) checks what Biome can't: core depends only on `zod`, core's tsconfig excludes Node types and the DOM lib, and `biome.json` still applies each plugin to the paths it guards.

## Consequences

- The invariant 1 rule is a name-based tripwire, not a proof. The real guarantees are the provider interface having no write methods (checked with a type-level test when the interface lands) and the upstream-MCP allowlist enforced at runtime.
- The invariant 3 rule can't see a raw body smuggled through a differently named method. The type of `safeFetch`'s result, which exposes no body reader, is the backstop.
- Biome's GritQL support is still evolving. If an upgrade changes matching behavior, the test suite is where it shows up.
