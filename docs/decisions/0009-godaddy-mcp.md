# 9. GoDaddy MCP: what the recordings showed

- Status: accepted (terms review pending)
- Date: 2026-09-30

## Context

`CLAUDE.md` says not to guess GoDaddy's tool names or schemas: record them, and build the mapping from the recordings. The recordings are in `fixtures/godaddy/`, captured on 2026-09-30 from `https://api.godaddy.com/v1/domains/mcp` (server `godaddy-domains-mcp` 1.29.1).

## Findings

- **Tools.** Two: `domains_check_availability` (input `domains`, a comma-separated string) and `domains_suggest` (input `query`, `limit`). Both are annotated `readOnlyHint: true`, `destructiveHint: false`. Neither declares an output schema. Their descriptions tell the model to always show GoDaddy registration links, which Titlesearch doesn't pass on: only mapped fields leave the provider.
- **Transport.** Stateless: no `mcp-session-id`. Responses are `text/event-stream` with a `Content-Length`, so they're finite. `notifications/initialized` returns 202. Responses carry `ratelimit-limit: 3000`, `ratelimit-remaining`, and `ratelimit-reset` headers, and Akamai bot-management cookies, which could affect automated clients in future.
- **No prices.** `priceInfo` and `currency` are `null` in every response recorded. GoDaddy results never include a price.
- **Bulk results hide premium names.** With two or more domains, each `domainGroups[]` entry has `searchedDomain` and a boolean `available`, but no inventory type. In one recording, three of six names were Premium according to GoDaddy's own text summary, yet all were plain `available: true` in the structured result. Mapping bulk results would report premium names as standard, breaking invariant 4.
- **Single-domain results are explicit.** A top-level `isAvailable` boolean, and, when available, an exact-match entry (`isExactMatch: true`) with `inventoryType` and `purchasable`. A registered domain has no exact-match entry, only suggestions. Inventory types seen: `Standard`, `Premium`, `Registry Premium`, and `Auction` (in suggestions).
- **"Premium" can be aftermarket.** `bank.app` came back `Premium`, available and purchasable, while Google Registry's RDAP says it's registered: a resale listing. `shoes.online` was `Registry Premium`, and RDAP says not found.

## Decision

- Only `domains_check_availability` is allowlisted. `domains_suggest` isn't needed.
- One domain per tool call, always, so every answer uses the single-domain shape. Concurrency is 4 per provider, with a rate limit of 5 per second.
- Mapping (`godaddy-check-availability-v1`):
  - `isAvailable: false` → `registered`, unless an exact match says available, which is an `error`.
  - `isAvailable: true` requires exactly one available, purchasable exact match. Then `Standard` → `available`, `Registry Premium` or `Premium` → `premium`, and `Auction` → `registered`.
  - Anything else, including a failed schema check, `isError`, a bulk-shaped result, or an unknown inventory type, → `error`.
- Plain `Premium` maps to `premium` without special casing. When it's an aftermarket listing, RDAP says registered, and reconciliation reports `unconfirmed` (`registry_taken_registrar_free`), with both sources shown. A test covers exactly this with the recorded `bank.app` responses.
- The nightly `contract-canary` workflow calls the live endpoint with fixed domains and opens an issue on drift.

## Open: terms of use

GoDaddy's MCP documentation says users must agree to GoDaddy's Universal Terms of Service and API Terms of Use, and that excessive requests may be throttled. It doesn't address self-hosted services calling the public endpoint on behalf of their own users. The API Terms of Use page returns 403 to automated fetches, so its full text wasn't reviewed. The excerpts seen permit use "through Automated Tools" to build integrations, but they bind the holder of an API credential, and the public MCP endpoint uses none.

**A person needs to read the API Terms of Use before GoDaddy ships as the default registrar source for deployed instances.** Until then it stays the default in code, which the brief specifies, with this ADR as the flag.

## Addendum, 2026-09-30: availability only

The updated brief makes GoDaddy an availability source only: "premium" now means a price source reported a registry premium price, and prices come only from Porkbun and Name.com. The mapping changed accordingly. `Standard`, `Registry Premium`, and `Premium` all map to `available`. `Auction` still maps to `registered`. Unknown inventory types are still errors. The aftermarket case (`bank.app`) is unaffected: RDAP says registered, so the result is `unconfirmed`.
