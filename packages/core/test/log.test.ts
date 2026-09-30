import { describe, expect, it } from "vitest";
import { createRedactor, type Logger, REDACTED, redactingLogger } from "../src/log.js";

describe("redaction", () => {
  const secret = "pk1_7f3a9c2e11b4";
  const redact = createRedactor([secret, "abc"]);

  it("redacts strings, nested fields, arrays, and errors", () => {
    expect(redact(`key=${secret}`)).toBe(`key=${REDACTED}`);
    expect(redact({ a: { b: [`x${secret}y`] } })).toEqual({ a: { b: [`x${REDACTED}y`] } });
    expect(redact(new Error(`bad key ${secret}`) as unknown)).toBe(`Error: bad key ${REDACTED}`);
  });

  it("ignores values too short to be secrets", () => {
    expect(redact("abcdef")).toBe("abcdef");
  });

  it("survives cycles", () => {
    const o: Record<string, unknown> = { s: secret };
    o.self = o;
    expect(redact(o)).toEqual({ s: REDACTED, self: "[Circular]" });
  });

  it("wraps a logger", () => {
    const lines: unknown[] = [];
    const inner: Logger = {
      debug: (m, f) => lines.push([m, f]),
      info: (m, f) => lines.push([m, f]),
      warn: (m, f) => lines.push([m, f]),
      error: (m, f) => lines.push([m, f]),
    };
    redactingLogger(inner, [secret]).error(`failed with ${secret}`, {
      url: `https://x/?k=${secret}`,
    });
    expect(JSON.stringify(lines)).not.toContain(secret);
  });
});
