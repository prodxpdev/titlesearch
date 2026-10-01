// The Browser Rendering renderer with a fake browser: the per-request address
// checks, and the capture flow. The real service is only reachable from a
// deployed Worker.

import type { Resolver } from "@titlesearch/core";
import { describe, expect, it } from "vitest";
import { type CfBrowser, CloudflareBrowserRenderer, refusal } from "../src/cloudflare.js";
import { CaptureError } from "../src/renderer.js";

const DNS: Record<string, string[]> = {
  "acme.io": ["93.184.215.14"],
  "cdn.acme.io": ["2606:4700::6810:84e5"],
  "rebind.example": ["10.0.0.5"],
  "mixed.example": ["93.184.215.14", "169.254.169.254"],
};
const resolver = (calls: string[] = []): Resolver => ({
  async resolveHost(name) {
    calls.push(name);
    return DNS[name] ?? [];
  },
});

describe("refusal", () => {
  it.each([
    ["http://acme.io/", true, undefined],
    ["https://cdn.acme.io/app.js", false, undefined],
    ["data:image/png;base64,AAAA", false, undefined],
    ["data:text/html,<script>", true, "scheme"],
    ["file:///etc/passwd", true, "scheme"],
    ["chrome://settings", true, "scheme"],
    ["http://169.254.169.254/latest/meta-data/", false, "address"],
    ["http://127.0.0.1/", false, "address"],
    ["http://[::1]/", false, "address"],
    ["http://rebind.example/", false, "address"],
    ["http://mixed.example/", false, "address"],
    ["http://nxdomain.example/", false, "address"],
    ["http://acme.io:8080/", false, "port"],
    ["http://user:pw@acme.io/", true, "credentials"],
  ])("%s → %s", async (url, nav, expected) => {
    expect(await refusal(url, nav, resolver(), new Map())).toBe(expected);
  });

  it("resolves each host once per capture", async () => {
    const calls: string[] = [];
    const cache = new Map<string, Promise<boolean>>();
    const r = resolver(calls);
    await Promise.all([
      refusal("https://acme.io/a", false, r, cache),
      refusal("https://acme.io/b", false, r, cache),
    ]);
    expect(calls).toEqual(["acme.io"]);
  });
});

function fakeBrowser(requests: { url: string; resourceType: string }[]) {
  const log: { sent: string[]; failed: string[]; continued: string[]; closed: boolean } = {
    sent: [],
    failed: [],
    continued: [],
    closed: false,
  };
  const handlers = new Map<string, (e: unknown) => void>();
  const ids = new Map<string, string>();
  const cdp = {
    on(event: string, h: (e: unknown) => void) {
      handlers.set(event, h);
    },
    async send(method: string, params?: Record<string, unknown>) {
      log.sent.push(method);
      if (method === "Fetch.failRequest")
        log.failed.push(ids.get(params?.requestId as string) ?? "");
      if (method === "Fetch.continueRequest")
        log.continued.push(ids.get(params?.requestId as string) ?? "");
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.captureScreenshot") return { data: btoa("RIFF0000WEBPdata") };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
      if (method === "Runtime.evaluate") return { result: { value: "Invoices for freelancers." } };
      return {};
    },
  };
  let current = "about:blank";
  const browser: CfBrowser = {
    async newPage() {
      return {
        createCDPSession: async () => cdp,
        setViewport: async () => {},
        setUserAgent: async () => {},
        evaluateOnNewDocument: async () => {},
        url: () => current,
        async goto(url) {
          requests.forEach((r, i) => {
            ids.set(`r${i}`, r.url);
            handlers.get("Fetch.requestPaused")?.({
              requestId: `r${i}`,
              resourceType: r.resourceType,
              request: { url: r.url },
            });
          });
          handlers.get("Network.responseReceived")?.({
            type: "Document",
            frameId: "main",
            response: { status: 200 },
          });
          await new Promise((r) => setTimeout(r, 10));
          current = url;
        },
      };
    },
    userAgent: async () => "HeadlessChrome",
    close: async () => {
      log.closed = true;
    },
  };
  return { browser, log };
}

describe("CloudflareBrowserRenderer", () => {
  it("captures, refusing private subresources and allowing public ones", async () => {
    const { browser, log } = fakeBrowser([
      { url: "http://acme.io/", resourceType: "Document" },
      { url: "https://cdn.acme.io/app.js", resourceType: "Script" },
      { url: "http://169.254.169.254/latest/meta-data/", resourceType: "XHR" },
      { url: "http://rebind.example/x.png", resourceType: "Image" },
      { url: "https://acme.io/video.mp4", resourceType: "Media" },
    ]);
    const renderer = new CloudflareBrowserRenderer({
      launch: async () => browser,
      resolver: resolver(),
    });
    const c = await renderer.capture("acme.io", {
      signal: new AbortController().signal,
      logger: console,
    });
    expect(log.continued.sort()).toEqual(["http://acme.io/", "https://cdn.acme.io/app.js"]);
    expect(log.failed.sort()).toEqual([
      "http://169.254.169.254/latest/meta-data/",
      "http://rebind.example/x.png",
      "https://acme.io/video.mp4",
    ]);
    expect(log.sent).toContain("Page.setDownloadBehavior");
    expect(c).toMatchObject({
      status: 200,
      renderer: "cloudflare-browser-rendering",
      renderedText: "Invoices for freelancers.",
    });
    expect(c.full).toMatchObject({ width: 1280, height: 800, format: "webp" });
    expect(log.closed).toBe(true);
  });

  it("reports a browser that won't start", async () => {
    const renderer = new CloudflareBrowserRenderer({
      launch: async () => {
        throw new Error("Rate limit exceeded");
      },
      resolver: resolver(),
    });
    await expect(
      renderer.capture("acme.io", { signal: new AbortController().signal, logger: console }),
    ).rejects.toMatchObject({ code: "no_browser" });
    expect(CaptureError).toBeDefined();
  });
});
