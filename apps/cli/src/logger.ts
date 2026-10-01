// Logs go to stderr only: in `mcp` mode stdout carries the protocol.

import { type LogFields, type RedactingLogger, redactingLogger } from "@titlesearch/core";

const LEVELS = ["error", "warn", "info", "debug"] as const;
type Level = (typeof LEVELS)[number];

export function createLogger(
  level: string | undefined,
  secrets: readonly string[],
): RedactingLogger {
  const max = LEVELS.indexOf(
    (LEVELS as readonly string[]).includes(level ?? "") ? (level as Level) : "warn",
  );
  const write =
    (l: Level) =>
    (message: string, fields?: LogFields): void => {
      if (LEVELS.indexOf(l) > max) return;
      const extra = fields ? ` ${JSON.stringify(fields, errorReplacer)}` : "";
      process.stderr.write(`titlesearch ${l}: ${message}${extra}\n`);
    };
  return redactingLogger(
    { error: write("error"), warn: write("warn"), info: write("info"), debug: write("debug") },
    secrets,
  );
}

function errorReplacer(_key: string, value: unknown): unknown {
  return value instanceof Error ? `${value.name}: ${value.message}` : value;
}
