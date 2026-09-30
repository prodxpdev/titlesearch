// Loads the codec WebAssembly from node_modules, for Node, Bun, and tests.
// The compiled CLI binary supplies its own loader over embedded files.

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { WasmLoader } from "./image-codec.js";

const require = createRequire(import.meta.url);
const FILES = {
  "png-decode": "@jsquash/png/codec/pkg/squoosh_png_bg.wasm",
  "jpeg-decode": "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm",
  "webp-decode": "@jsquash/webp/codec/dec/webp_dec.wasm",
  "webp-encode": "@jsquash/webp/codec/enc/webp_enc.wasm",
} as const;

export const nodeWasmLoader: WasmLoader = async (file) =>
  WebAssembly.compile(await readFile(require.resolve(FILES[file])));
