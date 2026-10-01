// server.json (the MCP Registry entry) against the registry's schema, vendored
// in tools/schemas, and against the facts it must agree with.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));

describe("server.json", () => {
  const server = read("server.json");

  it("validates against the registry schema it names", () => {
    expect(server.$schema).toBe(
      "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    );
    // The registry schema is JSON Schema draft-07, Ajv's default.
    const ajv = new Ajv.default({ strict: false, allErrors: true });
    addFormats.default(ajv);
    const validate = ajv.compile(read("tools/schemas/server.schema.2025-12-11.json"));
    expect(validate(server), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it("runs `titlesearch mcp` from the npm package, at the same version", () => {
    const npm = server.packages.find((p: { registryType: string }) => p.registryType === "npm");
    expect(npm).toMatchObject({ identifier: "titlesearch", transport: { type: "stdio" } });
    expect(npm.packageArguments).toEqual([{ type: "positional", value: "mcp" }]);
    expect(npm.version).toBe(server.version);
  });

  it("marks every key as a secret", () => {
    const npm = server.packages[0];
    for (const v of npm.environmentVariables) {
      if (/KEY|TOKEN/.test(v.name)) expect(v.isSecret, v.name).toBe(true);
    }
  });
});

describe("release versions", () => {
  it("agree across the CLI, npm, server.json, and the desktop app", async () => {
    // @ts-expect-error: a plain .mjs script, without type declarations.
    const { check } = await import("../set-version.mjs");
    expect(() => check()).not.toThrow();
  });
});
