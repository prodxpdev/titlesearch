// Preview images: a site's share image or icon, fetched through safeFetch and
// returned only if it's really a raster image. SVG is refused: it can carry
// script. The URL must come from the probe's own evidence, never from a
// client, so this can't be used as an open proxy.

import type { Resolver } from "./resolver.js";
import { readSafeFetchBody, safeFetch } from "./safe-fetch.js";
import type { Transport } from "./transport.js";

export const PREVIEW_IMAGE_MAX_BYTES = 512 * 1024;

export type PreviewImageType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp"
  | "image/x-icon";

/** Identifies a raster image by its first bytes. The Content-Type header isn't trusted. */
export function sniffImageType(b: Uint8Array): PreviewImageType | undefined {
  const at = (i: number) => b[i] ?? -1;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return "image/gif";
  if (
    at(0) === 0x52 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x46 &&
    at(8) === 0x57 &&
    at(9) === 0x45 &&
    at(10) === 0x42 &&
    at(11) === 0x50
  )
    return "image/webp";
  if (at(0) === 0x00 && at(1) === 0x00 && at(2) === 0x01 && at(3) === 0x00) return "image/x-icon";
  return undefined;
}

export interface PreviewImage {
  bytes: Uint8Array;
  contentType: PreviewImageType;
}

export async function fetchPreviewImage(
  url: string,
  options: { resolver: Resolver; transport?: Transport; signal?: AbortSignal; userAgent?: string },
): Promise<PreviewImage | undefined> {
  const res = await safeFetch(url, {
    resolver: options.resolver,
    accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/x-icon;q=0.9",
    maxBytes: PREVIEW_IMAGE_MAX_BYTES,
    ...(options.transport ? { transport: options.transport } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.userAgent ? { userAgent: options.userAgent } : {}),
  });
  if (res.status !== 200 || res.truncated) return undefined;
  const bytes = readSafeFetchBody(res);
  const contentType = sniffImageType(bytes);
  return contentType ? { bytes, contentType } : undefined;
}
