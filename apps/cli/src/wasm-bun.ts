// Codec WebAssembly for the compiled binary. Under Bun, `with { type: "file" }`
// makes `bun build --compile` embed each file and gives its path at runtime.
// Only imported when running on Bun.

import { readFile } from "node:fs/promises";
import jpegDecode from "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm" with { type: "file" };
import pngDecode from "@jsquash/png/codec/pkg/squoosh_png_bg.wasm" with { type: "file" };
import webpDecode from "@jsquash/webp/codec/dec/webp_dec.wasm" with { type: "file" };
import webpEncode from "@jsquash/webp/codec/enc/webp_enc.wasm" with { type: "file" };
import type { WasmLoader } from "@titlesearch/render";

const PATHS = {
  "png-decode": pngDecode,
  "jpeg-decode": jpegDecode,
  "webp-decode": webpDecode,
  "webp-encode": webpEncode,
} as const;

// Embedded files are readable through node:fs in a compiled Bun binary.
export const bunWasmLoader: WasmLoader = async (file) =>
  WebAssembly.compile(await readFile(PATHS[file]));
