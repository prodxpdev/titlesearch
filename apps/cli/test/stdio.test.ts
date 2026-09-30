// The Claude Desktop path: the CLI's `mcp` command over stdio, driven by the
// SDK's own stdio client. Needs Bun (the CLI's runtime), so it runs in the
// Bun CI job and is skipped under Node. Uses only offline tools.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, describe, expect, it } from "vitest";

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const main = join(dirname(fileURLToPath(import.meta.url)), "../src/main.ts");

describe.runIf(isBun)("titlesearch mcp over stdio", () => {
  const home = mkdtempSync(join(tmpdir(), "titlesearch-stdio-"));
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it("lists tools and answers generate_variants", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [main, "mcp"],
      env: {
        PATH: process.env.PATH ?? "",
        TITLESEARCH_CONFIG_DIR: join(home, "config"),
        TITLESEARCH_CACHE_DIR: join(home, "cache"),
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()?.name).toBe("titlesearch");
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "check_domains",
        "generate_variants",
        "inspect_domain",
      ]);
      const res = await client.callTool({
        name: "generate_variants",
        arguments: { seed: "acme", strategies: ["tld"], tlds: ["com", "io"] },
      });
      expect(res.structuredContent).toEqual({
        candidates: [
          { domain: "acme.com", strategy: "seed" },
          { domain: "acme.io", strategy: "tld" },
        ],
      });
    } finally {
      await client.close();
    }
  }, 30_000);
});
