# 12. Presence probe, HTML extraction, and parking signatures

- Status: accepted
- Date: 2026-09-30

## Context

Step 6 builds the presence probe. The brief asks for a streaming HTML tokenizer that works on every runtime (`HTMLRewriter` exists only on Workers), recorded in an ADR, and for parking signatures as versioned data with a fixture page and test behind every signature. It also says `packages/core` has no runtime dependencies beyond Zod.

## Decisions

### An in-house tokenizer

Because core may depend only on Zod, `htmlparser2`, `parse5`, and similar libraries are out. `core/src/extract/tokenizer.ts` is a small tokenizer written for this job:

- Start and end tags, with attributes in every quoting style (the first occurrence wins, as in browsers).
- Comments, doctypes, CDATA, and processing instructions, all skipped.
- Raw-text elements (`script`, `style`, and others) and RCDATA elements (`title`, `textarea`).
- Numeric character references, and the named references that appear in titles and body text. An unknown named reference is left as written.

It never throws. Malformed input degrades to text, and unterminated constructs run to the end of the input.

It makes one pass over the body, not a pass per network chunk. `safeFetch` already caps bodies at 512 KB, so chunk-level streaming would add complexity without bounding anything further. The same code runs on Node, Bun, and workerd, and the tests run on all three.

### What extraction returns

`extractPage` returns only:

- `title`, meta `description`, `og:title`, and `og:description`;
- JSON-LD `@type` values and the first `name`, including `@graph` and type arrays, from `type="application/ld+json"` scripts only, so app-state blobs like `__NEXT_DATA__` aren't mistaken for JSON-LD;
- visible text, and client-side redirect targets.

**Visible text** excludes `script`, `style`, `nav`, `footer` (per the brief), plus `head`, `template`, `svg`, `math`, `select`, `button`, and any element with `hidden` or `aria-hidden="true"`. That last rule came from a live check: GitHub's page text otherwise began with the text of its hidden session-alert banners. An open-element stack handles unclosed tags the way browsers do. `noscript` content counts as visible, since the probe doesn't run scripts.

**Every field**, not just `untrustedSiteText`, is third-party text. Each is cleaned the same way: control, bidi, and zero-width characters are stripped, whitespace collapsed, and the field capped (title 300, descriptions 500, JSON-LD name 200). Visible text stays inside core. Only its 600-character `untrustedSiteText` excerpt leaves.

**Charsets:** the Content-Type charset, then a `<meta>` charset in the first 1024 bytes, then UTF-8. Windows-1252 decoding was verified on all three runtimes. An unknown label falls back to UTF-8.

### The probe

`probePresence`:

1. Runs DoH queries for A, AAAA, NS, and MX, in parallel.
2. With no address records, reports `no_site` and stops. If the address lookups themselves failed, it reports no occupancy at all.
3. Otherwise, `safeFetch` of `https://<domain>/`, falling back to `http://` only when HTTPS couldn't connect. A refused address or port isn't retried.
4. Extracts, matches signatures, and assembles the evidence.

**Occupancy:** any for-sale signal gives `for_sale`, then parked signals give `parked`, then a fetched page gives `unassessed`. If addresses exist but nothing answered, it's `no_site`, with the failures in `probeErrors`.

**The probe doesn't run or follow JavaScript.** Meta-refresh and simple `location` assignments are recorded as `clientRedirects` and matched by signatures, but never fetched. Pages with under 200 characters of text get `contentConfidence: "low"`.

**Probed domains:** registered ones, and unconfirmed ones where a registry source says registered (resale listings). Presence is cached for 6 hours, except when DNS couldn't be read.

### Signatures from recorded pages only

`packages/core/signatures/parking.json` (version 1) lists 15 signatures:

| Kind | Signatures |
|---|---|
| Nameservers | Afternic, NameFind, HugeDomains, Efty, Atom, BrandBucket (for sale); Sedo parking, Above, ParkLogic (parked) |
| Client redirect | GoDaddy's `/lander` |
| Redirect hosts | forsale.godaddy.com, HugeDomains, Atom, BrandBucket |
| Text | "this domain/website … is for sale", or the domain name followed by "is for sale" |

They come from sampling nameservers for 400 plausible `.com` names over DoH on 2026-09-30, then recording what each parking service served with `tools/record-site-fixture.mjs`. Each signature lists its fixtures, and `test/parking.test.ts` fails if a signature doesn't fire on every fixture it lists, or if anything fires on the real-site controls (`bluerealty.com`, a real-estate site, and `greengames.com`).

Some signatures from the brief's examples aren't included because no recorded page shows them yet: "make an offer", "related searches", and Above.com's `ww##.` subdomain redirect. Above served that redirect in one fetch and "Click here to enter" an hour later. They can be added with fixtures.

The text signature is deliberately narrow. A bare "is for sale" fires on real-estate and shop pages. The pattern requires "this domain", "this website", or the domain name itself.

### Asking prices

`askingPrice` is extracted only when the page is for sale, and only next to buying language ("Buy now: $3,795"). The currency is kept as the page shows it: "$" isn't assumed to be USD. Ambiguous numbers like "1,5" give no price rather than a guess. A test caught "€1.200" being read as 1 before this rule existed.

## Consequences

Sites that render entirely in JavaScript give little evidence, and say so through `contentConfidence`. Parking services change their pages; the fixtures pin today's behavior, and new signatures need new recordings.
