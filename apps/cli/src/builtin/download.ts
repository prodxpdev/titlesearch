// Streams a pinned download to disk, hashing as it writes, so a file of
// several gigabytes never sits in memory. The file only gets its final name
// once its size and SHA-256 match the pin; until then it's "<name>.part". An
// interrupted download resumes from the .part file: what's there is hashed
// first, then the rest is requested with a Range header.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, rename, rm, stat } from "node:fs/promises";
import { createOriginStream, type Transport } from "@titlesearch/core";

export interface Pinned {
  url: string;
  size: number;
  sha256: string;
}

export class DownloadError extends Error {
  override readonly name = "DownloadError";
  constructor(
    readonly code: "download_failed" | "checksum_mismatch" | "stalled",
    message: string,
  ) {
    super(message);
  }
}

export interface DownloadOptions {
  /** Exact origins the URL and its redirects may use. */
  origins: readonly string[];
  /** CDN host suffixes, such as ".hf.co"; safe because the content is pinned. */
  hostSuffixes?: readonly string[];
  /** Called with bytes on disk so far, including a resumed part. */
  onProgress?: (received: number) => void;
  signal?: AbortSignal;
  /** Abort when no bytes arrive for this long. */
  stallMs?: number;
  /** Resume this many times after a dropped connection or a stall. */
  retries?: number;
  transport?: Transport;
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function hashFile(path: string, hash: ReturnType<typeof createHash>): Promise<void> {
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
}

/**
 * Downloads `pin` to `dest`, verified. Resolves once `dest` exists and
 * matches. A dropped connection resumes where it left off, a few times.
 */
export async function downloadPinned(
  pin: Pinned,
  dest: string,
  options: DownloadOptions,
): Promise<void> {
  const retries = options.retries ?? 4;
  for (let attempt = 0; ; attempt++) {
    try {
      return await attemptDownload(pin, dest, options);
    } catch (err) {
      const transient =
        err instanceof DownloadError && (err.code === "download_failed" || err.code === "stalled");
      if (!transient || attempt >= retries || options.signal?.aborted) throw err;
      await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 8000)));
    }
  }
}

async function attemptDownload(pin: Pinned, dest: string, options: DownloadOptions): Promise<void> {
  const part = `${dest}.part`;
  const openStream = createOriginStream({
    origins: options.origins,
    ...(options.hostSuffixes ? { hostSuffixes: options.hostSuffixes } : {}),
    ...(options.transport ? { transport: options.transport } : {}),
  });

  let have = await sizeOf(part);
  if (have > pin.size) {
    await rm(part, { force: true });
    have = 0;
  }
  const hash = createHash("sha256");
  if (have > 0) await hashFile(part, hash);

  const stall = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, stall.signal]) : stall.signal;
  const stallMs = options.stallMs ?? 60_000;
  let timer = setTimeout(() => stall.abort(), stallMs);
  const bump = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stall.abort(), stallMs);
  };

  try {
    if (have < pin.size) {
      let res: Response;
      try {
        res = await openStream(pin.url, {
          signal,
          ...(have > 0 ? { headers: { range: `bytes=${have}-` } } : {}),
        });
      } catch (err) {
        throw new DownloadError("download_failed", `Download failed: ${(err as Error).message}`);
      }
      if (have > 0 && res.status === 200) {
        // The server ignored the range: start over.
        await res.body?.cancel().catch(() => {});
        await rm(part, { force: true });
        return await attemptDownload(pin, dest, options);
      }
      if (!(res.status === 200 || (have > 0 && res.status === 206)) || !res.body) {
        await res.body?.cancel().catch(() => {});
        throw new DownloadError("download_failed", `Download failed: HTTP ${res.status}.`);
      }
      const file = await open(part, have > 0 ? "a" : "w", 0o600);
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          bump();
          if (have + chunk.byteLength > pin.size)
            throw new DownloadError("checksum_mismatch", "The download is larger than expected.");
          hash.update(chunk);
          await file.write(chunk);
          have += chunk.byteLength;
          options.onProgress?.(have);
        }
      } catch (err) {
        if (stall.signal.aborted)
          throw new DownloadError("stalled", "The download stopped making progress.");
        if (err instanceof DownloadError) throw err;
        options.signal?.throwIfAborted();
        throw new DownloadError("download_failed", `Download failed: ${(err as Error).message}`);
      } finally {
        await file.close();
      }
    }
    const digest = hash.digest("hex");
    if (have !== pin.size || digest !== pin.sha256.toLowerCase()) {
      await rm(part, { force: true });
      throw new DownloadError(
        "checksum_mismatch",
        `The download didn't match its pinned checksum (got ${digest}, expected ${pin.sha256}).`,
      );
    }
    await rename(part, dest);
  } finally {
    clearTimeout(timer);
  }
}
