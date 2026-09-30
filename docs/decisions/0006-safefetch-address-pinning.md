# 6. safeFetch address pinning by runtime

- Status: accepted (partly pending verification)
- Date: 2026-09-30

## Context

`safeFetch` validates every address a host resolves to, then asks the runtime to connect. If the runtime resolves the name again, a DNS server controlled by an attacker can return a public address to the check and a private one to the connection (DNS rebinding). The brief says to pin the connection to the validated IP where the runtime allows it, and to document where it can't.

## Decision

`safeFetch` sends every hop through a `Transport`, passing the validated address. A transport with `pinsAddress: true` must connect to that address. Results report `pinned`, and so does `PresenceEvidence.http`, so a caller can see which guarantee applied.

Core ships only `globalFetchTransport`, which uses the runtime's `fetch` and **does not pin**. Core can't import runtime-specific networking, so pinning transports live in the packages for each runtime.

| Runtime | Pinning | Status |
|---|---|---|
| Node (container: Cloud Run, Lambda, ECS) | An undici `Agent` whose `connect.lookup` returns the validated address, which keeps SNI and certificate checks on the host name. | Planned for `packages/server` (step 8). |
| Bun (CLI and desktop sidecar) | Not verified. Bun's `fetch` doesn't accept undici dispatchers. Options are Bun's `tls.serverName` with an IP URL, if supported, or `node:https` with a `lookup` override. | **To verify** when the CLI transport is written (step 5). Until then, CLI results report `pinned: false`. |
| Cloudflare Workers | Not possible: `fetch` resolves through Cloudflare and offers no address override. Workers egress originates from Cloudflare's network, with no route to a deployer's private network or a cloud metadata service. | **To verify** against Cloudflare's documentation, and record here, before the Workers target ships (step 10). |

## Consequences

- Until a pinning transport exists for a runtime, the DNS-rebinding window between check and connect remains there. Other checks still apply to every hop: scheme, port, credentials, names, IP literals, and redirects.
- `pinned: false` in results is a visible signal, not a silent gap.
