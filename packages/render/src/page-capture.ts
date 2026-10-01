// Page-level capture steps shared by every renderer: the hardening script,
// the screenshots, and the rendered-text read. Runtime-agnostic: it speaks
// CDP through a minimal interface, so it works with puppeteer-core locally
// and @cloudflare/puppeteer on Workers.

import { type CapturedImage, sha256Hex, THUMBNAIL, VIEWPORT } from "./renderer.js";

export const NETWORK_IDLE_CAP_MS = 8_000;
export const CAPTURE_CAP_MS = 20_000;
export const MAX_FONT_BYTES = 2 * 1024 * 1024;
export const MAX_RENDERED_TEXT = 100_000;
export const USER_AGENT_SUFFIX = " Titlesearch/0.1 (preview)";

/** The part of a CDP session these steps use. */
export interface CdpLike {
  // biome-ignore lint/suspicious/noExplicitAny: CDP results are protocol-typed by each client library.
  send(method: string, params?: Record<string, unknown>): Promise<any>;
}

// Runs before any page script in every frame: removes APIs a preview never needs.
export const HARDEN_PAGE = `(() => {
  const drop = (o, k) => { try { Object.defineProperty(o, k, { get: () => undefined, configurable: false }); } catch {} };
  drop(Navigator.prototype, "serviceWorker");
  drop(Navigator.prototype, "geolocation");
  drop(Navigator.prototype, "mediaDevices");
  drop(Navigator.prototype, "clipboard");
  for (const k of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "Notification", "PushManager"]) drop(window, k);
})();`;

export async function readRenderedText(cdp: CdpLike): Promise<string> {
  try {
    const { frameTree } = await cdp.send("Page.getFrameTree");
    const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id,
      worldName: "titlesearch-text",
    });
    const { result } = await cdp.send("Runtime.evaluate", {
      expression: `(document.body ? document.body.innerText : "").slice(0, ${MAX_RENDERED_TEXT})`,
      contextId: executionContextId,
      returnByValue: true,
    });
    return typeof result.value === "string" ? result.value : "";
  } catch {
    return "";
  }
}

/**
 * The full-size and thumbnail screenshots, as WebP. CDP directly: puppeteer
 * ignores clip.scale when captureBeyondViewport is false, which silently
 * produced full-size "thumbnails".
 */
export async function captureScreens(
  cdp: CdpLike,
): Promise<{ full: CapturedImage; thumbnail: CapturedImage }> {
  const shoot = async (scale: number, quality: number) => {
    const { data } = (await cdp.send("Page.captureScreenshot", {
      format: "webp",
      quality,
      clip: { x: 0, y: 0, ...VIEWPORT, scale },
      captureBeyondViewport: false,
    })) as { data: string };
    return Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  };
  const full = await shoot(1, 80);
  const thumb = await shoot(THUMBNAIL.width / VIEWPORT.width, 75);
  return {
    full: { bytes: full, contentHash: await sha256Hex(full), ...VIEWPORT, format: "webp" },
    thumbnail: { bytes: thumb, contentHash: await sha256Hex(thumb), ...THUMBNAIL, format: "webp" },
  };
}
