// Logging with secret redaction (invariant 6). Every logger handed to a
// provider is wrapped so a secret can't reach a log line, even by accident.

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export const REDACTED = "[REDACTED]";

/** Replaces every occurrence of each secret in strings, recursively through objects and arrays. */
export function createRedactor(secrets: readonly string[]): <T>(value: T) => T {
  // Very short values would redact ordinary text; secrets are never that short.
  const needles = secrets.filter((s) => s.length >= 6).sort((a, b) => b.length - a.length);
  const redactString = (s: string) => needles.reduce((acc, n) => acc.split(n).join(REDACTED), s);
  const walk = (v: unknown, seen: WeakSet<object>): unknown => {
    if (typeof v === "string") return redactString(v);
    if (v instanceof Error) return redactString(`${v.name}: ${v.message}`);
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return "[Circular]";
    seen.add(v);
    if (Array.isArray(v)) return v.map((x) => walk(x, seen));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, seen)]));
  };
  return <T>(value: T) => walk(value, new WeakSet()) as T;
}

export function redactingLogger(inner: Logger, secrets: readonly string[]): Logger {
  const redact = createRedactor(secrets);
  const wrap =
    (level: keyof Logger) =>
    (message: string, fields?: LogFields): void => {
      inner[level](redact(message), fields === undefined ? undefined : redact(fields));
    };
  return { debug: wrap("debug"), info: wrap("info"), warn: wrap("warn"), error: wrap("error") };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
