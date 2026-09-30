// node:sqlite adapter (Node 24+). Also works under Bun.

import { DatabaseSync } from "node:sqlite";
import type { SqliteDriver } from "./sqlite.js";

/** Opens (or creates) a cache database. Use ":memory:" for a throwaway one. */
export function openNodeSqlite(path: string): SqliteDriver & { close(): void } {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000;");
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      const s = db.prepare(sql);
      return { get: (...p) => s.get(...p), run: (...p) => s.run(...p) };
    },
    close: () => db.close(),
  };
}
