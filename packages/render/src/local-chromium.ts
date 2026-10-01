// The local-chromium renderer: an installed Chrome or Edge, driven over CDP,
// with every connection forced through the egress proxy (invariant 8).
//
// Layers, outermost first:
// 1. The egress proxy applies safeFetch's address rules to every connection
//    and connects to the validated address itself.
// 2. Chromium flags leave no path around the proxy: loopback isn't bypassed,
//    Chrome can resolve no names itself, QUIC is off, and WebRTC can't use
//    unproxied UDP.
// 3. Each capture gets a fresh browser context: no cookies, profile, or
//    credentials carry over. Downloads are denied, permission prompts are
//    denied, service workers and WebRTC are removed, and only http(s)
//    navigations are allowed.
// See docs/decisions/0014-site-preview-renderer.md.

import type { Socket } from "node:net";
import { type Logger, type Resolver, silentLogger } from "@titlesearch/core";
import puppeteer, { type Browser, type CDPSession, type Page } from "puppeteer-core";
import { type EgressProxy, startEgressProxy } from "./egress-proxy.js";
import {
  CAPTURE_CAP_MS,
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

export const LOCAL_CHROMIUM = "local-chromium";

export interface LocalChromiumOptions {
  executablePath: string;
  /** DNS for the egress proxy. Use the same resolver as safeFetch (DoH). */
  resolver: Resolver;
  /** Concurrent captures. CLAUDE.md: 2 locally. */
  concurrency?: number;
  logger?: Logger;
  /**
   * Runs Chromium without its own sandbox. Only for the deployed renderer
   * service, whose container or microVM is the isolation boundary, where
   * Chromium's sandbox can't start (no user namespaces). Never set locally.
   */
  noSandbox?: boolean;
  /** Tests only: routes the proxy's validated connections to local servers. */
  proxyConnect?: (address: string, port: number) => Socket;
  /** Tests only: observe browser-level events such as downloads. */
  onBrowserEvent?: (event: { type: string; detail?: unknown }) => void;
}

/** Flags that leave the browser no network path except the egress proxy. */
export function chromiumArgs(proxyUrl: string): string[] {
  return [
    `--proxy-server=${proxyUrl}`,
    // Chrome bypasses the proxy for loopback by default; this removes that.
    "--proxy-bypass-list=<-loopback>",
    // Chrome may resolve nothing itself; only the proxy (an IP literal) is reachable.
    "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
    "--disable-quic",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--dns-prefetch-disable",
    "--deny-permission-prompts",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-domain-reliability",
    "--disable-client-side-phishing-detection",
    "--disable-sync",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-breakpad",
    "--disable-print-preview",
    "--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider,AutofillServerCommunication,InterestFeedContentSuggestions",
    "--metrics-recording-only",
    "--no-first-run",
    "--no-default-browser-check",
    "--mute-audio",
    "--hide-scrollbars",
  ];
}

class Semaphore {
  #active = 0;
  readonly #waiting: (() => void)[] = [];
  constructor(readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#active >= this.max) await new Promise<void>((r) => this.#waiting.push(r));
    this.#active++;
    try {
      return await fn();
    } finally {
      this.#active--;
      this.#waiting.shift()?.();
    }
  }
}

export class LocalChromiumRenderer implements PreviewRenderer {
  readonly id = LOCAL_CHROMIUM;
  readonly #options: LocalChromiumOptions;
  readonly #logger: Logger;
  readonly #slots: Semaphore;
  #started: Promise<{ browser: Browser; proxy: EgressProxy }> | undefined;

  constructor(options: LocalChromiumOptions) {
    this.#options = options;
    this.#logger = options.logger ?? silentLogger;
    this.#slots = new Semaphore(options.concurrency ?? 2);
  }

  /** The egress proxy's decisions, for tests and diagnostics. */
  async egressDecisions() {
    return (await this.#start()).proxy.decisions;
  }

  #start(): Promise<{ browser: Browser; proxy: EgressProxy }> {
    this.#started ??= (async () => {
      const proxy = await startEgressProxy({
        resolver: this.#options.resolver,
        ...(this.#options.proxyConnect ? { connect: this.#options.proxyConnect } : {}),
        onDecision: (d) => {
          if (d.verdict === "blocked") this.#logger.debug("Egress blocked", { ...d });
        },
      });
      try {
        const browser = await puppeteer.launch({
          executablePath: this.#options.executablePath,
          headless: true,
          args: [...chromiumArgs(proxy.url), ...(this.#options.noSandbox ? ["--no-sandbox"] : [])],
          // No automation extension, no default "--enable-automation" banner needs.
          defaultViewport: { ...VIEWPORT },
        });
        browser.on("disconnected", () => {
          this.#started = undefined;
          void proxy.close();
        });
        return { browser, proxy };
      } catch (err) {
        await proxy.close();
        throw new CaptureError(
          "no_browser",
          `Couldn't start the browser: ${(err as Error).message}`,
        );
      }
    })().catch((err: unknown) => {
      this.#started = undefined;
      throw err;
    });
    return this.#started;
  }

  capture(domain: string, ctx: RenderContext): Promise<PreviewCapture> {
    return this.#slots.run(() => this.#capture(domain, ctx));
  }

  async #capture(domain: string, ctx: RenderContext): Promise<PreviewCapture> {
    ctx.signal.throwIfAborted();
    const { browser } = await this.#start();
    const context = await browser.createBrowserContext();
    const timeout = AbortSignal.timeout(CAPTURE_CAP_MS);
    const signal = AbortSignal.any([ctx.signal, timeout]);
    const onAbort = () => void context.close().catch(() => {});
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const page = await context.newPage();
      const cdp = await page.createCDPSession();
      await this.#harden(page, cdp, browser);

      // The status of the last top-level document, following script redirects too.
      let status: number | undefined;
      page.on("response", (r) => {
        if (r.request().isNavigationRequest() && r.frame() === page.mainFrame())
          status = r.status();
      });

      const url = `http://${domain}/`;
      try {
        await page.goto(url, { waitUntil: "networkidle2", timeout: NETWORK_IDLE_CAP_MS });
      } catch (err) {
        signal.throwIfAborted();
        // Network idle not reached within the cap: capture whatever has rendered.
        if (!/timeout/i.test((err as Error).message)) {
          if (page.url() === "about:blank") {
            throw new CaptureError("navigation_failed", `Couldn't load ${domain}.`);
          }
        }
      }
      signal.throwIfAborted();

      const { full, thumbnail } = await captureScreens(cdp);
      // Read text in an isolated world: it shares the DOM but not the page's
      // JavaScript, so page scripts can't patch the getters used here.
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
      if (!browser.connected)
        throw new CaptureError("browser_crashed", "The browser stopped during capture.");
      throw new CaptureError("navigation_failed", `Couldn't capture ${domain}.`);
    } finally {
      signal.removeEventListener("abort", onAbort);
      await context.close().catch(() => {});
    }
  }

  async #harden(page: Page, cdp: CDPSession, browser: Browser): Promise<void> {
    const onEvent = this.#options.onBrowserEvent;
    const browserContextId = page.browserContext().id;

    // Downloads: denied for this context.
    const browserCdp = await browser.target().createCDPSession();
    await browserCdp.send("Browser.setDownloadBehavior", {
      behavior: "deny",
      ...(browserContextId ? { browserContextId } : {}),
      eventsEnabled: true,
    });
    if (onEvent) {
      browserCdp.on("Browser.downloadWillBegin", (e) =>
        onEvent({ type: "downloadWillBegin", detail: e }),
      );
      browserCdp.on("Browser.downloadProgress", (e) =>
        onEvent({ type: "downloadProgress", detail: e }),
      );
    }

    await page.setUserAgent((await browser.userAgent()) + USER_AGENT_SUFFIX);
    await page.evaluateOnNewDocument(HARDEN_PAGE);

    // Request control: only http(s) navigations; no media; no fonts over 2 MB.
    await cdp.send("Fetch.enable", {
      patterns: [
        { urlPattern: "*", requestStage: "Request" },
        { urlPattern: "*", resourceType: "Font", requestStage: "Response" },
      ],
    });
    cdp.on("Fetch.requestPaused", (e) => {
      void (async () => {
        const fail = () =>
          cdp.send("Fetch.failRequest", { requestId: e.requestId, errorReason: "BlockedByClient" });
        try {
          if (e.responseStatusCode !== undefined) {
            const len = e.responseHeaders?.find(
              (h) => h.name.toLowerCase() === "content-length",
            )?.value;
            if (len !== undefined && Number(len) > MAX_FONT_BYTES) return await fail();
            return await cdp.send("Fetch.continueResponse", { requestId: e.requestId });
          }
          const scheme = e.request.url.slice(0, e.request.url.indexOf(":") + 1).toLowerCase();
          const isNavigation = e.resourceType === "Document";
          const allowed = isNavigation
            ? scheme === "http:" || scheme === "https:"
            : ["http:", "https:", "data:", "blob:"].includes(scheme);
          if (!allowed || e.resourceType === "Media") {
            onEvent?.({
              type: "requestBlocked",
              detail: { url: e.request.url, resourceType: e.resourceType },
            });
            return await fail();
          }
          await cdp.send("Fetch.continueRequest", { requestId: e.requestId });
        } catch {
          // The page or context closed mid-request.
        }
      })();
    });
  }

  async close(): Promise<void> {
    const started = this.#started;
    this.#started = undefined;
    if (!started) return;
    try {
      const { browser, proxy } = await started;
      await browser.close().catch(() => {});
      await proxy.close();
    } catch {
      // Never started.
    }
  }
}
