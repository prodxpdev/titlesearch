import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Transport } from "@titlesearch/core";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  CHROMIUM_MANIFEST,
  type ChromiumManifest,
  installChromium,
  installedChromium,
} from "../src/chromium-install.js";
import { sha256Hex } from "../src/renderer.js";

const URL_ =
  "https://storage.googleapis.com/chrome-for-testing-public/1.0/test/chrome-headless-shell-test.zip";
let zip: Uint8Array;
let manifest: ChromiumManifest;
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "titlesearch-chromium-"));
  dirs.push(d);
  return d;
};

beforeAll(async () => {
  const src = tmp();
  mkdirSync(join(src, "chrome-headless-shell-test"));
  writeFileSync(
    join(src, "chrome-headless-shell-test", "chrome-headless-shell"),
    "#!/bin/sh\necho fake\n",
  );
  execFileSync("zip", ["-q", "-r", "a.zip", "chrome-headless-shell-test"], { cwd: src });
  zip = new Uint8Array(readFileSync(join(src, "a.zip")));
  manifest = {
    version: "1.0",
    platforms: {
      test: {
        url: URL_,
        sha256: await sha256Hex(zip),
        size: zip.byteLength,
        executable: "chrome-headless-shell-test/chrome-headless-shell",
      },
    },
  };
});

afterEach(() => {
  for (const d of dirs.splice(1)) rmSync(d, { recursive: true, force: true });
});

function serving(bytes: Uint8Array): Transport & { calls: number } {
  const t = {
    pinsAddress: false,
    calls: 0,
    async request() {
      t.calls++;
      return new Response(bytes as Uint8Array<ArrayBuffer>);
    },
  };
  return t;
}

describe("the pinned manifest", () => {
  it("covers every release platform, with a SHA-256 and size", () => {
    expect(Object.keys(CHROMIUM_MANIFEST.platforms).sort()).toEqual(
      ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"].sort(),
    );
    for (const b of Object.values(CHROMIUM_MANIFEST.platforms)) {
      expect(b.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(b.size).toBeGreaterThan(50 * 1024 * 1024);
      expect(new URL(b.url).origin).toBe("https://storage.googleapis.com");
    }
  });
});

describe.skipIf(process.platform === "win32")("installChromium", () => {
  it("downloads, verifies, unpacks, and reuses the install", async () => {
    const dataDir = tmp();
    const t = serving(zip);
    const exe = await installChromium({ dataDir, manifest, platform: "test", transport: t });
    expect(() => accessSync(exe, constants.X_OK)).not.toThrow();
    expect(await installedChromium(dataDir, { manifest, platform: "test" })).toBe(exe);
    await installChromium({ dataDir, manifest, platform: "test", transport: t });
    expect(t.calls).toBe(1);
    expect(existsSync(join(dataDir, "browser", "chrome-headless-shell-1.0", "download.zip"))).toBe(
      false,
    );
  });

  it("refuses a download whose checksum doesn't match, writing nothing", async () => {
    const dataDir = tmp();
    const tampered = zip.slice();
    const i = tampered.length - 5;
    tampered[i] = (tampered[i] ?? 0) ^ 0xff;
    await expect(
      installChromium({ dataDir, manifest, platform: "test", transport: serving(tampered) }),
    ).rejects.toMatchObject({ code: "checksum_mismatch" });
    expect(existsSync(join(dataDir, "browser"))).toBe(false);
  });

  it("refuses a download of the wrong size", async () => {
    const dataDir = tmp();
    await expect(
      installChromium({
        dataDir,
        manifest,
        platform: "test",
        transport: serving(zip.subarray(0, zip.length - 1)),
      }),
    ).rejects.toMatchObject({ code: "checksum_mismatch" });
  });

  it("refuses an unsupported platform", async () => {
    await expect(
      installChromium({ dataDir: tmp(), manifest, platform: "plan9-mips" }),
    ).rejects.toMatchObject({
      code: "unsupported_platform",
    });
  });

  it("cleans up when the archive lacks the executable", async () => {
    const dataDir = tmp();
    const m = {
      ...manifest,
      platforms: {
        test: {
          ...(manifest.platforms.test as ChromiumManifest["platforms"][string]),
          executable: "missing/chrome",
        },
      },
    };
    await expect(
      installChromium({ dataDir, manifest: m, platform: "test", transport: serving(zip) }),
    ).rejects.toMatchObject({
      code: "extract_failed",
    });
    expect(existsSync(join(dataDir, "browser", "chrome-headless-shell-1.0"))).toBe(false);
  });
});
