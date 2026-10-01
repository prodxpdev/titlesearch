// The renderer as a separate service (CLAUDE.md, Site previews: "In the
// container image, the renderer runs as a separate service or sidecar with its
// own egress policy"). The renderer holds no credentials and can't reach the
// cache. The API process sends it a domain and gets the capture back.
//
// - createRenderService: the renderer side, a fetch handler around any
//   PreviewRenderer. It requires a shared bearer token and accepts only a
//   normalized domain.
// - RemoteRenderer: the API side. It treats the service as untrusted: every
//   image is re-hashed, size-checked, and must be a WebP of the expected
//   dimensions before it can be stored and served from our origin.
//
// See docs/decisions/0020-container-deploy.md.

import {
  createOriginFetch,
  normalizeDomain,
  type OriginFetch,
  type Transport,
} from "@titlesearch/core";
import * as z from "zod";
import {
  type CapturedImage,
  CaptureError,
  type PreviewCapture,
  type PreviewRenderer,
  type RenderContext,
  sha256Hex,
  THUMBNAIL,
  VIEWPORT,
} from "./renderer.js";

const MAX_IMAGE_BYTES = 1024 * 1024;
const MAX_TEXT = 20_000;

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const WireImage = z.object({
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  width: z.number().int(),
  height: z.number().int(),
  format: z.literal("webp"),
  bytes: z.string().max(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4),
});

export const WireCapture = z.object({
  thumbnail: WireImage,
  full: WireImage,
  finalUrl: z.string().url().max(2048),
  status: z.number().int().min(100).max(599).optional(),
  renderedText: z.string().max(MAX_TEXT),
  capturedAt: z.string().datetime(),
  renderer: z.string().max(100),
});

const WireError = z.object({
  error: z.object({
    code: z.enum(["no_browser", "navigation_failed", "timeout", "browser_crashed", "busy"]),
    message: z.string().max(500),
  }),
});

const encodeImage = (i: CapturedImage) => ({
  contentHash: i.contentHash,
  width: i.width,
  height: i.height,
  format: i.format,
  bytes: toBase64(i.bytes),
});

export interface RenderServiceOptions {
  renderer: PreviewRenderer;
  /** Shared with the API. At least 32 characters. */
  token: string;
  logger?: RenderContext["logger"];
  /** Per-capture deadline. */
  timeoutMs?: number;
}

/** The renderer side: POST /capture {"domain": "..."} with the shared bearer token. */
export function createRenderService(
  options: RenderServiceOptions,
): (request: Request) => Promise<Response> {
  if (options.token.length < 32)
    throw new Error("The renderer token must be at least 32 characters.");
  const logger = options.logger ?? { error() {}, warn() {}, info() {}, debug() {} };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });

  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/healthz" && request.method === "GET") return json({ ok: true });
    if (url.pathname !== "/capture" || request.method !== "POST")
      return json({ error: { code: "not_found", message: "Not found." } }, 404);
    const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!bearer || !timingSafeEqual(bearer, options.token))
      return json({ error: { code: "unauthenticated", message: "Unauthenticated." } }, 401);

    let domain: string;
    try {
      const body = z
        .object({ domain: z.string().min(1).max(253) })
        .strict()
        .parse(await request.json());
      domain = normalizeDomain(body.domain);
    } catch {
      return json({ error: { code: "invalid_request", message: "Give a domain." } }, 400);
    }

    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(options.timeoutMs ?? 20_000),
    ]);
    try {
      const c = await options.renderer.capture(domain, { signal, logger });
      return json({
        thumbnail: encodeImage(c.thumbnail),
        full: encodeImage(c.full),
        finalUrl: c.finalUrl,
        ...(c.status !== undefined ? { status: c.status } : {}),
        renderedText: c.renderedText.slice(0, MAX_TEXT),
        capturedAt: c.capturedAt,
        renderer: c.renderer,
      });
    } catch (err) {
      if (err instanceof CaptureError)
        return json({ error: { code: err.code, message: err.message } }, 422);
      logger.warn("Capture failed", { error: err });
      return json({ error: { code: "browser_crashed", message: "The capture failed." } }, 500);
    }
  };
}

export interface RemoteRendererOptions {
  /** The render service's base URL. HTTPS, or HTTP when listed in `httpOrigins`. */
  url: string;
  token: string;
  /** Plain-HTTP origins allowed, such as a sidecar on http://127.0.0.1:8081. */
  httpOrigins?: readonly string[];
  transport?: Transport;
  timeoutMs?: number;
}

/** True when the bytes are a RIFF WebP container. */
function isWebp(bytes: Uint8Array): boolean {
  const tag = (o: number) => String.fromCharCode(...bytes.subarray(o, o + 4));
  return bytes.length > 12 && tag(0) === "RIFF" && tag(8) === "WEBP";
}

async function checkImage(
  wire: z.infer<typeof WireImage>,
  expected: { width: number; height: number },
): Promise<CapturedImage> {
  const bytes = fromBase64(wire.bytes);
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES)
    throw new CaptureError("browser_crashed", "The renderer sent an image of the wrong size.");
  if (!isWebp(bytes))
    throw new CaptureError("browser_crashed", "The renderer sent a non-WebP image.");
  if (wire.width !== expected.width || wire.height !== expected.height)
    throw new CaptureError("browser_crashed", "The renderer sent the wrong dimensions.");
  // Never trust the sender's hash: images are stored and served by it.
  const contentHash = await sha256Hex(bytes);
  if (contentHash !== wire.contentHash)
    throw new CaptureError("browser_crashed", "The renderer's image hash didn't match.");
  return { bytes, contentHash, width: wire.width, height: wire.height, format: "webp" };
}

/** The API side: a PreviewRenderer that asks the render service. */
export class RemoteRenderer implements PreviewRenderer {
  readonly id = "remote";
  readonly #fetch: OriginFetch;
  readonly #url: string;
  readonly #token: string;

  constructor(options: RemoteRendererOptions) {
    const u = new URL(options.url);
    const http = u.protocol === "http:";
    if (http && !(options.httpOrigins ?? []).includes(u.origin))
      throw new Error("A plain-HTTP renderer URL must be listed in httpOrigins.");
    this.#fetch = createOriginFetch({
      origins: http ? [] : [u.origin],
      ...(http ? { httpOrigins: [u.origin] } : {}),
      timeoutMs: options.timeoutMs ?? 25_000,
      maxBytes: 4 * 1024 * 1024,
      ...(options.transport ? { transport: options.transport } : {}),
    });
    this.#url = `${u.origin}/capture`;
    this.#token = options.token;
  }

  async capture(domain: string, ctx: RenderContext): Promise<PreviewCapture> {
    let res: Response;
    try {
      res = await this.#fetch(this.#url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.#token}` },
        body: JSON.stringify({ domain }),
        signal: ctx.signal,
      });
    } catch (err) {
      ctx.signal.throwIfAborted();
      throw new CaptureError(
        "no_browser",
        `The renderer service didn't respond: ${(err as Error).message}`,
      );
    }
    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      const e = WireError.safeParse(body);
      if (e.success) throw new CaptureError(e.data.error.code, e.data.error.message);
      throw new CaptureError(
        "browser_crashed",
        `The renderer service returned HTTP ${res.status}.`,
      );
    }
    const parsed = WireCapture.safeParse(body);
    if (!parsed.success)
      throw new CaptureError("browser_crashed", "The renderer's answer failed validation.");
    const c = parsed.data;
    return {
      thumbnail: await checkImage(c.thumbnail, THUMBNAIL),
      full: await checkImage(c.full, VIEWPORT),
      finalUrl: c.finalUrl,
      status: c.status,
      renderedText: c.renderedText,
      capturedAt: c.capturedAt,
      renderer: `remote:${c.renderer}`,
    };
  }

  async close(): Promise<void> {}
}
