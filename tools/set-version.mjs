// Sets one version everywhere a release names it, or checks they agree.
//
//   node tools/set-version.mjs 1.2.3     # write
//   node tools/set-version.mjs --check   # fail if the files disagree
//   node tools/set-version.mjs --check 1.2.3   # fail unless all are 1.2.3

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

const JSON_FILES = [
  { path: "apps/cli/package.json", get: (j) => [j.version], set: (j, v) => (j.version = v) },
  { path: "apps/desktop/package.json", get: (j) => [j.version], set: (j, v) => (j.version = v) },
  {
    path: "apps/desktop/src-tauri/tauri.conf.json",
    get: (j) => [j.version],
    set: (j, v) => (j.version = v),
  },
  {
    path: "server.json",
    get: (j) => [j.version, ...j.packages.map((p) => p.version)],
    set: (j, v) => {
      j.version = v;
      for (const p of j.packages) p.version = v;
    },
  },
];
const CARGO = "apps/desktop/src-tauri/Cargo.toml";
const CARGO_VERSION = /^(\[package\][\s\S]*?^version = ")([^"]+)(")/m;

function versions() {
  const found = {};
  for (const f of JSON_FILES)
    found[f.path] = f.get(JSON.parse(readFileSync(join(root, f.path), "utf8")));
  found[CARGO] = [CARGO_VERSION.exec(readFileSync(join(root, CARGO), "utf8"))?.[2]];
  return found;
}

export function check(expected) {
  const found = versions();
  const all = new Set(Object.values(found).flat());
  if (all.size !== 1 || (expected && !all.has(expected))) {
    const lines = Object.entries(found).map(([p, v]) => `  ${p}: ${v.join(", ")}`);
    throw new Error(
      `Versions disagree${expected ? ` with ${expected}` : ""}:\n${lines.join("\n")}`,
    );
  }
  return [...all][0];
}

function write(version) {
  if (!SEMVER.test(version)) throw new Error(`${version} isn't a version like 1.2.3.`);
  for (const f of JSON_FILES) {
    const p = join(root, f.path);
    const j = JSON.parse(readFileSync(p, "utf8"));
    f.set(j, version);
    writeFileSync(p, `${JSON.stringify(j, null, 2)}\n`);
  }
  const cargo = join(root, CARGO);
  writeFileSync(cargo, readFileSync(cargo, "utf8").replace(CARGO_VERSION, `$1${version}$3`));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  try {
    if (args[0] === "--check") process.stdout.write(`All at ${check(args[1])}\n`);
    else if (args[0]) {
      write(args[0]);
      process.stdout.write(
        `Set ${args[0]}. Update Cargo.lock with: cargo update -p titlesearch-desktop\n`,
      );
    } else throw new Error("Give a version, or --check.");
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
