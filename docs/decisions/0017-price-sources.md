# 17. Price sources: Porkbun and Name.com

- Status: accepted (live recordings pending keys)
- Date: 2026-10-01

## Context

`CLAUDE.md` makes Porkbun and Name.com the only sources of prices and premium status, with Porkbun the default, as direct REST adapters. It asks us to verify Porkbun's endpoints, the key permissions they need, and whether they flag premium names, and to recommend keys without purchase permission where a registrar supports that.

No Porkbun or Name.com account was available while building this. Everything below comes from each registrar's published OpenAPI spec, saved as excerpts in `fixtures/porkbun/spec-contract.json` (Porkbun API v3.48, `https://porkbun.com/api/json/v3/spec`) and `fixtures/namecom/spec-contract.json` (Name.com Core API 1.35.0, `https://docs.name.com/api/v1/namecom.api.yaml`).

## Findings

**Porkbun**

- **Endpoint.** `POST /api/json/v3/domain/checkDomain` with a `domains` array of up to 25 names. Keys go in the `X-API-Key` and `X-Secret-API-Key` headers, so they never appear in a request body.
- **Rate limit.** 200 domains per 60 seconds per account, counted per domain, in a separate allowance from the single check's 10 per 10 seconds.
- **Premium.** Each answer has `avail`, `price` (a decimal string in USD, first year), and `premium` (`yes` or `no`). So Porkbun does flag premium names.
- **Partial results.** The response has three lists: `domains` (answers), `unresolved` (the registry lookup didn't answer; the spec says this is not a statement of availability), and `invalid`.
- **Errors.** `{"status": "ERROR", "code", "message"}`, sometimes with a `next_action` and a `requestId`. A rate limit can arrive as HTTP 200 with `RATE_LIMIT_EXCEEDED`. Bad keys return HTTP 400 with `INVALID_API_KEYS_001`, recorded live with deliberately invalid keys in `fixtures/porkbun/error-auth-recorded.json`.
- **Key permissions.** Keys can't be limited to read-only operations. Each key can be restricted to source IP addresses (CIDR allowed) and to target domains. We haven't confirmed whether a target-domain allowlist also blocks availability checks on other names, so we don't recommend it.
- **Sandbox keys.** Keys prefixed `pk1_sb_` (secret `sk1_sb_`) simulate every registration, renewal, transfer, and DNS change against an isolated datastore, with fake credit. The spec says "availability and pricing reflect the real catalog so quotes match production." That makes a sandbox key the closest Porkbun has to a key without purchase permission: real prices, and no way to buy a real domain.
- **Mock server.** `/api/json/v3/mock/<path>` returns example responses with no credentials. For the bulk check it returns placeholder values (`"domains": {"example": {}}`), so it doesn't help with mapping. Its error response was recorded as `fixtures/porkbun/error-mock-recorded.json`.
- **Porkbun's hosted MCP** is still never used as an upstream (`CLAUDE.md`).

**Name.com**

- **Endpoint.** `POST /core/v1/domains:checkAvailability` (the colon must not be encoded) with `domainNames`, up to 50, and an optional `purchaseType` filter.
- **Auth.** HTTP Basic: username and API token. Production is `api.name.com`. The sandbox is `api.dev.name.com`, with the username suffixed `-test`.
- **Answers.** `domainName` (punycode), `purchasable`, and, only when purchasable, `premium`, `purchasePrice` (a number in USD, minimum term), and `purchaseType`. Results come back in no particular order.
- **Purchase types.** Besides `registration`, there are aftermarket, expiring, and backorder types: names someone else holds. With `purchaseType: "registration"`, those come back as `purchasable: false`.
- **Errors.** 401, 403, 422 (no domain in the request is on a supported extension), 429 with `X-RateLimit-Reset`, and 5xx. The API overall is limited to 20 requests per second.
- **Key permissions.** The docs don't describe scoped or read-only tokens. Sandbox prices, especially premium prices, are documented as non-authoritative, so the sandbox is for testing only, not for real checks.

## Decision

- **Both are direct adapters** (`packages/providers/src/porkbun`, `packages/providers/src/namecom`). Each calls one read-only endpoint, through `createOriginFetch` locked to the registrar's origin, with retries on 429 and 5xx. Neither has any other method.
- **Mapping, Porkbun.**
  - `avail: no` → `registered`.
  - `premium: yes` → `premium`.
  - Anything else → `available`.
  - Every answer carries `{amount, currency: "USD", period: "first_year"}`.
  - `unresolved` → `error` (`unresolved`). A domain missing from the answer → `error` (`not_checked`).
  - A rate limit (HTTP 429, or HTTP 200 with `RATE_LIMIT_EXCEEDED`) → `rate_limited`. Any `INVALID_API_KEY…` code → `unauthorized`, as for Name.com. Any other error code is passed through, lowercased.
- **Mapping, Name.com.**
  - Every request sends `purchaseType: "registration"`.
  - `purchasable: false` → `registered`.
  - `purchasable: true` → `premium` when `premium` is true, otherwise `available`, with `purchasePrice` as the first-year USD price when present. Without a price, the UI says "No price from this source."
  - A purchasable result with a non-registration `purchaseType` contradicts the filter → `error` (`inconsistent_response`).
  - 401 → `unauthorized`; 403 → `forbidden`; 422 → `unsupported_tld`; 429 → `rate_limited`.
- **Never coerced.** Every answer is validated by Zod. A malformed price, or a boolean sent as a string, makes that domain an `error`, never a guess.
- **GoDaddy and premium.** GoDaddy's results are marked `availabilityOnly` (ADR 9 addendum). Its "available" agrees with a price source's "available" or "premium", so RDAP not-found + GoDaddy available + Porkbun premium reconciles to `premium`. Two registrars that really disagree (one available, one not) still make the result `unconfirmed`.
- **Rate limits.**
  - Porkbun charges `porkbun:bulk` once per domain, at 200 per 60 seconds with a burst of 25.
  - Name.com charges `namecom` once per request, at 5 per second, well under its documented 20.
- **Configuration (CLI and desktop).**
  - Porkbun runs when `PORKBUN_API_KEY` and `PORKBUN_SECRET_API_KEY` are both set. Name.com runs when `NAMECOM_USERNAME` and `NAMECOM_TOKEN` are both set.
  - Both are on by default once their keys exist, and can be turned off in `config.json` or on the Providers screen.
  - `providers.namecom.environment: "test"` selects the sandbox.
  - Keys never enter `config.json` or settings responses. The settings only say whether a source is configured.
  - Every key is registered with the redacting logger; the Name.com username isn't secret.
- **Documentation recommends:**
  - for Porkbun, a sandbox key (`pk1_sb_`), or failing that a dedicated key restricted by IP address;
  - for Name.com, a dedicated production token, stating that it can't be scoped.
- **Fixtures.** Because no account was available, the Porkbun and Name.com fixtures are built from the specs, and each file says so in `_source`. The exceptions are two Porkbun errors: one recorded from its mock server, and one recorded live with invalid keys. This falls short of `CLAUDE.md`'s "recorded responses". Recording real answers is the first task once keys exist: run the live canary with them and save the responses.
- **Contract canary.** It runs nightly and checks each spec for drift. It compares each saved excerpt with the live spec by structure ($refs resolved, prose dropped), so a changed field, type, or limit fails, and reworded descriptions don't. When keys are configured as repository secrets, it also checks a registered and an unregistered domain live.

## Consequences

- With no price-source keys, results have no prices, and the UI says "No price from this source." Availability still comes from RDAP and GoDaddy.
- A sandbox-only Porkbun recommendation depends on Porkbun's promise that sandbox prices match production. The live canary, run with a sandbox key, is where a break in that promise would show up.
- Name.com's `purchasable: false` covers both registered names and names held for resale. Both are reported as `registered`. A disagreement with RDAP surfaces as `unconfirmed`, as with any registrar.
