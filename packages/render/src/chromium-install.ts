// The one-time Chromium download (CLAUDE.md, Site previews: local-chromium).
// A pinned chrome-headless-shell build from Chrome for Testing, verified
// against the SHA-256 recorded in chromium-manifest.json before anything is
// written to disk. tools/pin-chromium.mjs regenerates the manifest.

import { spawn } from "node:child_process";
import { chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fetchVerified, type Transport, VerificationError } from "@titlesearch/core";
import manifestJson from "./chromium-manifest.json" with { type: "json" };

export interface ChromiumBuild {
  url: string;
  sha256: string;
  size: number;
  /** The executable's path inside the archive. */
  executable: string;
}

export interface ChromiumManifest {
  version: string;
  platforms: Record<string, ChromiumBuild>;
}

export const CHROMIUM_MANIFEST: ChromiumManifest = manifestJson;

export class ChromiumInstallError extends Error {
  override readonly name = "ChromiumInstallError";
  constructor(
    readonly code:
      | "unsupported_platform"
      | "download_failed"
      | "checksum_mismatch"
      | "extract_failed",
    message: string,
  ) {
    super(message);
  }
}

export function currentPlatform(): string {
  return `${process.platform}-${process.arch}`;
}

function installDir(dataDir: string, manifest: ChromiumManifest): string {
  return join(dataDir, "browser", `chrome-headless-shell-${manifest.version}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The installed, verified executable, if there is one. */
export async function installedChromium(
  dataDir: string,
  options: { manifest?: ChromiumManifest; platform?: string } = {},
): Promise<string | undefined> {
  const manifest = options.manifest ?? CHROMIUM_MANIFEST;
  const build = manifest.platforms[options.platform ?? currentPlatform()];
  if (!build) return undefined;
  const dir = installDir(dataDir, manifest);
  const exe = join(dir, build.executable);
  return (await exists(join(dir, ".verified"))) && (await exists(exe)) ? exe : undefined;
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`)),
    );
  });
}

export interface InstallOptions {
  dataDir: string;
  manifest?: ChromiumManifest;
  platform?: string;
  /** Tests only. */
  transport?: Transport;
}

/** Downloads, verifies, and unpacks the pinned build. Returns the executable's path. */
export async function installChromium(options: InstallOptions): Promise<string> {
  const manifest = options.manifest ?? CHROMIUM_MANIFEST;
  const platform = options.platform ?? currentPlatform();
  const build = manifest.platforms[platform];
  if (!build) {
    throw new ChromiumInstallError(
      "unsupported_platform",
      `No pinned Chromium build for ${platform}.`,
    );
  }
  const already = await installedChromium(options.dataDir, { manifest, platform });
  if (already) return already;

  // Size and checksum are verified before anything touches the disk.
  let bytes: Uint8Array;
  try {
    bytes = await fetchVerified(
      build.url,
      build,
      options.transport ? { transport: options.transport } : {},
    );
  } catch (err) {
    const code = err instanceof VerificationError ? err.code : "download_failed";
    throw new ChromiumInstallError(code, `${(err as Error).message} Nothing was installed.`);
  }

  const dir = installDir(options.dataDir, manifest);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const zip = join(dir, "download.zip");
  try {
    await writeFile(zip, bytes, { mode: 0o600 });
    if (process.platform === "win32") await run("tar", ["-xf", zip, "-C", dir]);
    else await run("unzip", ["-q", "-o", zip, "-d", dir]);
    await rm(zip, { force: true });
    const exe = join(dir, build.executable);
    if (process.platform !== "win32") await chmod(exe, 0o755);
    if (!(await exists(exe)))
      throw new Error("The archive didn't contain the expected executable.");
    await writeFile(join(dir, ".verified"), `${build.sha256}\n`);
    return exe;
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw new ChromiumInstallError(
      "extract_failed",
      `Couldn't unpack Chromium: ${(err as Error).message}`,
    );
  }
}
