// The image codecs load as Wrangler-compiled WebAssembly modules and run in
// workerd: a PNG share image re-encodes to WebP.

import { createWebpEncoder } from "@titlesearch/render/image-codec";
import { describe, expect, it } from "vitest";
import { workersWasmLoader } from "../src/wasm.js";

// A 2x2 opaque PNG.
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAwMDAwMDAAAAQ/AL/mFlBOQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

describe("codecs on Workers", () => {
  it("re-encodes a PNG to WebP", async () => {
    const out = await createWebpEncoder(workersWasmLoader).toWebp(PNG, "image/png");
    expect(out).toMatchObject({ width: 2, height: 2 });
    const tag = (o: number) => String.fromCharCode(...(out?.bytes.subarray(o, o + 4) ?? []));
    expect([tag(0), tag(8)]).toEqual(["RIFF", "WEBP"]);
  });
});
