// Turns the recorded demo video into docs/public/demo.gif with ffmpeg (a two-pass
// palette for small, clean output).

import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "apps/web/demo/out");
const find = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? find(p) : p.endsWith(".webm") ? [p] : [];
  });
const [video] = find(outDir);
if (!video) throw new Error("No recording found; run the demo spec first.");
const gif = join(root, "docs/public/demo.gif");
const filters = "fps=10,scale=960:-1:flags=lanczos";
execFileSync(
  "ffmpeg",
  [
    "-y",
    "-i",
    video,
    "-vf",
    `${filters},palettegen=stats_mode=diff`,
    "/tmp/titlesearch-palette.png",
  ],
  { stdio: "ignore" },
);
execFileSync(
  "ffmpeg",
  [
    "-y",
    "-i",
    video,
    "-i",
    "/tmp/titlesearch-palette.png",
    "-lavfi",
    `${filters} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
    gif,
  ],
  { stdio: "ignore" },
);
process.stdout.write(`Wrote ${gif} (${Math.round(statSync(gif).size / 1024)} KB)\n`);
