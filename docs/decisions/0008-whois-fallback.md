# 8. WHOIS fallback for extensions without RDAP

- Status: accepted (port 43 on deploy targets pending verification)
- Date: 2026-09-30

## Context

The IANA RDAP bootstrap published 2026-09-28 has no HTTPS RDAP service for many extensions a SaaS founder would check, including `.io`, `.co`, `.me`, `.sh`, `.us`, `.de`, `.jp`, `.eu`, and `.ch`. `.kg` and `.mg` list only HTTP services, which Titlesearch doesn't use. So the WHOIS fallback is on the main path, not an edge case.

## Decision

**Servers.** `packages/providers/src/whois/servers.ts` lists servers by extension, with hosts taken from IANA (`whois -h whois.iana.org <tld>`). An extension is supported only if real "registered" and "not found" responses from its server are recorded in `fixtures/whois/` and tested. Everything else reports `error` with code `no_registry_source`.

| Extension | Server | Default | Why |
|---|---|---|---|
| .io .sh .ac .me | whois.nic.* | on | Identity Digital format, recorded |
| .co | whois.registry.co | on | recorded |
| .us | whois.nic.us | on | recorded |
| .de | whois.denic.de | **off** | DENIC's terms limit use to "technical or administrative necessities of Internet operation". Enable with `whois.enable: ["de"]` after deciding it applies. |
| .eu | — | excluded | EURid's port-43 notice forbids applying "automated, electronic processes" to its WHOIS. |
| .ch | — | excluded | whois.nic.ch refuses port-43 queries ("Requests of this client are not permitted"). |

**Parsing is conservative.** A response is `registered` only if its `Domain Name:` (or DENIC `Domain:`) line names exactly the queried domain. It's "not found" only if it matches the server's recorded not-found text with no domain record. Anything else, such as refusals, rate-limit notices, or unexpected formats, is `error`, never a guess.

**Connectors** are injected, since core can't open sockets: `createNodeWhoisConnector` (`node:net`, for Node and Bun) and `workersWhoisConnector` (`connect()` from `cloudflare:sockets`). Responses are capped at 64 KB, with an 8-second timeout. WHOIS hosts come only from the server table, never from a user. Queries are rate-limited per host (default 1 per second, burst 2).

**Result source.** Fallback results use source id `whois`, which reconciliation treats as a registry source, like `rdap`.

## Port 43 egress by target

| Target | Documented restriction | Status |
|---|---|---|
| Cloudflare Workers | `connect()` blocks port 25 and Cloudflare IP ranges; no restriction on port 43 is documented. | **To verify** with a live query from a deployed Worker (step 10). The Workers connector has no automated test yet. |
| Cloud Run | Google Cloud blocks port 25 to external destinations; no restriction on port 43 is documented. | **To verify** in step 10. |
| AWS Lambda | AWS blocks port 25 by default; no restriction on port 43 is documented. A function attached to a VPC needs a NAT gateway for any internet egress. | **To verify** in step 10. |
| CLI and desktop (Node/Bun) | Depends on the user's network. | Covered by a local TCP test. |

## Consequences

Adding an extension means recording both responses from its server and adding tests; `CONTRIBUTING.md`'s fixture rule applies. Users see `error` rather than a guess for unsupported extensions.
