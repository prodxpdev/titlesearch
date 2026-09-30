// Built with `bun build --compile` and run in CI, to prove the SQLite store
// works inside a compiled Titlesearch binary (CLAUDE.md, Cache).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/sqlite.js";
import { openBunSqlite } from "../src/sqlite-bun.js";

const dir = mkdtempSync(join(tmpdir(), "titlesearch-smoke-"));
const path = join(dir, "cache.db");
try {
  const first = openBunSqlite(path);
  await new SqliteStore(first).set("smoke", { ok: true, text: "münchen 😀" }, 60);
  first.close();
  const second = openBunSqlite(path);
  const value = await new SqliteStore(second).get<{ ok: boolean; text: string }>("smoke");
  second.close();
  if (value?.ok !== true || value.text !== "münchen 😀") {
    process.stderr.write(`Compiled SQLite smoke test failed: ${JSON.stringify(value)}\n`);
    process.exit(1);
  }
  process.stdout.write("Compiled SQLite smoke test passed.\n");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
