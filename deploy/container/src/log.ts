// Structured JSON logs, one object per line on stdout: Cloud Logging and
// CloudWatch both parse them. Every secret is redacted (invariant 6).

import { type LogFields, type Logger, redactingLogger } from "@titlesearch/core";

const LEVELS = ["error", "warn", "info", "debug"] as const;
type Level = (typeof LEVELS)[number];
const SEVERITY: Record<Level, string> = {
  error: "ERROR",
  warn: "WARNING",
  info: "INFO",
  debug: "DEBUG",
};

export function createJsonLogger(level: Level, secrets: readonly string[]): Logger {
  const max = LEVELS.indexOf(level);
  const write =
    (l: Level) =>
    (message: string, fields?: LogFields): void => {
      if (LEVELS.indexOf(l) > max) return;
      const line = JSON.stringify(
        { severity: SEVERITY[l], level: l, message, ...fields },
        (_k, v) => (v instanceof Error ? `${v.name}: ${v.message}` : v),
      );
      process.stdout.write(`${line}\n`);
    };
  return redactingLogger(
    { error: write("error"), warn: write("warn"), info: write("info"), debug: write("debug") },
    secrets,
  );
}
