// Renderer isolation (invariant 8), against a real Chrome or Edge. Each
// hostile site tries to reach private addresses, metadata endpoints, or the
// local "internal" canary server, or to download files and gain permissions.
// Every attempt must be blocked at the egress proxy, the internal canary must
// never see a connection, and every capture must finish or fail cleanly.
//
// Needs an installed browser. Skipped locally without one; fails in CI.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import type { Resolver } from "@titlesearch/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBrowser } from "../src/find-browser.js";
import { LocalChromiumRenderer } from "../src/local-chromium.js";
import { CaptureError, type PreviewCapture } from "../src/renderer.js";

const browserPath = findBrowser();
if (process.env.CI && !browserPath)
  throw new Error("The isolation suite needs Chrome or Edge in CI.");

const FAKE_PUBLIC = "93.184.215.14";
const ctx = () => ({
  signal: new AbortController().signal,
  logger: { debug() {}, info() {}, warn() {}, error() {} },
});

let site: Server;
let canary: Server;
let sitePort = 0;
let canaryPort = 0;
let canaryHits = 0;
const canaryPaths: string[] = [];
const sitePaths: string[] = [];
let rebindLookups = 0;
const browserEvents: { type: string; detail?: unknown }[] = [];
let renderer: LocalChromiumRenderer;

const html = (res: ServerResponse, body: string) =>
  res
    .writeHead(200, { "content-type": "text/html; charset=utf-8" })
    .end(`<!doctype html><html><body>${body}</body></html>`);

const pages: Record<string, (req: IncomingMessage, res: ServerResponse) => void> = {
  "ok.test.example": (req, res) => {
    if (req.url === "/logo.png") return res.writeHead(404).end();
    html(res, "<h1>Welcome to the test site</h1><p>Scheduling software for field crews.</p>");
  },
  "subresources.test.example": (_req, res) =>
    html(
      res,
      `<h1>Subresource attack</h1>
      <img src="http://127.0.0.1:${canaryPort}/img">
      <img src="http://localhost:${canaryPort}/localhost">
      <img src="http://[::1]:${canaryPort}/v6">
      <img src="http://0x7f000001:${canaryPort}/hex">
      <img src="http://2130706433:${canaryPort}/decimal">
      <img src="http://10.0.0.5/private">
      <img src="http://169.254.169.254/latest/meta-data/">
      <img src="http://internal.test.example/named-private">
      <img src="http://metadata.test.example/named-metadata">
      <img src="https://127.0.0.1/https-loopback">
      <img src="http://ok.test.example:8080/odd-port">
      <script src="http://127.0.0.1:${canaryPort}/script.js"></script>
      <link rel="stylesheet" href="http://127.0.0.1:${canaryPort}/style.css">
      <link rel="prefetch" href="http://127.0.0.1:${canaryPort}/prefetch">
      <iframe src="http://127.0.0.1:${canaryPort}/frame"></iframe>
      <script>
        for (const u of ["http://127.0.0.1:${canaryPort}/fetch", "http://169.254.169.254/latest/api/token", "http://internal.test.example/fetch"]) fetch(u).catch(() => {});
        try { new WebSocket("ws://127.0.0.1:${canaryPort}/ws"); } catch {}
        try { new WebSocket("ws://internal.test.example/ws"); } catch {}
        try { navigator.sendBeacon("http://127.0.0.1:${canaryPort}/beacon", "x"); } catch {}
        try { new EventSource("http://127.0.0.1:${canaryPort}/sse"); } catch {}
      </script>`,
    ),
  "redirect-metadata.test.example": (_req, res) =>
    res
      .writeHead(302, {
        location: "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
      })
      .end(),
  "redirect-loopback.test.example": (_req, res) =>
    res.writeHead(302, { location: `http://127.0.0.1:${canaryPort}/admin` }).end(),
  "rebind.test.example": (req, res) => {
    if (req.url?.startsWith("/pixel")) return res.writeHead(404).end();
    html(
      res,
      `<h1>Rebind</h1><script>setTimeout(() => { for (let i = 0; i < 3; i++) fetch("/pixel" + i).catch(() => {}); }, 100);</script>`,
    );
  },
  "download.test.example": (req, res) => {
    if (req.url === "/file.bin") {
      return res
        .writeHead(200, {
          "content-type": "application/octet-stream",
          "content-disposition": 'attachment; filename="evil.bin"',
        })
        .end("MZ-not-really-an-executable");
    }
    html(
      res,
      `<h1>Download</h1><a id="a" href="/file.bin" download>get</a>
      <script>document.getElementById("a").click(); setTimeout(() => { location.href = "/file.bin"; }, 200);</script>`,
    );
  },
  "permissions.test.example": (_req, res) =>
    html(
      res,
      `<h1>Permissions</h1><p id="r">pending</p><script>
        const out = [];
        const show = () => { document.getElementById("r").textContent = out.join(" "); };
        out.push("geo:" + (navigator.geolocation ? "present" : "unavailable"));
        out.push("media:" + (navigator.mediaDevices ? "present" : "unavailable"));
        out.push("sw:" + (navigator.serviceWorker ? "present" : "unavailable"));
        out.push("clipboard:" + (navigator.clipboard ? "present" : "unavailable"));
        out.push("rtc:" + (typeof RTCPeerConnection === "undefined" ? "unavailable" : "present"));
        show();
        if (window.Notification) Notification.requestPermission().then((p) => { out.push("notification:" + p); show(); });
        else { out.push("notification:unavailable"); show(); }
      </script>`,
    ),
  "file-nav.test.example": (_req, res) =>
    html(
      res,
      `<h1>Scheme test</h1><script>setTimeout(() => { location.href = "file:///etc/passwd"; }, 50);</script>`,
    ),
  "chrome-nav.test.example": (_req, res) =>
    html(
      res,
      `<h1>Chrome URL test</h1><script>setTimeout(() => { location.href = "chrome://settings"; }, 50);</script>`,
    ),
  "slow.test.example": (req, res) => {
    if (req.url === "/never") return; // never responds
    html(res, `<h1>Slow page</h1><img src="/never">`);
  },
};

const resolver: Resolver = {
  async resolveHost(name) {
    if (name === "internal.test.example") return ["10.0.0.5"];
    if (name === "metadata.test.example") return ["169.254.169.254"];
    if (name === "rebind.test.example")
      return rebindLookups++ === 0 ? [FAKE_PUBLIC] : ["127.0.0.1"];
    if (name.endsWith(".test.example")) return [FAKE_PUBLIC];
    return [];
  },
};

// Only the fake public address reaches the site server. Anything else the
// proxy might wrongly connect to lands on the canary and fails the suite.
const proxyConnect = (address: string): Socket =>
  netConnect({ host: "127.0.0.1", port: address === FAKE_PUBLIC ? sitePort : canaryPort });

const listen = (s: Server) =>
  new Promise<number>((resolve) =>
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      resolve(typeof a === "object" && a ? a.port : 0);
    }),
  );

beforeAll(async () => {
  site = createServer((req, res) => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    sitePaths.push(`${host}${req.url}`);
    const page = pages[host];
    if (page) return page(req, res);
    res.writeHead(404).end();
  });
  canary = createServer((req, res) => {
    canaryPaths.push(req.url ?? "");
    res.writeHead(200).end("internal secret");
  });
  canary.on("connection", () => {
    canaryHits++;
  });
  sitePort = await listen(site);
  canaryPort = await listen(canary);
  if (browserPath) {
    renderer = new LocalChromiumRenderer({
      executablePath: browserPath,
      resolver,
      proxyConnect,
      onBrowserEvent: (e) => browserEvents.push(e),
    });
  }
});

afterAll(async () => {
  await renderer?.close();
  // The slow site's /never request holds a connection open; drop it.
  site?.closeAllConnections();
  canary?.closeAllConnections();
  await new Promise((r) => site?.close(r));
  await new Promise((r) => canary?.close(r));
}, 30_000);

/** Captures, returning the result or the CaptureError; anything else fails the test. */
async function tryCapture(domain: string): Promise<PreviewCapture | CaptureError> {
  try {
    return await renderer.capture(domain, ctx());
  } catch (err) {
    if (err instanceof CaptureError) return err;
    throw err;
  }
}

const isWebp = (b: Uint8Array) =>
  new TextDecoder().decode(b.subarray(0, 4)) === "RIFF" &&
  new TextDecoder().decode(b.subarray(8, 12)) === "WEBP";

describe.skipIf(!browserPath)("renderer isolation (real browser)", () => {
  it("captures an ordinary site: WebP full and thumbnail, rendered text", async () => {
    const r = await tryCapture("ok.test.example");
    if (r instanceof CaptureError) throw r;
    expect(isWebp(r.full.bytes)).toBe(true);
    expect(isWebp(r.thumbnail.bytes)).toBe(true);
    expect(r.full).toMatchObject({ width: 1280, height: 800, format: "webp" });
    expect(r.thumbnail).toMatchObject({ width: 480, height: 300, format: "webp" });
    expect(r.full.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.renderedText).toContain("Welcome to the test site");
    expect(r.finalUrl).toBe("http://ok.test.example/");
  }, 60_000);

  it("blocks every private subresource, request, and socket", async () => {
    const before = (await renderer.egressDecisions()).length;
    const r = await tryCapture("subresources.test.example");
    expect(r instanceof CaptureError ? r.code : "captured").toBe("captured");
    const blocked = (await renderer.egressDecisions())
      .slice(before)
      .filter((d) => d.verdict === "blocked")
      .map((d) => `${d.host}:${d.port}`);
    for (const target of [
      "10.0.0.5:80",
      "169.254.169.254:80",
      "internal.test.example:80",
      "metadata.test.example:80",
      "127.0.0.1:443",
      "ok.test.example:8080",
    ]) {
      expect(blocked, target).toContain(target);
    }
    expect(canaryHits).toBe(0);
  }, 60_000);

  it.each(["redirect-metadata.test.example", "redirect-loopback.test.example"])(
    "follows %s only as far as the proxy allows",
    async (domain) => {
      const r = await tryCapture(domain);
      // Either a capture of Chrome's error page or a clean CaptureError.
      expect(r instanceof CaptureError || r.full.bytes.length > 0).toBe(true);
      expect(canaryHits).toBe(0);
    },
    60_000,
  );

  it("re-checks DNS on every request, so rebinding reaches nothing", async () => {
    rebindLookups = 0;
    await tryCapture("rebind.test.example");
    const decisions = (await renderer.egressDecisions()).filter(
      (d) => d.host === "rebind.test.example",
    );
    expect(decisions.some((d) => d.verdict === "allowed")).toBe(true);
    expect(decisions.some((d) => d.verdict === "blocked" && d.reason === "blocked_address")).toBe(
      true,
    );
    expect(canaryHits).toBe(0);
  }, 60_000);

  it("never completes a download", async () => {
    await tryCapture("download.test.example");
    const completed = browserEvents.filter(
      (e) =>
        e.type === "downloadProgress" && (e.detail as { state?: string }).state === "completed",
    );
    expect(completed).toEqual([]);
  }, 60_000);

  it("denies permissions and removes risky APIs", async () => {
    const r = await tryCapture("permissions.test.example");
    if (r instanceof CaptureError) throw r;
    for (const s of [
      "geo:unavailable",
      "media:unavailable",
      "sw:unavailable",
      "clipboard:unavailable",
      "rtc:unavailable",
    ]) {
      expect(r.renderedText).toContain(s);
    }
    expect(r.renderedText).toMatch(/notification:(denied|unavailable)/);
  }, 60_000);

  it.each(["file-nav.test.example", "chrome-nav.test.example"])(
    "refuses non-http navigation from %s",
    async (domain) => {
      const r = await tryCapture(domain);
      if (r instanceof CaptureError) return;
      expect(r.finalUrl.startsWith("http://")).toBe(true);
      expect(r.renderedText).not.toMatch(/root:|Settings/);
    },
    60_000,
  );

  it("caps waiting for network idle and still captures", async () => {
    const t0 = Date.now();
    const r = await tryCapture("slow.test.example");
    expect(r instanceof CaptureError ? r.code : "captured").toBe("captured");
    expect(Date.now() - t0).toBeLessThan(15_000);
  }, 60_000);

  it("never let the internal canary see a connection", () => {
    expect(canaryHits).toBe(0);
    expect(canaryPaths).toEqual([]);
  });
});
