// Minimal types for bun:sqlite, so this package doesn't need bun-types.
declare module "bun:sqlite" {
  interface Statement {
    get(...params: (string | number | Uint8Array)[]): unknown;
    run(...params: (string | number | Uint8Array)[]): unknown;
  }
  export class Database {
    constructor(path: string, options?: { create?: boolean; strict?: boolean });
    exec(sql: string): void;
    prepare(sql: string): Statement;
    close(): void;
  }
}
