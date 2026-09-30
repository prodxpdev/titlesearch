import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { MemoryStore } from "@titlesearch/cache";
import { cacheKeys, type Resolver, type Transport } from "@titlesearch/core";
import { beforeAll, describe, expect, it } from "vitest";
import { createWebpEncoder, imageDimensions, MAX_DECODE_PIXELS } from "../src/image-codec.js";
import { createPreviewer, previewImageResponse, WEBP } from "../src/previewer.js";
import type { PreviewCapture, PreviewRenderer } from "../src/renderer.js";
import { nodeWasmLoader } from "../src/wasm-node.js";

const require = createRequire(import.meta.url);
const encoder = createWebpEncoder(nodeWasmLoader);
let PNG: Uint8Array;
let JPEG: Uint8Array;

function pixels(width: number, height: number) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([i % 256, 80, 160, 255], i);
  return { data, width, height, colorSpace: "srgb" } as unknown as ImageData;
}

beforeAll(async () => {
  const png = await import("@jsquash/png/encode.js");
  await (await import("@jsquash/png/decode.js")).init(
    await WebAssembly.compile(
      await readFile(require.resolve("@jsquash/png/codec/pkg/squoosh_png_bg.wasm")),
    ),
  );
  PNG = new Uint8Array(await png.default(pixels(64, 40)));
  const jpeg = await import("@jsquash/jpeg/encode.js");
  await jpeg.init(
    await WebAssembly.compile(
      await readFile(require.resolve("@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm")),
    ),
  );
  JPEG = new Uint8Array(await jpeg.default(pixels(50, 30), { quality: 80 }));
});

const isWebp = (b: Uint8Array) =>
  new TextDecoder().decode(b.subarray(0, 4)) === "RIFF" &&
  new TextDecoder().decode(b.subarray(8, 12)) === "WEBP";

describe("imageDimensions", () => {
  it("reads PNG and JPEG headers", () => {
    expect(imageDimensions(PNG, "image/png")).toEqual({ width: 64, height: 40 });
    expect(imageDimensions(JPEG, "image/jpeg")).toEqual({ width: 50, height: 30 });
  });

  it("returns undefined for a truncated header", () => {
    expect(imageDimensions(PNG.subarray(0, 10), "image/png")).toBeUndefined();
  });
});

describe("createWebpEncoder", () => {
  it.each([
    ["PNG", () => PNG, "image/png", 64, 40],
    ["JPEG", () => JPEG, "image/jpeg", 50, 30],
  ] as const)("re-encodes %s to WebP at the same size", async (_l, get, type, w, h) => {
    const out = await encoder.toWebp(get(), type);
    expect(out && isWebp(out.bytes)).toBe(true);
    expect(out).toMatchObject({ width: w, height: h });
    expect(imageDimensions(out?.bytes ?? new Uint8Array(), "image/webp")).toEqual({
      width: w,
      height: h,
    });
  });

  it("re-encodes WebP to WebP", async () => {
    const first = await encoder.toWebp(PNG, "image/png");
    const second = await encoder.toWebp(first?.bytes ?? new Uint8Array(), "image/webp");
    expect(second).toMatchObject({ width: 64, height: 40 });
  });

  it("refuses a header declaring more than 4 megapixels, without decoding", async () => {
    const bomb = PNG.slice();
    new DataView(bomb.buffer).setUint32(16, 20_000);
    new DataView(bomb.buffer).setUint32(20, 20_000);
    expect(20_000 * 20_000).toBeGreaterThan(MAX_DECODE_PIXELS);
    const t0 = Date.now();
    expect(await encoder.toWebp(bomb, "image/png")).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("refuses a corrupt image", async () => {
    const broken = PNG.slice(0, 40);
    expect(await encoder.toWebp(broken, "image/png")).toBeUndefined();
  });
});

describe("createPreviewer", () => {
  const webp = (fill: number) => {
    const b = new Uint8Array(32).fill(fill);
    b.set(new TextEncoder().encode("RIFF"), 0);
    b.set(new TextEncoder().encode("WEBP"), 8);
    return b;
  };
  const capture = (): PreviewCapture => ({
    full: { bytes: webp(1), contentHash: "a".repeat(64), width: 1280, height: 800, format: "webp" },
    thumbnail: {
      bytes: webp(2),
      contentHash: "b".repeat(64),
      width: 480,
      height: 300,
      format: "webp",
    },
    finalUrl: "https://acme.io/",
    status: 200,
    renderedText: "Acme invoicing",
    capturedAt: "2026-09-30T12:00:00.000Z",
    renderer: "local-chromium",
  });
  const renderer = (impl: () => Promise<PreviewCapture>): PreviewRenderer => ({
    id: "local-chromium",
    capture: impl,
    close: async () => {},
  });
  const signal = () => new AbortController().signal;

  it("stores both captured images and returns a reference", async () => {
    const blobs = new MemoryStore();
    const p = createPreviewer({ blobs, renderer: renderer(async () => capture()) });
    const r = await p.capture?.("acme.io", signal());
    expect(r?.ref).toEqual({
      kind: "capture",
      thumbnail: { hash: "b".repeat(64), width: 480, height: 300 },
      full: { hash: "a".repeat(64), width: 1280, height: 800 },
      capturedAt: "2026-09-30T12:00:00.000Z",
      source: "local-chromium",
    });
    expect((await blobs.getBlob(cacheKeys.previewImage("a".repeat(64))))?.contentType).toBe(WEBP);
    expect(await blobs.getBlob(cacheKeys.previewImage("b".repeat(64)))).toBeDefined();
  });

  it("returns undefined when capture fails", async () => {
    const p = createPreviewer({
      blobs: new MemoryStore(),
      renderer: renderer(async () => {
        throw new Error("crash");
      }),
    });
    expect(await p.capture?.("acme.io", signal())).toBeUndefined();
  });

  it.each([403, 404, 503])("rejects a capture of a %i error page", async (status) => {
    const blobs = new MemoryStore();
    const p = createPreviewer({
      blobs,
      renderer: renderer(async () => ({ ...capture(), status })),
    });
    expect(await p.capture?.("acme.io", signal())).toBeUndefined();
    expect(await blobs.getBlob(cacheKeys.previewImage("a".repeat(64)))).toBeUndefined();
  });

  it("offers no capture when previews are off", () => {
    expect(createPreviewer({ blobs: new MemoryStore() }).capture).toBeUndefined();
  });

  const resolver: Resolver = { resolveHost: async () => ["93.184.215.14"] };
  const serving = (bytes: Uint8Array, type: string): Transport => ({
    pinsAddress: false,
    request: async () =>
      new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { "content-type": type } }),
  });

  it("re-encodes a share image to WebP and stores it", async () => {
    const blobs = new MemoryStore();
    const p = createPreviewer({
      blobs,
      shareImage: { encoder, resolver, transport: serving(PNG, "image/png") },
    });
    const ref = await p.shareImage?.("https://cdn.acme.io/share.png", signal());
    expect(ref).toMatchObject({
      kind: "share-image",
      source: "og:image",
      thumbnail: { width: 64, height: 40 },
    });
    const stored = await blobs.getBlob(cacheKeys.previewImage(ref?.thumbnail.hash ?? ""));
    expect(stored && isWebp(stored.bytes)).toBe(true);
  });

  it.each([
    [
      "an SVG",
      new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"),
      "image/svg+xml",
    ],
    [
      "a GIF (not re-encodable)",
      new TextEncoder().encode("GIF89a\u0001\u0000\u0001\u0000"),
      "image/gif",
    ],
  ])("gives no share image for %s", async (_l, bytes, type) => {
    const p = createPreviewer({
      blobs: new MemoryStore(),
      shareImage: { encoder, resolver, transport: serving(bytes, type) },
    });
    expect(await p.shareImage?.("https://cdn.acme.io/x", signal())).toBeUndefined();
  });

  it("gives no share image for a private host", async () => {
    const p = createPreviewer({
      blobs: new MemoryStore(),
      shareImage: {
        encoder,
        resolver: { resolveHost: async () => ["10.0.0.1"] },
        transport: serving(PNG, "image/png"),
      },
    });
    expect(await p.shareImage?.("https://intranet.acme.io/x.png", signal())).toBeUndefined();
  });
});

describe("previewImageResponse", () => {
  const hash = "c".repeat(64);

  it("serves a stored image with strict headers", async () => {
    const blobs = new MemoryStore();
    await blobs.putBlob(cacheKeys.previewImage(hash), Uint8Array.from([1, 2, 3]), WEBP, 60);
    const res = await previewImageResponse(blobs, hash);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(Uint8Array.from([1, 2, 3]));
  });

  it.each(["../etc/passwd", "C".repeat(64), "abc", ""])("rejects the hash %j", async (h) => {
    expect((await previewImageResponse(new MemoryStore(), h)).status).toBe(400);
  });

  it("returns 404 for a missing image, or one that isn't WebP", async () => {
    const blobs = new MemoryStore();
    expect((await previewImageResponse(blobs, hash)).status).toBe(404);
    await blobs.putBlob(cacheKeys.previewImage(hash), Uint8Array.from([1]), "image/svg+xml", 60);
    expect((await previewImageResponse(blobs, hash)).status).toBe(404);
  });
});
