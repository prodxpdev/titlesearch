// Pins a Chrome for Testing build of chrome-headless-shell for the preview
// renderer's one-time download. Chrome for Testing publishes no checksums, so
// this downloads each platform's archive and records its SHA-256 and size.
//
//   node tools/pin-chromium.mjs [version]     (default: current Stable)
//
// Writes packages/render/src/chromium-manifest.json. Review and commit it.

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Chrome for Testing platform → Titlesearch release platform (CLAUDE.md, release binaries).
const PLATFORMS = {
  "mac-arm64": "darwin-arm64",
  "mac-x64": "darwin-x64",
  linux64: "linux-x64",
  "linux-arm64": "linux-arm64",
  win64: "win32-x64",
};

const index = await (
  await fetch(
    "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json",
  )
).json();
const version = process.argv[2] ?? index.channels.Stable.version;
const base = `https://storage.googleapis.com/chrome-for-testing-public/${version}`;

const platforms = {};
for (const [cft, ours] of Object.entries(PLATFORMS)) {
  const url = `${base}/${cft}/chrome-headless-shell-${cft}.zip`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of res.body) {
    hash.update(chunk);
    size += chunk.length;
  }
  const exe = cft.startsWith("win") ? "chrome-headless-shell.exe" : "chrome-headless-shell";
  platforms[ours] = {
    url,
    sha256: hash.digest("hex"),
    size,
    executable: `chrome-headless-shell-${cft}/${exe}`,
  };
  process.stdout.write(`${ours}: ${(size / 1048576).toFixed(1)} MB ${platforms[ours].sha256}\n`);
}

const manifest = {
  source: "chrome-for-testing",
  artifact: "chrome-headless-shell",
  version,
  pinnedAt: new Date().toISOString().slice(0, 10),
  platforms,
};
writeFileSync(
  join(root, "packages/render/src/chromium-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
