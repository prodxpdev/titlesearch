// Serving the built web UI. The UI shell holds no data, so it's served
// without auth; everything it loads from /api is authenticated.

export interface UiAsset {
  body: Uint8Array | string;
  contentType: string;
}

/** Looks up a built UI file by path, such as "/index.html" or "/assets/app-1a2b.js". */
export type UiAssets = (path: string) => UiAsset | undefined;

/**
 * The UI's CSP: scripts, styles, fonts, images, and requests from this origin
 * only. Nothing third-party loads in the UI; preview images come from
 * /api/preview (invariant 8).
 */
export const UI_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

const PLACEHOLDER = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Titlesearch</title></head>
<body><p>The Titlesearch web UI isn't built into this binary. The API is at /api and MCP at /mcp.</p></body></html>`;

export function uiResponse(assets: UiAssets | undefined, path: string): Response {
  const headers: Record<string, string> = { "x-content-type-options": "nosniff" };
  const asset = assets?.(path) ?? (path.includes(".") ? undefined : assets?.("/index.html"));
  if (!asset) {
    if (assets && path.includes(".")) return new Response("Not found", { status: 404, headers });
    return new Response(PLACEHOLDER, {
      headers: {
        ...headers,
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": UI_CSP,
      },
    });
  }
  const isHtml = asset.contentType.startsWith("text/html");
  return new Response(asset.body as BodyInit, {
    headers: {
      ...headers,
      "content-type": asset.contentType,
      // Hashed asset names never change content; the HTML shell always revalidates.
      "cache-control": isHtml ? "no-cache" : "public, max-age=31536000, immutable",
      ...(isHtml ? { "content-security-policy": UI_CSP } : {}),
    },
  });
}
