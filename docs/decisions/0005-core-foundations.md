# 5. Core foundations: model, reconciliation, and network policy

- Status: accepted
- Date: 2026-09-30

## Context

Build step 2 adds the domain model, reconciliation, `safeFetch`, and DoH to `packages/core`. Several choices in it go beyond the brief or weren't obvious.

## Decisions

### Tests run on Node, Bun, and workerd with Vitest 4

The Workers test pool (`@cloudflare/vitest-pool-workers@0.22.0`) supports Vitest 4 only, so the repo pins Vitest 4.1.11 rather than 5.x. Every core test file runs unchanged in all three runtimes: `pnpm test` (Node), `bun --bun vitest run` (Bun), and `pnpm test:workers` (workerd through Miniflare). Core's Workers config uses no `nodejs_compat` flag, which also proves core needs no Node APIs.

`vitest.workers.config.ts` uses compatibility date `2026-08-22`, the newest the bundled workerd supports. Renovate updates to the pool will allow later dates.

### Import zod as a namespace

Under Vitest on Bun, `import { z } from "zod"` yields `undefined`; zod's `export * as z` re-export is lost, while its flat exports are fine. Plain Bun and Node aren't affected. Every package uses `import * as z from "zod"`, which zod supports, and a Biome `noRestrictedImports` rule rejects the named `z` import.

### Reconciliation reports a reason

`reconcile()` returns `{ availability, reason }`. The reason says which row of the table applied, such as `registry_free_registrar_taken`, so the UI and tool output can explain an `unconfirmed` result without reinterpreting the sources.

- Source ids `rdap` and `whois` speak for the registry; every other id is a registrar.
- A source that reports a state it can't know, such as a registry claiming `available`, makes the result `unconfirmed` (`invalid_source_state`) rather than being coerced or ignored.
- Two registrars that disagree, including `available` against `premium`, make the result `unconfirmed`. Different prices for the same state are not a disagreement.
- A failed registrar counts as absent, which matches the table's "none configured" rows.

### Address policy is an allowlist

`classifyIp` allows only global unicast: IPv4 outside the IANA special-purpose ranges, and IPv6 inside `2000::/3` minus the special-purpose blocks there. Beyond the ranges the brief lists, it also blocks documentation, benchmarking, IETF protocol, 6to4 relay, and reserved space.

Any address that embeds or translates to IPv4 (IPv4-mapped, IPv4-compatible, NAT64, 6to4, Teredo) is refused outright, even if the embedded IPv4 address is public. Unwrapping is a common source of SSRF-filter bugs, and no legitimate site needs to be reached that way.

IPv4 parsing is strictly canonical dotted-quad. Alternate encodings (decimal, octal, hex, shorthand) never reach it: the WHATWG URL parser canonicalizes them in URL hosts on all three runtimes, and the SSRF suite checks that it does.

### safeFetch details

- Names that are never public (`localhost`, `*.localhost`, `*.local`, `*.internal`, `*.home.arpa`, `*.localdomain`, and single labels) are refused before any DNS lookup.
- If any resolved address is non-public, the whole host is refused, because the runtime's own resolver might pick that address.
- The resolver must return both A and AAAA answers or fail; a partial answer would leave one family unchecked.
- Options can lower the 5-second timeout and the 512 KB cap but never raise them.
- The caller's abort signal is checked before each hop, so no request is sent after an abort.
- The body is kept in a module-private `WeakMap`, not on the result. Only `readSafeFetchBody`, which the package doesn't export, can read it. Core's extractor will be its only caller.

### Fixed origins use createOriginFetch

Requests to DoH resolvers, RDAP, registrars, upstream MCP servers, and the Anthropic API go through `createOriginFetch`: HTTPS only, an origin allowlist fixed at construction, redirects followed only within it (maximum 3), a timeout, and a size cap. See [ADR 3](0003-invariant-lint-rules.md).

### DoH

Cloudflare's JSON API is tried first and Google's second. Real responses from both are in `fixtures/doh/`. A resolver's answer is discarded, and the next resolver tried, on SERVFAIL or any other non-zero status except NXDOMAIN, on a truncated response, on a failed schema check, or on any malformed record. A null MX (`0 .`, RFC 7505) counts as no mail.

## Consequences

Contributors must use the namespace zod import. Vitest 5 has to wait for Workers pool support.
