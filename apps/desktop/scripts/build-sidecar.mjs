// Builds the titlesearch binary as the app's sidecar (bundle.externalBin):
// the web UI embedded, compiled with Bun for this machine's Rust target, and
// named the way Tauri expects: src-tauri/binaries/titlesearch-<target triple>.
// The desktop app adds no second implementation of anything (CLAUDE.md).

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");

const rustc = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
const triple = process.env.TAURI_TARGET_TRIPLE ?? /host: (\S+)/.exec(rustc)?.[1];
if (!triple) throw new Error("Couldn't determine the Rust target triple.");

// Rust target → Bun compile target.
const BUN_TARGETS = {
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
  "x86_64-pc-windows-msvc": "bun-windows-x64",
  "x86_64-unknown-linux-gnu": "bun-linux-x64",
  "aarch64-unknown-linux-gnu": "bun-linux-arm64",
};
const bunTarget = BUN_TARGETS[triple];
if (!bunTarget) throw new Error(`No Bun target for ${triple}.`);

// On Windows, pnpm and npx are .cmd shims, which need a shell to start.
const run = (cmd, args) =>
  execFileSync(cmd, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
run("pnpm", ["--filter", "@titlesearch/web", "build"]);
run("node", ["apps/cli/scripts/embed-ui.mjs"]);
const outDir = join(here, "../src-tauri/binaries");
mkdirSync(outDir, { recursive: true });
const ext = triple.includes("windows") ? ".exe" : "";
run("npx", [
  "--yes",
  "bun@1.4.2",
  "build",
  "--compile",
  `--target=${bunTarget}`,
  "apps/cli/src/main.ts",
  "--outfile",
  join(outDir, `titlesearch-${triple}${ext}`),
]);
process.stdout.write(`Built the sidecar for ${triple}.\n`);
