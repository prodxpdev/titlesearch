# Contributing to Titlesearch

Thanks for helping. This guide covers what you need to get a change merged.

## Developer Certificate of Origin

Titlesearch uses the [Developer Certificate of Origin](https://developercertificate.org/) (DCO), not a CLA. Every commit must include a `Signed-off-by` line certifying that you wrote the change or otherwise have the right to submit it under the Apache-2.0 license:

```
Signed-off-by: Your Name <you@example.com>
```

Add it automatically with `git commit -s`. CI checks every commit in a pull request. To sign off commits you've already made, run `git rebase --signoff main` and force-push your branch.

## Getting set up

You'll need Node 24 (see `.nvmrc`) and pnpm 10.

```sh
pnpm install
pnpm check      # lint, invariant checks, typecheck, and tests
```

`pnpm format` applies Biome formatting.

## The invariants

`CLAUDE.md` lists seven invariants: read-only by construction, SSRF-safe fetching, untrusted site content, honest status, local surfaces stay local, no secrets, and US English. Changes that weaken one won't be merged. If you think a change needs to, open an issue first.

Three of them are enforced by Biome plugins in `tools/biome-plugins/`:

| Rule | Invariant | What it rejects |
|---|---|---|
| `no-write-operations.grit` | 1, read-only | Identifiers and strings naming domain or DNS write operations |
| `no-direct-fetch.grit` | 2, SSRF-safe fetching | Any use of the global `fetch` outside `packages/core/src/net` |
| `no-raw-site-content.grit` | 3, untrusted content | Raw body reads and raw HTML outside `core/net`, `core/extract`, and the static UI module |

`packages/core` also can't import Node, Bun, or Workers modules, or use globals such as `process` and `Buffer`.

If you change a rule, update `tools/test/invariants.test.ts`, and add cases for both what it should catch and what it should allow.

## Fixtures and tests

- Unit tests make no live network calls. New external responses (registrar APIs, RDAP, upstream MCP) are recorded into `fixtures/` and validated with Zod.
- Don't invent a response shape. Record a real one.

### New parking or for-sale signatures

Parking detection reads versioned data from `packages/core/signatures/parking.json`. Every signature you add needs:

1. At least one real page that it matches, recorded with `node tools/record-site-fixture.mjs <domain>` into `fixtures/sites/`, and listed in the signature's `fixtures`. Strip anything personal and keep only what the signature needs.
2. A test showing the signature matches that fixture.
3. A check that it doesn't match an existing non-parked fixture.

Pull requests that add a signature without a fixture and a test won't be merged.

## Decisions

If you make a choice that a future contributor would otherwise have to rediscover, record it as an ADR in `docs/decisions/`. Copy the format of an existing one.

## Style

- User-facing copy follows the vocabulary in `docs/design/titlesearch-mockups.html`, in sentence case and US English.
- Record user-facing changes with a changeset: `pnpm changeset`.
