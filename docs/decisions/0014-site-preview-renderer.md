# 14. Site-preview renderer and its egress proxy

- Status: accepted
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

### Images: capture, storage, and serving

- **Captured through CDP directly.** The screenshots use CDP's `Page.captureScreenshot`, not puppeteer's `page.screenshot`. With `captureBeyondViewport: false`, puppeteer silently ignores `clip.scale`, so "thumbnails" came out 1280 by 800. The bug was found by looking at a live capture. The isolation suite now checks real pixel dimensions from the WebP header, not the dimensions the renderer claims.
- **Stored by SHA-256** in a new `BlobStore`, implemented by the memory and SQLite stores and pinned by a blob conformance suite: exact bytes, copies, TTL, and a 1 MB cap. Images live as long as the presence evidence (6 hours).
- **Served** by `previewImageResponse(blobs, hash)`, which the server mounts at `/api/preview/:hash` in step 9. It accepts only a 64-character hex hash, only serves WebP, and sets `nosniff`, `default-src 'none'; sandbox`, `same-origin` resource policy, and an immutable private cache.

### Error pages aren't previews

GoDaddy's for-sale page answers headless Chrome with an Akamai "Access Denied" page. Taken at face value, that page's text replaced the site's with `contentConfidence: "high"`, and its screenshot became the preview. The renderer now reports the final top-level document's status, following script redirects. The previewer treats 400 and above as a failed capture: the fetched text stands, and the share-image fallback applies. The domain's occupancy doesn't depend on the capture: it was still "for sale" from its nameservers and redirects.

### Rendered text feeds extraction

A successful capture's text replaces the fetched page's text for signatures and `untrustedSiteText`, and `contentConfidence` becomes `"high"`. Its final URL counts as a redirect for signatures. That's how `bluewidget.com`, whose fetched page is only a script redirect to `/lander`, now also matches `redirect-godaddy-forsale`.

### Share-image fallback

When capture is off or fails, the page's `og:image` (or `twitter:image`) is fetched through `safeFetch` and re-encoded to WebP with the jsquash WASM codecs. The encoder's WASM loader is injectable: the compiled CLI embeds the files with Bun's `with { type: "file" }` imports.

- Image type comes from the file's first bytes, not its headers.
- SVG is refused, since it can carry script.
- PNG, JPEG, and WebP only. GIF and ICO give no fallback image.
- **Decompression bombs:** dimensions are read from the file header, and anything over 4 megapixels is refused before decoding.

### MCP

`inspect_domain` accepts `includePreview`. The 480 by 300 thumbnail comes back as an image block, after a text block saying it's third-party content, not instructions. The full-size image is never sent.

### The one-time Chromium download

- **The build:** a pinned `chrome-headless-shell` from Chrome for Testing, 95 to 115 MB, for all five release platforms (Chrome for Testing covers Linux arm64). It's the right artifact for screenshots.
- **Checksums are ours:** Chrome for Testing publishes none, so `tools/pin-chromium.mjs` downloads each archive and records its SHA-256 and size in `packages/render/src/chromium-manifest.json`.
- **Verified before anything touches disk:** `fetchVerified` in `core/net` fetches from the manifest URL's origin only and returns bytes only if size and hash match. It's then unpacked with the OS's own `unzip`, or `tar` on Windows.
- **`titlesearch browser install` and `titlesearch browser status`** are the CLI's form of "offers a download". The desktop app and web UI will offer it as a button. The renderer uses an installed Chrome or Edge first, then the verified download.
- **Checked for real:** the real macOS arm64 build was downloaded and verified. The whole isolation suite then passed against it, with zero canary connections.
- **Headless shell difference:** `Notification.requestPermission()` never settles in headless shell. The hardening script now removes `Notification` and `PushManager` entirely, so both browsers behave the same.

## Deferred to the deploy targets (step 11)

- The container sidecar, with its own egress policy.
- The `cloudflare-browser-rendering` renderer, and verifying whether its traffic can be forced through an egress proxy.
- WASM loading on Workers.
