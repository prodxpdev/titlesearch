import { describe, expect, it } from "vitest";
import { fetchPreviewImage, sniffImageType } from "../src/net/image.js";
import { fakeResolver, fakeTransport, PUBLIC_V4, refusingTransport } from "./stubs.js";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const WEBP = new TextEncoder().encode("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ");
const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);
const HTML = new TextEncoder().encode("<!doctype html><title>x</title>");

describe("sniffImageType", () => {
  it.each([
    ["PNG", PNG, "image/png"],
    ["JPEG", JPEG, "image/jpeg"],
    ["WebP", WEBP, "image/webp"],
    ["GIF", new TextEncoder().encode("GIF89a"), "image/gif"],
    ["ICO", Uint8Array.from([0, 0, 1, 0, 1, 0]), "image/x-icon"],
    ["SVG", SVG, undefined],
    ["HTML", HTML, undefined],
    ["empty", new Uint8Array(0), undefined],
  ])("%s → %s", (_label, bytes, expected) => {
    expect(sniffImageType(bytes)).toBe(expected);
  });
});

describe("fetchPreviewImage", () => {
  const resolver = fakeResolver({ "cdn.acme.io": [PUBLIC_V4], "internal.acme.io": ["10.0.0.5"] });
  const serve = (bytes: Uint8Array, contentType: string, status = 200) =>
    fakeTransport(
      () =>
        new Response(bytes as Uint8Array<ArrayBuffer>, {
          status,
          headers: { "content-type": contentType },
        }),
    );

  it("returns a real image with its sniffed type", async () => {
    const img = await fetchPreviewImage("https://cdn.acme.io/share.png", {
      resolver,
      transport: serve(PNG, "image/png"),
    });
    expect(img?.contentType).toBe("image/png");
    expect(img?.bytes).toEqual(PNG);
  });

  it("trusts the bytes, not the Content-Type", async () => {
    const img = await fetchPreviewImage("https://cdn.acme.io/x", {
      resolver,
      transport: serve(JPEG, "text/html"),
    });
    expect(img?.contentType).toBe("image/jpeg");
  });

  it.each([
    ["SVG, even labeled as PNG", SVG, "image/png"],
    ["HTML", HTML, "text/html"],
  ])("refuses %s", async (_label, bytes, type) => {
    expect(
      await fetchPreviewImage("https://cdn.acme.io/x", { resolver, transport: serve(bytes, type) }),
    ).toBeUndefined();
  });

  it("refuses a non-200 response", async () => {
    expect(
      await fetchPreviewImage("https://cdn.acme.io/x", {
        resolver,
        transport: serve(PNG, "image/png", 404),
      }),
    ).toBeUndefined();
  });

  it("refuses an image over 512 KB", async () => {
    const big = new Uint8Array(600 * 1024);
    big.set(PNG);
    expect(
      await fetchPreviewImage("https://cdn.acme.io/x", {
        resolver,
        transport: serve(big, "image/png"),
      }),
    ).toBeUndefined();
  });

  it("applies the SSRF rules to image hosts", async () => {
    await expect(
      fetchPreviewImage("https://internal.acme.io/x.png", {
        resolver,
        transport: refusingTransport(),
      }),
    ).rejects.toMatchObject({ code: "blocked_address" });
  });
});
