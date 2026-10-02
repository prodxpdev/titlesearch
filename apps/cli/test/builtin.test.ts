// The built-in model: the verified, resumable download, and the llama.cpp
// server's lifecycle (with a stand-in server, so no model is loaded).

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinModel, DEFAULT_BUILTIN_MODEL } from "@titlesearch/assess";
import { createOriginFetch, type Transport } from "@titlesearch/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { downloadPinned } from "../src/builtin/download.js";
import { LLAMA_BUILDS, LLAMA_RELEASE } from "../src/builtin/llama.js";
import { BuiltinManager } from "../src/builtin/manager.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "titlesearch-builtin-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const bytes = new TextEncoder().encode("pinned weights ".repeat(1000));
const pin = {
  url: "https://huggingface.co/o/r/resolve/abc/model.gguf",
  size: bytes.byteLength,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
const origins = { origins: ["https://huggingface.co"], hostSuffixes: [".hf.co"] };

/** Serves `body` through a CDN redirect, honoring Range unless told not to. */
function cdn(body: Uint8Array, options: { ignoreRange?: boolean } = {}) {
  const ranges: (string | null)[] = [];
  const transport: Transport = {
    pinsAddress: false,
    async request(url, init) {
      if (url.hostname === "huggingface.co")
        return new Response(null, {
          status: 302,
          headers: { location: "https://us.aws.cdn.hf.co/x?sig=1" },
        });
      const range = init.headers.get("range");
      ranges.push(range);
      const from = range && !options.ignoreRange ? Number(/bytes=(\d+)-/.exec(range)?.[1]) : 0;
      return new Response(body.slice(from), { status: from ? 206 : 200 });
    },
  };
  return { transport, ranges };
}

describe("downloadPinned", () => {
  it("streams to disk, verifies, and only then takes the final name", async () => {
    const dest = join(dir, "model.gguf");
    const seen: number[] = [];
    await downloadPinned(pin, dest, {
      ...origins,
      transport: cdn(bytes).transport,
      onProgress: (n) => seen.push(n),
    });
    expect(new Uint8Array(await readFile(dest))).toEqual(bytes);
    expect(existsSync(`${dest}.part`)).toBe(false);
    expect(seen.at(-1)).toBe(bytes.byteLength);
  });

  it("keeps nothing that doesn't match the pin", async () => {
    const dest = join(dir, "model.gguf");
    const tampered = bytes.slice();
    tampered[10] = 0;
    await expect(
      downloadPinned(pin, dest, { ...origins, transport: cdn(tampered).transport }),
    ).rejects.toMatchObject({ code: "checksum_mismatch" });
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it("refuses a body larger than the pin", async () => {
    const big = new Uint8Array(bytes.byteLength + 10);
    await expect(
      downloadPinned(pin, join(dir, "m"), { ...origins, transport: cdn(big).transport }),
    ).rejects.toMatchObject({ code: "checksum_mismatch" });
  });

  it("resumes from a partial file with a Range request", async () => {
    const dest = join(dir, "model.gguf");
    await writeFile(`${dest}.part`, bytes.slice(0, 4000));
    const { transport, ranges } = cdn(bytes);
    await downloadPinned(pin, dest, { ...origins, transport });
    expect(ranges).toEqual(["bytes=4000-"]);
    expect(new Uint8Array(await readFile(dest))).toEqual(bytes);
  });

  it("starts over when the server ignores the range", async () => {
    const dest = join(dir, "model.gguf");
    await writeFile(`${dest}.part`, bytes.slice(0, 4000));
    const { transport, ranges } = cdn(bytes, { ignoreRange: true });
    await downloadPinned(pin, dest, { ...origins, transport });
    expect(ranges).toEqual(["bytes=4000-", null]);
    expect(new Uint8Array(await readFile(dest))).toEqual(bytes);
  });

  it("resumes by itself after a dropped connection", async () => {
    const dest = join(dir, "model.gguf");
    let calls = 0;
    const ranges: (string | null)[] = [];
    const transport: Transport = {
      pinsAddress: false,
      async request(_url, init) {
        calls++;
        ranges.push(init.headers.get("range"));
        if (calls === 1) {
          // Half the file, then the socket closes.
          const half = bytes.slice(0, 6000);
          let pulls = 0;
          const body = new ReadableStream<Uint8Array>({
            pull(c) {
              if (pulls++ === 0) c.enqueue(half);
              else c.error(new TypeError("The socket connection was closed unexpectedly."));
            },
          });
          return new Response(body, { status: 200 });
        }
        const from = Number(/bytes=(\d+)-/.exec(init.headers.get("range") ?? "")?.[1] ?? 0);
        return new Response(bytes.slice(from), { status: from ? 206 : 200 });
      },
    };
    await downloadPinned(pin, dest, { ...origins, transport, retries: 1 });
    expect(ranges).toEqual([null, "bytes=6000-"]);
    expect(new Uint8Array(await readFile(dest))).toEqual(bytes);
  });

  it("follows redirects only to the allowed hosts", async () => {
    const transport: Transport = {
      pinsAddress: false,
      async request() {
        return new Response(null, { status: 302, headers: { location: "https://evil.example/x" } });
      },
    };
    await expect(
      downloadPinned(pin, join(dir, "m"), { ...origins, transport, retries: 0 }),
    ).rejects.toMatchObject({ code: "download_failed" });
  });
});

describe("the llama.cpp pins", () => {
  it("cover every platform the app ships for, from the pinned release", () => {
    expect(Object.keys(LLAMA_BUILDS).sort()).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "win32-x64",
    ]);
    for (const b of Object.values(LLAMA_BUILDS)) {
      expect(b.url).toContain(`/releases/download/${LLAMA_RELEASE}/`);
      expect(b.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

// A stand-in llama-server: answers /health and chat completions, and only
// with the key it was started with.
const FAKE_SERVER = `#!/usr/bin/env node
const http = require("node:http");
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
if (args[args.indexOf("--host") + 1] !== "127.0.0.1") process.exit(3);
const key = process.env.LLAMA_API_KEY;
if (!key || args.includes(key)) process.exit(4);
http.createServer((req, res) => {
  if (req.url === "/health") { res.end("{}"); return; }
  if (req.headers.authorization !== "Bearer " + key) { res.statusCode = 401; res.end(); return; }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ choices: [{ message: { content: '{"answer":"hi"}' }, finish_reason: "stop" }] }));
}).listen(port, "127.0.0.1");
`;

async function fakeInstall(dataDir: string, script = FAKE_SERVER) {
  const llama = join(dataDir, "llama", LLAMA_RELEASE, "llama-b11327");
  await mkdir(llama, { recursive: true });
  await writeFile(join(llama, "llama-server"), script);
  await chmod(join(llama, "llama-server"), 0o755);
  await writeFile(join(dataDir, "llama", LLAMA_RELEASE, ".verified"), "x\n");
  const model = builtinModel(DEFAULT_BUILTIN_MODEL);
  await mkdir(join(dataDir, "models"), { recursive: true });
  await writeFile(join(dataDir, "models", model?.file ?? ""), "weights");
}

const local = (baseUrl: string) =>
  createOriginFetch({ origins: [], httpOrigins: [baseUrl], timeoutMs: 2000 });

describe.skipIf(process.platform === "win32")("BuiltinManager", () => {
  it("says what's missing before anything is downloaded", () => {
    const m = new BuiltinManager({ dataDir: dir, platform: "darwin-arm64" });
    expect(m.unavailable(DEFAULT_BUILTIN_MODEL)).toBe("Download Qwen3 4B Instruct first.");
    expect(m.status().models.map((s) => s.state)).toEqual([
      "not_installed",
      "not_installed",
      "not_installed",
    ]);
    const other = new BuiltinManager({ dataDir: dir, platform: "freebsd-x64" });
    expect(other.status().supported).toBe(false);
    expect(other.unavailable(DEFAULT_BUILTIN_MODEL)).toMatch(/isn't available for freebsd-x64/);
  });

  it("starts the server once, on loopback, with a key it alone knows", async () => {
    await fakeInstall(dir);
    const m = new BuiltinManager({ dataDir: dir, platform: "darwin-arm64" });
    try {
      expect(m.unavailable(DEFAULT_BUILTIN_MODEL)).toBeUndefined();
      const [a, b] = await Promise.all([
        m.start(DEFAULT_BUILTIN_MODEL),
        m.start(DEFAULT_BUILTIN_MODEL),
      ]);
      expect(a).toEqual(b);
      expect(a.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(a.apiKey).toMatch(/^[0-9a-f]{64}$/);
      const res = await local(a.baseUrl)(`${a.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${a.apiKey}` },
        body: "{}",
      });
      expect(res.status).toBe(200);
      expect(
        (await local(a.baseUrl)(`${a.baseUrl}/v1/chat/completions`, { method: "POST" })).status,
      ).toBe(401);
    } finally {
      await m.close();
    }
  });

  it("reports a server that exits instead of starting", async () => {
    await fakeInstall(dir, "#!/bin/sh\necho 'failed to load model' >&2\nexit 1\n");
    const m = new BuiltinManager({ dataDir: dir, platform: "darwin-arm64" });
    await expect(m.start(DEFAULT_BUILTIN_MODEL)).rejects.toThrow(
      /llama-server exited \(1\): failed to load model/,
    );
  });

  it("removes a model's weights, stopping it first", async () => {
    await fakeInstall(dir);
    const m = new BuiltinManager({ dataDir: dir, platform: "darwin-arm64" });
    const { baseUrl } = await m.start(DEFAULT_BUILTIN_MODEL);
    await m.remove(DEFAULT_BUILTIN_MODEL);
    expect(m.unavailable(DEFAULT_BUILTIN_MODEL)).toMatch(/Download/);
    await new Promise((r) => setTimeout(r, 200));
    await expect(local(baseUrl)(`${baseUrl}/health`)).rejects.toThrow();
  });
});
