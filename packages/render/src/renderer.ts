// The preview renderer contract (CLAUDE.md, Site previews).

import type { Logger } from "@titlesearch/core";

export interface RenderContext {
  signal: AbortSignal;
  logger: Logger;
}

export interface CapturedImage {
  bytes: Uint8Array;
  /** Hex SHA-256 of the bytes. Images are stored and served by this. */
  contentHash: string;
  width: number;
  height: number;
  format: "webp";
}

export interface PreviewCapture {
  thumbnail: CapturedImage;
  full: CapturedImage;
  finalUrl: string;
  /** The rendered DOM's text. Third-party content: it gets the untrustedSiteText treatment. */
  renderedText: string;
  capturedAt: string;
  renderer: string;
}

export interface PreviewRenderer {
  id: string;
  capture(domain: string, ctx: RenderContext): Promise<PreviewCapture>;
  close(): Promise<void>;
}

export class CaptureError extends Error {
  override readonly name = "CaptureError";
  constructor(
    readonly code: "no_browser" | "navigation_failed" | "timeout" | "browser_crashed" | "busy",
    message: string,
  ) {
    super(message);
  }
}

export const VIEWPORT = { width: 1280, height: 800 } as const;
export const THUMBNAIL = { width: 480, height: 300 } as const;

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
