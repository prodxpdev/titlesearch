// Structural checks that Biome can't express. Runs as part of `pnpm lint`.
//
// - packages/core depends on nothing but zod, and can't see @types/node.
// - biome.json still wires every invariant rule to the paths it guards, so a
//   rule can't be dropped from the config without this failing.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
const failures = [];
const fail = (msg) => failures.push(msg);

// Core: runtime dependencies.
const core = readJson("packages/core/package.json");
const coreDeps = Object.keys(core.dependencies ?? {});
for (const dep of coreDeps) {
  if (dep !== "zod") fail(`packages/core depends on "${dep}". Core may depend only on zod.`);
}
for (const field of ["devDependencies", "peerDependencies", "optionalDependencies"]) {
  if (core[field]?.["@types/node"]) {
    fail(`packages/core lists @types/node in ${field}. Core must not see Node types.`);
  }
}

// Core: compiler sees web APIs only.
const coreTs = readJson("packages/core/tsconfig.json").compilerOptions ?? {};
if (!Array.isArray(coreTs.types) || coreTs.types.length !== 0) {
  fail('packages/core/tsconfig.json must set "types": [] so @types/node is never loaded.');
}
const lib = (coreTs.lib ?? []).map((l) => l.toLowerCase());
if (lib.some((l) => l === "dom" || l.startsWith("dom."))) {
  fail("packages/core/tsconfig.json must not include the DOM lib. Use WebWorker.");
}
if (!lib.includes("webworker")) {
  fail("packages/core/tsconfig.json must include the WebWorker lib for fetch, URL, and crypto.");
}

// Biome: every invariant rule is still wired.
const biome = readJson("biome.json");
const overrides = biome.overrides ?? [];
const wired = (plugin, mustInclude) => {
  const o = overrides.find((x) => (x.plugins ?? []).some((p) => p.endsWith(plugin)));
  if (!o) return fail(`biome.json no longer applies ${plugin}.`);
  for (const glob of mustInclude) {
    if (!o.includes.includes(glob)) fail(`biome.json: ${plugin} no longer covers ${glob}.`);
  }
};
wired("no-direct-fetch.grit", ["packages/**/*.ts", "apps/**/*.ts", "deploy/**/*.ts"]);
wired("no-raw-site-content.grit", ["packages/**/*.ts", "apps/**/*.ts", "deploy/**/*.ts"]);
wired("no-write-operations.grit", ["packages/**/*.ts", "deploy/**/*.ts"]);

const coreOverride = overrides.find((o) => o.includes?.includes("packages/core/**/*.ts"));
const coreRules = coreOverride?.linter?.rules ?? {};
if (coreRules.correctness?.noNodejsModules !== "error") {
  fail("biome.json: noNodejsModules must be an error for packages/core.");
}
for (const rule of ["noRestrictedImports", "noRestrictedGlobals"]) {
  if (coreRules.style?.[rule]?.level !== "error") {
    fail(`biome.json: ${rule} must be an error for packages/core.`);
  }
}

if (failures.length > 0) {
  for (const f of failures) process.stderr.write(`✖ ${f}\n`);
  process.exit(1);
}
process.stdout.write("Invariant structure checks passed.\n");
