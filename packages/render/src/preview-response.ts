// Serving stored preview images. Separate from the rest of the package so the
// runtime-agnostic server (which also runs on Workers) can import it without
// the Node-only renderer.

import { type BlobStore, cacheKeys, TTL } from "@titlesearch/core";

export const WEBP = "image/webp";

const HASH = /^[0-9a-f]{64}$/;

/**
 * Serves a stored preview image by content hash. Only WebP is ever stored, and
 * the headers keep a browser from treating it as anything else.
 */
export async function previewImageResponse(blobs: BlobStore, hash: string): Promise<Response> {
  const headers = {
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
  };
  if (!HASH.test(hash)) return new Response(null, { status: 400, headers });
  const blob = await blobs.getBlob(cacheKeys.previewImage(hash));
  if (!blob || blob.contentType !== WEBP) return new Response(null, { status: 404, headers });
  // The hash is of the content, so a cached copy never goes stale.
  return new Response(blob.bytes as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: {
      ...headers,
      "content-type": WEBP,
      "content-length": String(blob.bytes.byteLength),
      "cache-control": `private, max-age=${TTL.presence}, immutable`,
    },
  });
}
