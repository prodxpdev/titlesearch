import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "@titlesearch/core";
import { afterEach, describe, expect, it } from "vitest";
import { CliConfig, ConfigError, loadConfig } from "../src/config.js";
import { resolvePaths } from "../src/paths.js";
import {
  createServices,
  priceKeysFromEnv,
  priceSecrets,
  resolveAssessmentMode,
} from "../src/runtime.js";

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
      providers: {
        godaddy: { enabled: true },
        porkbun: { enabled: true },
        namecom: { enabled: true, environment: "production" },
      },
      whois: { enable: [] },
      cache: { enabled: true },
      previews: { mode: "local" },
      assessment: {
        model: { provider: "anthropic", id: "claude-opus-5-5" },
        effort: "medium",
        refusalFallback: true,
      },
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

describe("resolveAssessmentMode", () => {
  it.each([
    [undefined, "mcp", true, "client"],
    [undefined, "mcp", false, "client"],
    [undefined, "check", true, "server"],
    [undefined, "check", false, "off"],
    ["server", "mcp", true, "server"],
    ["off", "check", true, "off"],
  ] as const)("config %s, command %s, key %s → %s", (configured, command, hasKey, expected) => {
    expect(resolveAssessmentMode(configured, command, hasKey)).toBe(expected);
  });
});

describe("resolvePaths", () => {
  it("honors overrides", () => {
    expect(
      resolvePaths({
        TITLESEARCH_CONFIG_DIR: "/c",
        TITLESEARCH_CACHE_DIR: "/k",
        TITLESEARCH_DATA_DIR: "/d",
      }),
    ).toEqual({ configDir: "/c", cacheDir: "/k", dataDir: "/d" });
  });
});

describe("price keys", () => {
  it("needs every variable for a source, and trims them", () => {
    expect(priceKeysFromEnv({ PORKBUN_API_KEY: "pk1_x" })).toEqual({});
    expect(
      priceKeysFromEnv({
        PORKBUN_API_KEY: " pk1_x ",
        PORKBUN_SECRET_API_KEY: "sk1_y",
        NAMECOM_USERNAME: "me",
        NAMECOM_TOKEN: "",
      }),
    ).toEqual({ porkbun: { apiKey: "pk1_x", secretApiKey: "sk1_y" } });
  });

  it("lists every secret for redaction, but not the Name.com username", () => {
    const keys = priceKeysFromEnv({
      PORKBUN_API_KEY: "pk1_x",
      PORKBUN_SECRET_API_KEY: "sk1_y",
      NAMECOM_USERNAME: "me",
      NAMECOM_TOKEN: "tok",
    });
    expect(priceSecrets(keys)).toEqual(["pk1_x", "sk1_y", "tok"]);
  });

  it("defaults both price sources on, used only when keys exist", async () => {
    const config = CliConfig.parse({ previews: { mode: "off" } });
    expect(config.providers.porkbun.enabled).toBe(true);
    expect(config.providers.namecom).toEqual({ enabled: true, environment: "production" });
    const ids = async (priceKeys: Parameters<typeof priceSecrets>[0], c = config) => {
      const rt = await createServices({
        config: c,
        cacheDir: "",
        dataDir: "",
        logger: silentLogger,
        noCache: true,
        command: "check",
        priceKeys,
      });
      await rt.close();
      return rt.services.providers.map((p) => p.id);
    };
    expect(await ids({})).toEqual(["rdap", "godaddy"]);
    const both = {
      porkbun: { apiKey: "pk1_x", secretApiKey: "sk1_y" },
      namecom: { username: "me", token: "tok" },
    };
    expect(await ids(both)).toEqual(["rdap", "godaddy", "porkbun", "namecom"]);
    const off = CliConfig.parse({
      previews: { mode: "off" },
      providers: { porkbun: { enabled: false } },
    });
    expect(await ids(both, off)).toEqual(["rdap", "godaddy", "namecom"]);
  });
});

describe("suggestion room", () => {
  it("fits within 20 names and 50 domains", async () => {
    const { suggestionRoom } = await import("../src/commands/suggest.js");
    expect(suggestionRoom(0, 6)).toBe(8);
    expect(suggestionRoom(2, 2)).toBe(18);
    expect(suggestionRoom(8, 6)).toBe(0);
  });
});

describe("models", () => {
  it("reads older configs: a model string and the anthropic mode", () => {
    const c = CliConfig.parse({ assessment: { mode: "anthropic", model: "claude-opus-5-5" } });
    expect(c.assessment.mode).toBe("server");
    expect(c.assessment.model).toEqual({ provider: "anthropic", id: "claude-opus-5-5" });
  });

  it("accepts a local or OpenAI-compatible model", () => {
    const c = CliConfig.parse({
      assessment: {
        model: {
          provider: "openai-compatible",
          id: "llama-3.3-70b",
          baseUrl: "https://api.groq.com/openai/v1",
        },
      },
    });
    expect(c.assessment.model.provider).toBe("openai-compatible");
    expect(() =>
      CliConfig.parse({ assessment: { model: { provider: "openai-compatible", id: "x" } } }),
    ).toThrow();
  });

  it("reads TITLESEARCH_MODEL", async () => {
    const { modelFromEnv } = await import("../src/runtime.js");
    expect(modelFromEnv({})).toBeUndefined();
    expect(modelFromEnv({ TITLESEARCH_MODEL: "ollama:llama3.1:8b" })).toEqual({
      provider: "ollama",
      id: "llama3.1:8b",
    });
    expect(modelFromEnv({ TITLESEARCH_MODEL: "claude-opus-5-5" })).toEqual({
      provider: "anthropic",
      id: "claude-opus-5-5",
    });
    expect(
      modelFromEnv({
        TITLESEARCH_MODEL: "openai-compatible:m",
        TITLESEARCH_MODEL_URL: "https://openrouter.ai/api/v1",
      }),
    ).toEqual({ provider: "openai-compatible", id: "m", baseUrl: "https://openrouter.ai/api/v1" });
    expect(() => modelFromEnv({ TITLESEARCH_MODEL: "openai-compatible:m" })).toThrow(/base URL/);
  });

  it("judges with a local model by default when one is chosen, with no key", async () => {
    const rt = await createServices({
      config: CliConfig.parse({
        previews: { mode: "off" },
        assessment: { model: { provider: "ollama", id: "llama3.1:8b" } },
      }),
      cacheDir: "",
      dataDir: "",
      logger: silentLogger,
      noCache: true,
      command: "check",
    });
    await rt.close();
    expect(rt.services.assessment?.mode).toBe("server");
    expect(rt.services.assessment?.classifier?.id).toBe("ollama:llama3.1:8b");
    expect(rt.services.suggester?.id).toBe("ollama:llama3.1:8b");
    expect(rt.model.label).toBe("Ollama · llama3.1:8b (this computer)");
  });
});
