// The cloudflare-browser-rendering renderer, for the Workers target. Billed to
// the deployer's Cloudflare account.
//
// Browser Rendering can't be forced through our egress proxy: its launch
// accepts no Chromium flags (only keep_alive), and Chromium resolves names
// itself on Cloudflare's network. So invariant 8 holds here only in part, and
// docs/decisions/0021-workers-deploy.md says exactly which parts:
//
// - Holds: the browser has no credentials and no access to our cache or
//   secrets (it's a remote service); each capture gets a fresh browser; only
//   http(s) navigations; no downloads; the hardening script; and the UI only
//   ever shows the stored image from our origin.
// - Partly: every request is intercepted over CDP and refused unless its port
//   is 80 or 443 and its host resolves (through our DoH resolver) only to
//   public addresses. Chromium then resolves the name again itself, so a DNS
//   answer that changes in between (rebinding) isn't caught, unlike with the
//   proxy, which connects to the address it checked.
// - Doesn't apply: cloud metadata, since there's none of ours on
//   Cloudflare's network.

import { isAllowedPort, type Resolver, resolvePublicAddress } from "@titlesearch/core";
import {
  CAPTURE_CAP_MS,
  type CdpLike,
  captureScreens,
  HARDEN_PAGE,
  MAX_FONT_BYTES,
  NETWORK_IDLE_CAP_MS,
  readRenderedText,
  USER_AGENT_SUFFIX,
} from "./page-capture.js";
import {
  CaptureError,
  type PreviewCapture,
  type PreviewRenderer,
  type RenderContext,
  VIEWPORT,
} from "./renderer.js";

export const CLOUDFLARE_BROWSER_RENDERING = "cloudflare-browser-rendering";

/** The parts of @cloudflare/puppeteer this renderer uses. */
export interface CfCdpSession extends CdpLike {
  // biome-ignore lint/suspicious/noExplicitAny: CDP event payloads are protocol-typed by the client library.
  on(event: string, handler: (event: any) => void): unknown;
}
export interface CfPage {
  createCDPSession(): Promise<CfCdpSession>;
  setViewport(viewport: { width: number; height: number }): Promise<unknown>;
  setUserAgent(userAgent: string): Promise<unknown>;
  evaluateOnNewDocument(script: string): Promise<unknown>;
  goto(url: string, options: { waitUntil: "networkidle2"; timeout: number }): Promise<unknown>;
  url(): string;
}
export interface CfBrowser {
  newPage(): Promise<CfPage>;
  userAgent(): Promise<string>;
  close(): Promise<unknown>;
}

export interface CloudflareRendererOptions {
  /** Launches a browser: `() => puppeteer.launch(env.BROWSER)`. */
  launch: () => Promise<CfBrowser>;
  /** Our DoH resolver, for the per-request address checks. */
  resolver: Resolver;
}

/** Why a request was refused, or undefined to allow it. */
export async function refusal(
  url: string,
  isNavigation: boolean,
  resolver: Resolver,
  cache: Map<string, Promise<boolean>>,
): Promise<string | undefined> {
  const scheme = url.slice(0, url.indexOf(":") + 1).toLowerCase();
  if (scheme === "data:" || scheme === "blob:") return isNavigation ? "scheme" : undefined;
  if (scheme !== "http:" && scheme !== "https:") return "scheme";
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "url";
  }
  if (u.username || u.password) return "credentials";
  const port = u.port ? Number(u.port) : scheme === "https:" ? 443 : 80;
  if (!isAllowedPort(port)) return "port";
  let ok = cache.get(u.hostname);
  if (!ok) {
    ok = resolvePublicAddress(u.hostname, resolver).then(
      () => true,
      () => false,
    );
    cache.set(u.hostname, ok);
  }
  return (await ok) ? undefined : "address";
}

export class CloudflareBrowserRenderer implements PreviewRenderer {
  readonly id = CLOUDFLARE_BROWSER_RENDERING;
  readonly #options: CloudflareRendererOptions;

  constructor(options: CloudflareRendererOptions) {
    this.#options = options;
  }

  async capture(domain: string, ctx: RenderContext): Promise<PreviewCapture> {
    ctx.signal.throwIfAborted();
    const timeout = AbortSignal.timeout(CAPTURE_CAP_MS);
    const signal = AbortSignal.any([ctx.signal, timeout]);
    let browser: CfBrowser;
    try {
      browser = await this.#options.launch();
    } catch (err) {
      throw new CaptureError(
        "no_browser",
        `Browser Rendering didn't start: ${(err as Error).message}`,
      );
    }
    const onAbort = () => void browser.close().catch(() => {});
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const page = await browser.newPage();
      await page.setViewport({ ...VIEWPORT });
      await page.setUserAgent((await browser.userAgent()) + USER_AGENT_SUFFIX);
      await page.evaluateOnNewDocument(HARDEN_PAGE);
      const cdp = await page.createCDPSession();
      await cdp.send("Page.setDownloadBehavior", { behavior: "deny" });

      const { frameTree } = (await cdp.send("Page.getFrameTree")) as {
        frameTree: { frame: { id: string } };
      };
      const mainFrame = frameTree.frame.id;
      let status: number | undefined;
      await cdp.send("Network.enable");
      cdp.on(
        "Network.responseReceived",
        (e: { type: string; frameId?: string; response: { status: number } }) => {
          if (e.type === "Document" && e.frameId === mainFrame) status = e.response.status;
        },
      );

      const checked = new Map<string, Promise<boolean>>();
      await cdp.send("Fetch.enable", {
        patterns: [
          { urlPattern: "*", requestStage: "Request" },
          { urlPattern: "*", resourceType: "Font", requestStage: "Response" },
        ],
      });
      cdp.on(
        "Fetch.requestPaused",
        (e: {
          requestId: string;
          resourceType: string;
          request: { url: string };
          responseStatusCode?: number;
          responseHeaders?: { name: string; value: string }[];
        }) => {
          void (async () => {
            const fail = () =>
              cdp.send("Fetch.failRequest", {
                requestId: e.requestId,
                errorReason: "BlockedByClient",
              });
            try {
              if (e.responseStatusCode !== undefined) {
                const len = e.responseHeaders?.find(
                  (h) => h.name.toLowerCase() === "content-length",
                )?.value;
                if (len !== undefined && Number(len) > MAX_FONT_BYTES) return await fail();
                return await cdp.send("Fetch.continueResponse", { requestId: e.requestId });
              }
              if (e.resourceType === "Media") return await fail();
              const why = await refusal(
                e.request.url,
                e.resourceType === "Document",
                this.#options.resolver,
                checked,
              );
              if (why) return await fail();
              await cdp.send("Fetch.continueRequest", { requestId: e.requestId });
            } catch {
              // The page closed mid-request.
            }
          })();
        },
      );

      try {
        await page.goto(`http://${domain}/`, {
          waitUntil: "networkidle2",
          timeout: NETWORK_IDLE_CAP_MS,
        });
      } catch (err) {
        signal.throwIfAborted();
        if (!/timeout/i.test((err as Error).message) && page.url() === "about:blank")
          throw new CaptureError("navigation_failed", `Couldn't load ${domain}.`);
      }
      signal.throwIfAborted();

      const { full, thumbnail } = await captureScreens(cdp);
      const renderedText = await readRenderedText(cdp);
      return {
        full,
        thumbnail,
        finalUrl: page.url(),
        status,
        renderedText,
        capturedAt: new Date().toISOString(),
        renderer: this.id,
      };
    } catch (err) {
      if (err instanceof CaptureError) throw err;
      if (timeout.aborted && !ctx.signal.aborted)
        throw new CaptureError("timeout", `Capturing ${domain} took too long.`);
      ctx.signal.throwIfAborted();
      throw new CaptureError("navigation_failed", `Couldn't capture ${domain}.`);
    } finally {
      signal.removeEventListener("abort", onAbort);
      await browser.close().catch(() => {});
    }
  }

  async close(): Promise<void> {}
}
