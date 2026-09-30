// bun:sqlite adapter. The CLI and the desktop sidecar are Bun-compiled
// binaries; this driver is verified under `bun build --compile` in CI.

import { Database } from "bun:sqlite";
import type { SqliteDriver } from "./sqlite.js";

/** Opens (or creates) a cache database. Use ":memory:" for a throwaway one. */
export function openBunSqlite(path: string): SqliteDriver & { close(): void } {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000;");
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      const s = db.prepare(sql);
      return { get: (...p) => s.get(...(p as never[])), run: (...p) => s.run(...(p as never[])) };
    },
    close: () => db.close(),
  };
}
