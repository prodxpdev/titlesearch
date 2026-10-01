// The render service and its client, wired together in-process. The client
// treats the service as untrusted, so most of these are tampering cases.

import { silentLogger } from "@titlesearch/core";
import { describe, expect, it } from "vitest";
import { createRenderService, RemoteRenderer, type WireCapture } from "../src/remote.js";

type Wire = ReturnType<typeof WireCapture.parse>;

import {
  type CapturedImage,
  CaptureError,
  type PreviewCapture,
  type PreviewRenderer,
  sha256Hex,
} from "../src/renderer.js";

const TOKEN = "r".repeat(40);
const ctx = () => ({ signal: new AbortController().signal, logger: silentLogger });

function webp(fill: number): Uint8Array {
  const b = new Uint8Array(64).fill(fill);
  b.set(new TextEncoder().encode("RIFF"), 0);
  b.set(new TextEncoder().encode("WEBP"), 8);
  return b;
}

async function image(bytes: Uint8Array, width: number, height: number): Promise<CapturedImage> {
  return { bytes, contentHash: await sha256Hex(bytes), width, height, format: "webp" };
}

const fakeRenderer = (
  make?: () => Promise<PreviewCapture>,
): PreviewRenderer & { domains: string[] } => {
  const domains: string[] = [];
  return {
    id: "fake",
    domains,
    async capture(domain) {
      domains.push(domain);
      if (make) return make();
      return {
        thumbnail: await image(webp(1), 480, 300),
        full: await image(webp(2), 1280, 800),
        finalUrl: `https://${domain}/`,
        status: 200,
        renderedText: "Invoices for freelancers.",
        capturedAt: "2026-10-01T12:00:00.000Z",
        renderer: "local-chromium",
      };
    },
    async close() {},
  };
};

/** A client whose requests go straight to the service handler, optionally rewritten. */
function client(
  service: (r: Request) => Promise<Response>,
  opts: { token?: string; rewrite?: (body: Wire) => void } = {},
) {
  return new RemoteRenderer({
    url: "https://renderer.internal",
    token: opts.token ?? TOKEN,
    transport: {
      pinsAddress: false,
      async request(url, init) {
        const res = await service(
          new Request(url, { method: init.method, headers: init.headers, body: init.body ?? null }),
        );
        if (!opts.rewrite || !res.ok) return res;
        const body = await res.json();
        opts.rewrite(body);
        return new Response(JSON.stringify(body), { status: res.status });
      },
    },
  });
}

describe("render service and RemoteRenderer", () => {
  it("round-trips a capture, normalizing the domain", async () => {
    const renderer = fakeRenderer();
    const c = await client(createRenderService({ renderer, token: TOKEN })).capture(
      "Acme.IO",
      ctx(),
    );
    expect(renderer.domains).toEqual(["acme.io"]);
    expect(c.thumbnail.contentHash).toBe(await sha256Hex(webp(1)));
    expect(c.full).toMatchObject({ width: 1280, height: 800 });
    expect(c.renderer).toBe("remote:local-chromium");
  });

  it("rejects the wrong token", async () => {
    const service = createRenderService({ renderer: fakeRenderer(), token: TOKEN });
    await expect(
      client(service, { token: "x".repeat(40) }).capture("acme.io", ctx()),
    ).rejects.toBeInstanceOf(CaptureError);
  });

  it("refuses a bad domain before rendering", async () => {
    const renderer = fakeRenderer();
    const service = createRenderService({ renderer, token: TOKEN });
    const res = await service(
      new Request("https://r/capture", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ domain: "http://169.254.169.254/" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(renderer.domains).toEqual([]);
  });

  it("passes capture errors through with their code", async () => {
    const renderer = fakeRenderer(async () => {
      throw new CaptureError("timeout", "Took too long.");
    });
    await expect(
      client(createRenderService({ renderer, token: TOKEN })).capture("a.io", ctx()),
    ).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it.each([
    [
      "a hash that doesn't match the bytes",
      (b: Wire) => {
        b.full.contentHash = "0".repeat(64);
      },
    ],
    [
      "bytes that aren't WebP",
      (b: Wire) => {
        b.thumbnail.bytes = btoa("<svg onload=alert(1)>");
      },
    ],
    [
      "the wrong dimensions",
      (b: Wire) => {
        b.thumbnail.width = 4000;
      },
    ],
    [
      "an extra-long text",
      (b: Wire) => {
        b.renderedText = "x".repeat(30_000);
      },
    ],
  ])("rejects %s from the service", async (_l, rewrite) => {
    const service = createRenderService({ renderer: fakeRenderer(), token: TOKEN });
    await expect(client(service, { rewrite }).capture("acme.io", ctx())).rejects.toBeInstanceOf(
      CaptureError,
    );
  });

  it("allows a plain-HTTP renderer only when listed", () => {
    expect(() => new RemoteRenderer({ url: "http://127.0.0.1:8081", token: TOKEN })).toThrow();
    expect(
      () =>
        new RemoteRenderer({
          url: "http://127.0.0.1:8081",
          token: TOKEN,
          httpOrigins: ["http://127.0.0.1:8081"],
        }),
    ).not.toThrow();
  });
});
