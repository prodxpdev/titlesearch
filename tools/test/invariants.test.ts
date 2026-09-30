// Tests for the Biome rules that enforce invariants 1 to 3, plus core's
// runtime-agnostic import and global bans. Each case is written to a temp tree
// at the path it names, so the path-scoped overrides in biome.json apply
// exactly as they do in the repo.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const biomeBin = join(repoRoot, "node_modules/.bin/biome");

type Rule = "inv1" | "inv2" | "inv3" | "core-runtime";

interface Case {
  name: string;
  path: string;
  code: string;
  /** Rules expected to fire. An empty list means the file must be clean for all of them. */
  expect: Rule[];
}

const cases: Case[] = [
  // Invariant 2: no global fetch outside packages/core/src/net.
  {
    name: "direct fetch call in a provider",
    path: "packages/providers/src/a.ts",
    code: 'export const r = await fetch("https://example.com/");',
    expect: ["inv2"],
  },
  {
    name: "globalThis.fetch in the server",
    path: "packages/server/src/a.ts",
    code: 'export const r = await globalThis.fetch("https://example.com/");',
    expect: ["inv2"],
  },
  {
    name: "fetch passed as a value",
    path: "packages/assess/src/a.ts",
    code: "declare function make(o: object): void;\nmake({ fetch });",
    expect: ["inv2"],
  },
  {
    name: "fetch aliased to a local",
    path: "apps/cli/src/a.ts",
    code: "export const f = fetch;",
    expect: ["inv2"],
  },
  {
    name: "fetch.bind",
    path: "packages/mcp/src/a.ts",
    code: "export const f = fetch.bind(globalThis);",
    expect: ["inv2"],
  },
  {
    name: "fetch in a test file is still flagged",
    path: "packages/providers/test/a.test.ts",
    code: 'export const r = await fetch("https://example.com/");',
    expect: ["inv2"],
  },
  {
    name: "fetch inside core/net is the one allowed place",
    path: "packages/core/src/net/safe-fetch.ts",
    code: "export const r = (u: string) => fetch(u);",
    expect: [],
  },
  {
    name: "member .fetch on another object (Hono app.fetch) is fine",
    path: "packages/server/src/b.ts",
    code: "declare const app: { fetch(r: Request): Response };\nexport const r = app.fetch(new Request('http://localhost/'));",
    expect: [],
  },
  {
    name: "typeof fetch in a type position is fine",
    path: "packages/providers/src/b.ts",
    code: "export type FetchLike = typeof fetch;",
    expect: [],
  },
  {
    name: "safeFetch is fine",
    path: "packages/providers/src/c.ts",
    code: "declare function safeFetch(u: string): Promise<unknown>;\nexport const r = await safeFetch('https://example.com/');",
    expect: [],
  },

  {
    name: "the web UI's same-origin API client may call fetch",
    path: "apps/web/src/api.ts",
    code: 'export const r = () => fetch("/api/session");',
    expect: [],
  },
  {
    name: "any other web UI file may not",
    path: "apps/web/src/views/other.ts",
    code: 'export const r = () => fetch("/api/session");',
    expect: ["inv2"],
  },

  // Invariant 3: raw bodies and HTML stay in core/net and core/extract.
  {
    name: "response.text() in a provider",
    path: "packages/providers/src/d.ts",
    code: "declare const res: Response;\nexport const t = await res.text();",
    expect: ["inv3"],
  },
  {
    name: "response.arrayBuffer() in mcp",
    path: "packages/mcp/src/d.ts",
    code: "declare const res: Response;\nexport const t = await res.arrayBuffer();",
    expect: ["inv3"],
  },
  {
    name: "body.getReader() in the server",
    path: "packages/server/src/d.ts",
    code: "declare const res: Response;\nexport const r = res.body.getReader();",
    expect: ["inv3"],
  },
  {
    name: "Hono c.html() in a route",
    path: "packages/server/src/routes/e.ts",
    code: "declare const c: { html(s: string): Response };\nexport const r = c.html('<p>hi</p>');",
    expect: ["inv3"],
  },
  {
    name: "reading the body in core/extract is allowed",
    path: "packages/core/src/extract/read.ts",
    code: "declare const res: Response;\nexport const t = await res.text();",
    expect: [],
  },
  {
    name: "serving HTML from the static UI module is allowed",
    path: "packages/server/src/static/index.ts",
    code: "declare const c: { html(s: string): Response };\nexport const r = c.html('<!doctype html>');",
    expect: [],
  },
  {
    name: "Hono c.text(message) is a write, not a read",
    path: "packages/server/src/f.ts",
    code: "declare const c: { text(s: string): Response };\nexport const r = c.text('ok');",
    expect: [],
  },

  // Invariant 1: no write operations on domains or DNS.
  {
    name: "upstream tool name for purchasing",
    path: "packages/providers/src/g.ts",
    code: 'export const tools = ["domains_check_availability", "domains_purchase"];',
    expect: ["inv1"],
  },
  {
    name: "REST path that creates a DNS record",
    path: "packages/providers/src/h.ts",
    code: 'export const path = "/api/json/v3/dns/create/example.com";',
    expect: ["inv1"],
  },
  {
    name: "method named registerDomain",
    path: "packages/providers/src/i.ts",
    code: "export class P {\n  registerDomain(): void {}\n}",
    expect: ["inv1"],
  },
  {
    name: "interface member named renewDomain",
    path: "packages/core/src/j.ts",
    code: "export interface P {\n  renewDomain(d: string): Promise<void>;\n}",
    expect: ["inv1"],
  },
  {
    name: "function named updateDnsRecords",
    path: "packages/server/src/k.ts",
    code: "export function updateDnsRecords(): void {}",
    expect: ["inv1"],
  },
  {
    name: "read-only names are fine",
    path: "packages/providers/src/l.ts",
    code: 'export const checkTool = "domains_check_availability";\nexport const status = "registered";\nexport const registrar = "Example Registrar";\nexport function createDomainResult(): void {}',
    expect: [],
  },
  {
    name: "a refusal test may name a write tool",
    path: "packages/providers/test/allowlist.test.ts",
    code: 'export const refused = "domains_purchase";',
    expect: [],
  },

  // Core stays runtime-agnostic.
  {
    name: "node: import in core",
    path: "packages/core/src/m.ts",
    code: 'import { lookup } from "node:dns";\nexport const l = lookup;',
    expect: ["core-runtime"],
  },
  {
    name: "cloudflare:sockets import in core",
    path: "packages/core/src/n.ts",
    code: 'import { connect } from "cloudflare:sockets";\nexport const c = connect;',
    expect: ["core-runtime"],
  },
  {
    name: "process global in core",
    path: "packages/core/src/o.ts",
    code: "export const e = process.env.X;",
    expect: ["core-runtime"],
  },
  {
    name: "Buffer global in core",
    path: "packages/core/src/p.ts",
    code: 'export const b = Buffer.from("x");',
    expect: ["core-runtime"],
  },
  {
    name: "node: import outside core is fine",
    path: "packages/cache/src/q.ts",
    code: 'import { join } from "node:path";\nexport const j = join;',
    expect: [],
  },
];

interface Diagnostic {
  category: string;
  message: string;
  location: { path: string };
}

function classify(d: Diagnostic): Rule | undefined {
  if (d.category === "plugin") {
    if (d.message.startsWith("Invariant 1:")) return "inv1";
    if (d.message.startsWith("Invariant 2:")) return "inv2";
    if (d.message.startsWith("Invariant 3:")) return "inv3";
  }
  if (
    d.category.endsWith("/noNodejsModules") ||
    d.category.endsWith("/noRestrictedImports") ||
    d.category.endsWith("/noRestrictedGlobals")
  ) {
    return "core-runtime";
  }
  return undefined;
}

let tree: string;
const firedByPath = new Map<string, Set<Rule>>();
// A plugin that errors at runtime is reported as an info, not an error, and
// silently stops enforcing. Collect those so the suite fails loudly instead.
const pluginErrors: string[] = [];

beforeAll(() => {
  tree = mkdtempSync(join(tmpdir(), "titlesearch-invariants-"));
  const config = JSON.parse(readFileSync(join(repoRoot, "biome.json"), "utf8"));
  // The temp tree isn't a git repo, and the $schema path would dangle.
  delete config.vcs;
  delete config.$schema;
  writeFileSync(join(tree, "biome.json"), JSON.stringify(config));
  cpSync(join(repoRoot, "tools/biome-plugins"), join(tree, "tools/biome-plugins"), {
    recursive: true,
  });
  for (const c of cases) {
    const file = join(tree, c.path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${c.code}\n`);
  }

  let out: string;
  try {
    out = execFileSync(
      biomeBin,
      ["lint", "--reporter=json", "--colors=off", "--max-diagnostics=none", "."],
      { cwd: tree, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    // Biome exits non-zero when it reports errors, which is the point here.
    out = (err as { stdout: string }).stdout;
  }
  const report = JSON.parse(out) as { diagnostics: Diagnostic[] };
  for (const d of report.diagnostics) {
    if (d.category === "plugin" && / errored: /.test(d.message)) pluginErrors.push(d.message);
    const rule = classify(d);
    if (!rule) continue;
    const fired = firedByPath.get(d.location.path) ?? new Set<Rule>();
    fired.add(rule);
    firedByPath.set(d.location.path, fired);
  }
});

afterAll(() => {
  if (tree) rmSync(tree, { recursive: true, force: true });
});

describe("invariant lint rules", () => {
  it("every case has a unique path", () => {
    expect(new Set(cases.map((c) => c.path)).size).toBe(cases.length);
  });

  it("no plugin errors at runtime", () => {
    expect(pluginErrors).toEqual([]);
  });

  it.each(cases)("$name ($path)", (c) => {
    const fired = [...(firedByPath.get(c.path) ?? [])].sort();
    expect(fired).toEqual([...c.expect].sort());
  });
});
