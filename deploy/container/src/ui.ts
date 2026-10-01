// Serves the built web UI from a directory in the image.

import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
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
};

export function directoryUi(dir: string): UiAssets | undefined {
  const root = resolve(dir);
  if (!existsSync(join(root, "index.html"))) return undefined;
  const cache = new Map<string, { body: Uint8Array; contentType: string } | undefined>();
  return (path) => {
    if (cache.has(path)) return cache.get(path);
    const file = normalize(join(root, path));
    let asset: { body: Uint8Array; contentType: string } | undefined;
    // No escaping the UI directory.
    if (file.startsWith(`${root}/`) && existsSync(file)) {
      try {
        asset = {
          body: new Uint8Array(readFileSync(file)),
          contentType: TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
        };
      } catch {
        asset = undefined;
      }
    }
    cache.set(path, asset);
    return asset;
  };
}
