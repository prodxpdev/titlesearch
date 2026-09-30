// Connects the renderer, the share-image fallback, and image storage to the
// presence probe (core's PresencePreviewer).

import {
  type BlobStore,
  cacheKeys,
  fetchPreviewImage,
  type Logger,
  type PresencePreviewer,
  type PreviewRef,
  type Resolver,
  silentLogger,
  type Transport,
  TTL,
} from "@titlesearch/core";
import { isDecodable, type WebpEncoder } from "./image-codec.js";
import { WEBP } from "./preview-response.js";
import type { PreviewRenderer } from "./renderer.js";
import { sha256Hex } from "./renderer.js";

export interface PreviewerOptions {
  blobs: BlobStore;
  /** Screenshots. Omit when previews are off. */
  renderer?: PreviewRenderer;
  /** Share-image fallback. Omit to show no image when capture is unavailable. */
  shareImage?: { encoder: WebpEncoder; resolver: Resolver; transport?: Transport };
  logger?: Logger;
  /** Images live as long as the presence evidence that points to them. */
  ttlSeconds?: number;
}

export function createPreviewer(options: PreviewerOptions): PresencePreviewer {
  const logger = options.logger ?? silentLogger;
  const ttl = options.ttlSeconds ?? TTL.presence;
  const store = (hash: string, bytes: Uint8Array) =>
    options.blobs.putBlob(cacheKeys.previewImage(hash), bytes, WEBP, ttl);

  const previewer: PresencePreviewer = {};
  const renderer = options.renderer;
  if (renderer) {
    previewer.capture = async (domain, signal) => {
      try {
        const c = await renderer.capture(domain, { signal, logger });
        // An error page (often a bot challenge: marketplaces block headless
        // browsers) isn't a picture of the site, and its text isn't the site's.
        if (c.status !== undefined && c.status >= 400) {
          logger.info("Preview capture got an error page; not using it", {
            domain,
            status: c.status,
          });
          return undefined;
        }
        await Promise.all([
          store(c.thumbnail.contentHash, c.thumbnail.bytes),
          store(c.full.contentHash, c.full.bytes),
        ]);
        const ref: PreviewRef = {
          kind: "capture",
          thumbnail: {
            hash: c.thumbnail.contentHash,
            width: c.thumbnail.width,
            height: c.thumbnail.height,
          },
          full: { hash: c.full.contentHash, width: c.full.width, height: c.full.height },
          capturedAt: c.capturedAt,
          source: c.renderer,
        };
        return { ref, renderedText: c.renderedText, finalUrl: c.finalUrl };
      } catch (err) {
        signal.throwIfAborted();
        logger.warn("Preview capture failed", { domain, error: err });
        return undefined;
      }
    };
  }
  const share = options.shareImage;
  if (share) {
    previewer.shareImage = async (imageUrl, signal) => {
      const img = await fetchPreviewImage(imageUrl, {
        resolver: share.resolver,
        signal,
        ...(share.transport ? { transport: share.transport } : {}),
      }).catch(() => undefined);
      if (!img || !isDecodable(img.contentType)) return undefined;
      const webp = await share.encoder.toWebp(img.bytes, img.contentType);
      if (!webp) return undefined;
      const hash = await sha256Hex(webp.bytes);
      await store(hash, webp.bytes);
      return {
        kind: "share-image",
        thumbnail: { hash, width: webp.width, height: webp.height },
        capturedAt: new Date().toISOString(),
        source: "og:image",
      };
    };
  }
  return previewer;
}
