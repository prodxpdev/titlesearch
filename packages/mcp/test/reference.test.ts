// The docs site's tool reference must match what the server registers.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToolReference } from "../src/reference.js";

describe("docs/reference/mcp-tools.md", () => {
  it("is current: run `pnpm --filter @titlesearch/mcp docs` after changing a tool", () => {
    const file = readFileSync(
      new URL("../../../docs/reference/mcp-tools.md", import.meta.url),
      "utf8",
    );
    expect(file).toBe(renderToolReference());
  });

  it("documents every tool and says it isn't a trademark search", () => {
    const md = renderToolReference();
    for (const t of [
      "check_domains",
      "generate_variants",
      "suggest_names",
      "inspect_domain",
      "assess_market_conflicts",
    ])
      expect(md).toContain(`## \`${t}\``);
    expect(md).toContain("isn't a trademark search");
  });
});
