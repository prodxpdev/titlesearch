// Re-encoding share images to WebP (CLAUDE.md, Site previews: Fallback).
// Dimensions are read from the file header and checked before anything is
// decoded, so a small file that declares enormous dimensions (a decompression
// bomb) never reaches the decoder. Only PNG, JPEG, and WebP are accepted.

import type { PreviewImageType } from "@titlesearch/core";

export const MAX_DECODE_PIXELS = 4_000_000;

export type DecodableType = "image/png" | "image/jpeg" | "image/webp";

export function isDecodable(type: PreviewImageType): type is DecodableType {
  return type === "image/png" || type === "image/jpeg" || type === "image/webp";
}

/** Reads width and height from a PNG, JPEG, or WebP header without decoding. */
export function imageDimensions(
  b: Uint8Array,
  type: DecodableType,
): { width: number; height: number } | undefined {
  const at = (i: number) => b[i] ?? 0;
  const u16be = (i: number) => (at(i) << 8) | at(i + 1);
  const u32be = (i: number) =>
    ((at(i) << 24) >>> 0) + (at(i + 1) << 16) + (at(i + 2) << 8) + at(i + 3);
  if (type === "image/png") {
    if (b.length < 24 || String.fromCharCode(at(12), at(13), at(14), at(15)) !== "IHDR")
      return undefined;
    return { width: u32be(16), height: u32be(20) };
  }
  if (type === "image/jpeg") {
    let i = 2;
    while (i + 9 < b.length) {
      if (at(i) !== 0xff) return undefined;
      const marker = at(i + 1);
      const len = u16be(i + 2);
      // SOF0-SOF15, except DHT (C4), JPG (C8), and DAC (CC).
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return { height: u16be(i + 5), width: u16be(i + 7) };
      }
      if (len < 2) return undefined;
      i += 2 + len;
    }
    return undefined;
  }
  const chunk = String.fromCharCode(at(12), at(13), at(14), at(15));
  if (chunk === "VP8 ")
    return { width: (at(26) | (at(27) << 8)) & 0x3fff, height: (at(28) | (at(29) << 8)) & 0x3fff };
  if (chunk === "VP8L") {
    return {
      width: 1 + (((at(22) & 0x3f) << 8) | at(21)),
      height: 1 + (((at(24) & 0x0f) << 10) | (at(23) << 2) | ((at(22) & 0xc0) >> 6)),
    };
  }
  if (chunk === "VP8X") {
    return {
      width: 1 + (at(24) | (at(25) << 8) | (at(26) << 16)),
      height: 1 + (at(27) | (at(28) << 8) | (at(29) << 16)),
    };
  }
  return undefined;
}

/** Loads a codec's WebAssembly module. The CLI's compiled binary embeds these files. */
export type WasmLoader = (
  file: "png-decode" | "jpeg-decode" | "webp-decode" | "webp-encode",
) => Promise<WebAssembly.Module>;

export interface WebpEncoder {
  /** Re-encodes to WebP. Undefined if the image can't be decoded or is too large. */
  toWebp(
    bytes: Uint8Array,
    type: DecodableType,
  ): Promise<{ bytes: Uint8Array; width: number; height: number } | undefined>;
}

export function createWebpEncoder(load: WasmLoader): WebpEncoder {
  let ready: Promise<{
    decode: Record<
      DecodableType,
      (b: ArrayBuffer) => Promise<{ width: number; height: number; data: Uint8ClampedArray }>
    >;
    encode: (
      img: { width: number; height: number; data: Uint8ClampedArray },
      opts: { quality: number },
    ) => Promise<ArrayBuffer>;
  }>;
  const init = () => {
    ready ??= (async () => {
      const [png, jpeg, webpDec, webpEnc] = await Promise.all([
        import("@jsquash/png/decode.js"),
        import("@jsquash/jpeg/decode.js"),
        import("@jsquash/webp/decode.js"),
        import("@jsquash/webp/encode.js"),
      ]);
      await Promise.all([
        png.init(await load("png-decode")),
        jpeg.init(await load("jpeg-decode")),
        webpDec.init(await load("webp-decode")),
        webpEnc.init(await load("webp-encode")),
      ]);
      return {
        decode: {
          "image/png": (b) => png.default(b),
          "image/jpeg": (b) => jpeg.default(b),
          "image/webp": (b) => webpDec.default(b),
        },
        encode: (img, opts) => webpEnc.default(img as Parameters<typeof webpEnc.default>[0], opts),
      };
    })();
    return ready;
  };

  return {
    async toWebp(bytes, type) {
      const dims = imageDimensions(bytes, type);
      if (
        !dims ||
        dims.width < 1 ||
        dims.height < 1 ||
        dims.width * dims.height > MAX_DECODE_PIXELS
      )
        return undefined;
      const codec = await init();
      try {
        const buf = bytes.slice().buffer as ArrayBuffer;
        const img = await codec.decode[type](buf);
        if (img.width !== dims.width || img.height !== dims.height) return undefined;
        const out = new Uint8Array(await codec.encode(img, { quality: 80 }));
        return { bytes: out, width: img.width, height: img.height };
      } catch {
        return undefined;
      }
    },
  };
}
