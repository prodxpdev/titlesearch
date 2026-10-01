// Build step for the renderer image: downloads the pinned chrome-headless-shell
// and verifies its SHA-256 (packages/render/src/chromium-manifest.json), then
// links it to a fixed path.

import { symlinkSync } from "node:fs";
import { installChromium } from "@titlesearch/render";

const dir = process.argv[2] ?? "/opt/chromium";
const executable = await installChromium({ dataDir: dir });
symlinkSync(executable, `${dir}/chrome-headless-shell`);
process.stdout.write(`Installed and verified ${executable}\n`);
