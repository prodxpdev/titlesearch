import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { resolvePaths } from "../src/paths.js";

describe("loadConfig", () => {
  const dirs: string[] = [];
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), "titlesearch-config-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("defaults everything when there's no file", async () => {
    await expect(loadConfig(dir())).resolves.toEqual({
      providers: { godaddy: { enabled: true } },
      whois: { enable: [] },
      cache: { enabled: true },
    });
  });

  it("reads overrides", async () => {
    const d = dir();
    writeFileSync(
      join(d, "config.json"),
      JSON.stringify({ providers: { godaddy: { enabled: false } }, whois: { enable: ["de"] } }),
    );
    const config = await loadConfig(d);
    expect(config.providers.godaddy.enabled).toBe(false);
    expect(config.whois.enable).toEqual(["de"]);
  });

  it.each([
    ["invalid JSON", "{"],
    ["a wrong type", JSON.stringify({ cache: { enabled: "no" } })],
    ["an unknown key, such as a misplaced secret", JSON.stringify({ apiKey: "x" })],
  ])("rejects %s", async (_label, text) => {
    const d = dir();
    writeFileSync(join(d, "config.json"), text);
    await expect(loadConfig(d)).rejects.toBeInstanceOf(ConfigError);
  });
});

describe("resolvePaths", () => {
  it("honors overrides", () => {
    expect(resolvePaths({ TITLESEARCH_CONFIG_DIR: "/c", TITLESEARCH_CACHE_DIR: "/k" })).toEqual({
      configDir: "/c",
      cacheDir: "/k",
    });
  });
});
