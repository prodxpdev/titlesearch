// Codec WebAssembly on Workers. Wrangler compiles each imported .wasm file
// into a WebAssembly.Module at deploy time (Workers can't compile WebAssembly
// from bytes at run time).

import jpegDecode from "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm";
import pngDecode from "@jsquash/png/codec/pkg/squoosh_png_bg.wasm";
import webpDecode from "@jsquash/webp/codec/dec/webp_dec.wasm";
import webpEncode from "@jsquash/webp/codec/enc/webp_enc.wasm";
import type { WasmLoader } from "@titlesearch/render/image-codec";

const MODULES = {
  "png-decode": pngDecode,
  "jpeg-decode": jpegDecode,
  "webp-decode": webpDecode,
  "webp-encode": webpEncode,
} as const;

export const workersWasmLoader: WasmLoader = async (file) => MODULES[file];
