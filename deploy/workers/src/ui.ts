// The web UI, embedded in the Worker by scripts/embed-ui.mjs.

import type { UiAssets } from "@titlesearch/server";
import { uiFiles } from "./ui-assets.gen.js";

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  woff2: "font/woff2",
  woff: "font/woff",
  png: "image/png",
  ico: "image/x-icon",
  json: "application/json",
};

export function uiFromFiles(files: Record<string, string> = uiFiles): UiAssets | undefined {
  if (!files["/index.html"]) return undefined;
  const decoded = new Map<string, Uint8Array>();
  return (path) => {
    const b64 = Object.hasOwn(files, path) ? files[path] : undefined;
    if (b64 === undefined) return undefined;
    let body = decoded.get(path);
    if (!body) {
      body = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      decoded.set(path, body);
    }
    const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    return { body, contentType: TYPES[ext] ?? "application/octet-stream" };
  };
}
