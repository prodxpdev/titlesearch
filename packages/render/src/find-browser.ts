// Finds an installed Chrome, Edge, or Chromium. Titlesearch never bundles
// Chromium into its binary (CLAUDE.md).

import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

const CANDIDATES: Record<string, string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
  linux: [],
};
const LINUX_NAMES = [
  "google-chrome-stable",
  "google-chrome",
  "chromium",
  "chromium-browser",
  "microsoft-edge",
  "microsoft-edge-stable",
];

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findBrowser(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): string | undefined {
  const override = env.TITLESEARCH_CHROME_PATH;
  if (override) return executable(override) ? override : undefined;
  for (const p of CANDIDATES[platform] ?? []) if (executable(p)) return p;
  if (platform === "linux") {
    for (const dir of (env.PATH ?? "").split(delimiter)) {
      for (const name of LINUX_NAMES) {
        const p = join(dir, name);
        if (executable(p)) return p;
      }
    }
  }
  return undefined;
}
