# 10. Cache stores and the SQLite driver

- Status: accepted
- Date: 2026-09-30

## Context

The brief asks for a `CacheStore` with sqlite, d1, firestore, dynamodb, and memory implementations, all passing one conformance suite. For sqlite, it asks to confirm the driver works under `bun build --compile`, or else to use `bun:sqlite`.

## Decisions

### One SQLite store, two built-in drivers, no native addon

`SqliteStore` runs on a four-method driver interface (`exec`, and `prepare` returning `get`/`run`) that both built-in SQLite modules already satisfy:

- `@titlesearch/cache/sqlite/bun` wraps `bun:sqlite`. The CLI and the desktop sidecar are Bun-compiled binaries, so this is the one they ship with.
- `@titlesearch/cache/sqlite/node` wraps `node:sqlite` (Node 24, which emits no experimental warning).

Both were verified on 2026-09-30 inside a `bun build --compile` binary with an on-disk database (Bun 1.4.2). CI repeats the check on every run: the Bun job compiles `packages/cache/scripts/compile-smoke.ts`, runs it, and fails if a write doesn't survive reopening the file. `better-sqlite3` and other native addons aren't used, since they complicate single-file binaries.

The table is `STRICT`, with an index on `expires_at`. Expired rows are deleted on read, and in bulk every 200 writes. The database uses WAL mode with a 2-second busy timeout.

### The contract, as the conformance suite pins it

`packages/cache/test/conformance.ts` exports `cacheConformance(name, factory)`, which runs with an injected clock. Every store must behave the same way:

- Values round-trip through JSON. `get` returns a copy, and dates come back as ISO strings. `undefined`, functions, bigints, symbols, and cyclic values are rejected with `TypeError`.
- An entry is present until `now < expiresAt` stops being true, so it's gone exactly at its TTL. Overwriting replaces both value and TTL. Fractional seconds are allowed.
- A TTL must be positive and finite, or `set` throws `RangeError` and writes nothing. Keys are 1 to 512 characters.
- Encoded values are capped at 256 KB of UTF-8, below DynamoDB's 400 KB item limit, the smallest of the five backends, so a value that fits one store fits all of them.

Today the suite runs for memory and for SQLite on `node:sqlite` (Node and Bun) and `bun:sqlite` (Bun). D1, Firestore, and DynamoDB will run it when they're added with their deploy targets (step 10).

### Policy lives next to the stores

`availabilityTtl` and `TTL` encode the brief's table. Unconfirmed and error results return `undefined`, meaning "don't cache". Cache keys are versioned (`ts:v1:`):

- **Availability keys** include the sorted provider ids consulted, so enabling or disabling a registrar never serves a result built from other sources.
- **Assessment keys** use the first 128 bits of a SHA-256 of the normalized market text, so the user's product description never appears in a key or in the backing store's key index.

The RDAP provider now uses `MemoryStore` and `TTL.rdapBootstrap` instead of its own copies.

## Consequences

Node below 24 isn't supported for the SQLite store. Adding a backend means passing the whole conformance suite, including the size cap.
