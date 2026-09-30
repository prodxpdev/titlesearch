import {
  CHROMIUM_MANIFEST,
  ChromiumInstallError,
  currentPlatform,
  findBrowser,
  installChromium,
  installedChromium,
} from "@titlesearch/render";

/** `titlesearch browser install | status`. */
export async function runBrowser(sub: string | undefined, dataDir: string): Promise<number> {
  const system = findBrowser();
  const downloaded = await installedChromium(dataDir);
  if (sub === "status" || sub === undefined) {
    process.stdout.write(
      system
        ? `Using ${system} for previews.\n`
        : downloaded
          ? `Using the downloaded Chromium ${CHROMIUM_MANIFEST.version} at ${downloaded}.\n`
          : "No browser for previews. Run `titlesearch browser install`, or install Chrome or Edge.\n",
    );
    return 0;
  }
  if (sub !== "install") {
    process.stderr.write(`Unknown browser command "${sub}". Use install or status.\n`);
    return 2;
  }
  if (system) {
    process.stdout.write(`Chrome or Edge is already installed (${system}); no download needed.\n`);
    return 0;
  }
  const build = CHROMIUM_MANIFEST.platforms[currentPlatform()];
  if (!build) {
    process.stderr.write(
      `There's no pinned Chromium build for ${currentPlatform()}. Install Chrome or Edge instead.\n`,
    );
    return 1;
  }
  process.stdout.write(
    `Downloading Chromium ${CHROMIUM_MANIFEST.version} (${(build.size / 1048576).toFixed(0)} MB) from Chrome for Testing...\n`,
  );
  try {
    const exe = await installChromium({ dataDir });
    process.stdout.write(`Verified its SHA-256 and installed it at ${exe}.\n`);
    return 0;
  } catch (err) {
    if (err instanceof ChromiumInstallError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
}
