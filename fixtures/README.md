# Fixtures

Recorded responses from real services, used by tests so no unit test touches the network. Don't hand-write a response shape; record one. Where a fixture is synthetic, the test that builds it says so (the RDAP 429 case, for example: provoking a real 429 from a shared registry server isn't reasonable).

| Directory | Source | Recorded |
|---|---|---|
| `doh/` | Cloudflare and Google DNS JSON APIs | 2026-09-30 |
| `rdap/` | IANA bootstrap (`dns.json`), Verisign, Nominet, Google Registry, Radix, CentralNic | 2026-09-30 |
| `whois/` | whois.nic.io, .sh, .ac, .me, whois.registry.co, whois.nic.us, whois.denic.de, whois.nic.ch | 2026-09-30 |
| `sites/` | Home pages of parked, for-sale, and real sites, recorded with `tools/record-site-fixture.mjs` (DNS, every hop, final body) | 2026-09-30 |
| `godaddy/` | `https://api.godaddy.com/v1/domains/mcp` (godaddy-domains-mcp 1.29.1) | 2026-09-30 |

Notes:

- `rdap/*.json` wrap each response as `{ recordedFrom, recordedAt, status, headers, body }`, keeping only `content-type` and `retry-after`.
- `rdap/centralnic-403-unserved-tld.json` is a real 403 from asking a server about an extension it doesn't serve. It tests that a 403 is an `error`, not "not found".
- `godaddy/*.sse` are raw event-stream bodies. `check-bulk-*.sse` show why the mapping never uses bulk results (see ADR 9).
- `whois/ch-refused.txt` is `.ch`'s refusal of port-43 queries, used as an "unrecognized" case. `.eu` responses aren't kept, because EURid's terms forbid automated use (ADR 8).
- `sites/bluerealty.com` and `sites/greengames.com` are real businesses, kept as negative controls: no parking signature may fire on them. `sites/godaddy-lander` starts at `https://bluewidget.com/lander`.
- Recorded pages are scanned for personal data and credentials before commit. In `sites/`, a personal email address, a Google API key, and an opaque token found in page source were replaced with `redacted@example.com`, `REDACTED_GOOGLE_API_KEY`, and `REDACTED_TOKEN_…`.
- Test domains use the label `titlesearch-nx-7c41e9`, chosen to be unregistered.
