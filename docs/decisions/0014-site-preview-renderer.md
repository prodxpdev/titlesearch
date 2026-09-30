# 14. Site-preview renderer and its egress proxy

- Status: accepted (in progress: image storage, the preview route, and the Chromium download come next)
- Date: 2026-09-30

## Context

The updated brief adds screenshot previews and invariant 8. Previews run a headless browser that executes third-party JavaScript. Chromium resolves DNS and loads subresources itself, so `safeFetch` can't protect it; all its traffic must go through an egress proxy that applies the same address rules to every connection.

## Decisions

### One rule set, shared

`safeFetch`'s host validation is now the exported `resolvePublicAddress` in `core/net`, and the proxy calls exactly that, plus `isAllowedPort` (80 and 443). There's no second copy of the rules to drift.

### The egress proxy (`packages/render/src/egress-proxy.ts`)

A small HTTP forward proxy, built on Node's `http` and `net` (Bun implements both), bound to `127.0.0.1` on an ephemeral port.

- **HTTPS and WebSockets** arrive as `CONNECT host:port`. The target is canonicalized through the URL parser, so `0x7f000001` becomes `127.0.0.1`. Then it's validated, and the proxy opens the tunnel to the **validated address** itself.
- **Plain HTTP** arrives as absolute-URI requests. Each request is validated separately, then forwarded to the validated address.
- **Refused outright:** `https://` sent as plain HTTP (it must use `CONNECT`), upgrades outside `CONNECT`, and malformed targets. A request line Node can't parse is refused by Node itself.

Because the proxy resolves and connects, every connection is pinned: DNS rebinding between check and connect is impossible, even for a page that fetches the same host many times. Every decision is recorded, capped at 10,000, for tests and debug logging.

### The browser can't get around the proxy

`chromiumArgs()` sets:

- `--proxy-server` pointing at the proxy.
- **`--proxy-bypass-list=<-loopback>`.** By default Chrome connects to loopback addresses directly, bypassing any proxy. This flag removes that exception.
- **`--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1`.** Chrome may resolve no names itself. Only the proxy, an IP literal, is reachable.
- `--disable-quic`, and WebRTC restricted to proxied UDP, since UDP can't go through an HTTP proxy.
- Background networking, component updates, sync, extensions, and Chrome's own server features off.

**These two flags are load-bearing, and a test proves it.** With `--proxy-bypass-list` and `--host-resolver-rules` removed, the isolation suite fails: the local "internal" canary received 9 to 10 connections per hostile page, from loopback subresources, a redirect to loopback, and a rebinding host. With them, it receives none.

### Per-capture hardening

- A fresh browser context for every capture: no profile, cookies, or credentials carry over. The context closes afterward, including on abort.
- Downloads are denied through CDP, and permission prompts are auto-denied (`--deny-permission-prompts`).
- A script that runs before any page script removes `serviceWorker`, `geolocation`, `mediaDevices`, `clipboard`, and the WebRTC constructors.
- CDP `Fetch` interception allows navigations only to `http:` and `https:`, allows subresources only over `http:`, `https:`, `data:`, and `blob:`, blocks all media, and blocks fonts that declare more than 2 MB. Fonts without a length are allowed, since CDNs often compress and chunk them.
- 1280 by 800 viewport. Wait for network idle (`networkidle2`) up to 8 seconds, then capture what has rendered. Each capture is capped at 20 seconds overall, and 2 run at a time.
- Chrome encodes WebP itself: full size at 1280 by 800, and the thumbnail at 480 by 300 through a scaled clip. No image codec is bundled.
- Rendered text is read in a CDP isolated world, which shares the DOM but not the page's JavaScript, so a page can't patch `innerText` to feed us something different. It's third-party text either way, and gets the `untrustedSiteText` treatment.

### Driver and browser

- **`puppeteer-core` 25.12**, not Playwright: it's CDP-native, and Chrome's own WebP encoding is reachable through it, while Playwright captures only PNG and JPEG. Both were tried against the installed Chrome 154 on Node and Bun, and both worked.
- `findBrowser` looks for Chrome, Edge, or Chromium in the platform's standard locations, or in `TITLESEARCH_CHROME_PATH`. Chromium is never bundled.

### The isolation suite (`packages/render/test/isolation.test.ts`)

Real Chrome, against hostile sites served locally. The proxy's test `connect()` routes only the fake public address to the site server; anything else lands on an "internal" canary server, so any bypass shows up as a canary connection. The hostile sites cover:

- subresources to loopback in every encoding, private addresses, metadata, private names, and odd ports;
- `fetch`, WebSocket, beacon, and EventSource requests;
- redirects to metadata and to loopback;
- DNS rebinding;
- forced downloads;
- permission requests;
- `file:` and `chrome:` navigations;
- a page that never reaches network idle.

Every attempt is blocked at the proxy, every capture finishes or fails cleanly, and the canary sees zero connections. The suite runs on Node and Bun. Without a browser it's skipped locally, and it fails in CI.

**CI note:** Ubuntu 24.04 restricts unprivileged user namespaces, which Chrome's sandbox needs. CI lifts that with `sysctl` rather than running Chrome with `--no-sandbox`. The code never disables the sandbox.

## Still to do in step 8

- Image storage by content hash (a blob variant of the cache store).
- Rendered text feeding extraction (`contentConfidence: "high"`).
- The `/api/preview/:hash` handler.
- `inspect_domain`'s `includePreview`.
- The share-image fallback, re-encoded to WebP.
- The one-time, checksum-verified Chromium download.
- The container sidecar and Cloudflare Browser Rendering belong with the deploy targets (step 11).
