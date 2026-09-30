// The built web UI, for `serve`. A compiled binary embeds it through the
// generated ui-assets.gen.ts (scripts/embed-ui.mjs); from source, it's read
// from apps/web/dist. Without either, the server shows a placeholder page.

import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { UiAssets } from "@titlesearch/server";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

export function contentTypeFor(path: string): string {
  return TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function fromDirectory(dir: string): UiAssets {
  return (path) => {
    const file = normalize(join(dir, path));
    // No escaping the dist directory.
    if (!file.startsWith(dir) || !existsSync(file)) return undefined;
    try {
      return { body: new Uint8Array(readFileSync(file)), contentType: contentTypeFor(file) };
    } catch {
      return undefined;
    }
  };
}

export async function loadUiAssets(): Promise<UiAssets | undefined> {
  try {
    const embedded = await import("./ui-assets.gen.js");
    if (embedded.uiAssets) return embedded.uiAssets as UiAssets;
  } catch {
    // Not generated: running from source.
  }
  const dist = join(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  return existsSync(join(dist, "index.html")) ? fromDirectory(dist) : undefined;
}
