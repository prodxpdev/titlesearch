// Downloads a pinned artifact from a fixed origin and returns it only if its
// size and SHA-256 match. Used for the renderer's one-time Chromium download.

import { createOriginFetch } from "./origin-fetch.js";
import type { Transport } from "./transport.js";

export class VerificationError extends Error {
  override readonly name = "VerificationError";
  constructor(
    readonly code: "download_failed" | "checksum_mismatch",
    message: string,
  ) {
    super(message);
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function fetchVerified(
  url: string,
  expected: { sha256: string; size: number },
  options: { transport?: Transport; timeoutMs?: number } = {},
): Promise<Uint8Array> {
  const download = createOriginFetch({
    origins: [new URL(url).origin],
    maxBytes: expected.size + 1,
    timeoutMs: options.timeoutMs ?? 15 * 60 * 1000,
    ...(options.transport ? { transport: options.transport } : {}),
  });
  let bytes: Uint8Array;
  try {
    const res = await download(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    throw new VerificationError("download_failed", `Download failed: ${(err as Error).message}`);
  }
  const digest = await sha256Hex(bytes);
  if (bytes.byteLength !== expected.size || digest !== expected.sha256.toLowerCase()) {
    throw new VerificationError(
      "checksum_mismatch",
      `The download didn't match its pinned checksum (got ${digest}, expected ${expected.sha256}).`,
    );
  }
  return bytes;
}
