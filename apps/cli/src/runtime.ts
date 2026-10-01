// Builds the providers, cache, and per-call context from config.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AnthropicClassifier, type AssessmentMode } from "@titlesearch/assess";
import { MemoryStore, type SqliteDriver, SqliteStore } from "@titlesearch/cache";
import {
  type AvailabilityProvider,
  DohResolver,
  type Logger,
  type PresenceProbe,
  type ProviderContext,
  probePresence,
} from "@titlesearch/core";
import type { TitlesearchServices } from "@titlesearch/mcp";
import {
  builtInMappings,
  createDefaultRateLimiter,
  GODADDY_MCP,
  NamecomProvider,
  PorkbunProvider,
  RdapProvider,
  UpstreamMcpProvider,
} from "@titlesearch/providers";
import { nodeWhoisConnector } from "@titlesearch/providers/whois/node";
import {
  createPreviewer,
  createWebpEncoder,
  findBrowser,
  installedChromium,
  LocalChromiumRenderer,
  nodeWasmLoader,
  type WasmLoader,
} from "@titlesearch/render";
import { type CliConfig, ConfigError } from "./config.js";

export interface RuntimeOptions {
  config: CliConfig;
  cacheDir: string;
  dataDir: string;
  logger: Logger;
  /** Overrides from command-line flags. */
  noCache?: boolean;
  noGodaddy?: boolean;
  /** Which command is running; sets the default assessment mode. */
  command: "mcp" | "check";
  /** From ANTHROPIC_API_KEY. Never logged: it's registered with the redacting logger. */
  anthropicApiKey?: string;
  /** Price-source credentials from the environment; also registered with the logger. */
  priceKeys?: PriceKeys;
}

export interface PriceKeys {
  porkbun?: { apiKey: string; secretApiKey: string };
  namecom?: { username: string; token: string };
}

/** Reads price-source credentials. A source needs every one of its variables. */
export function priceKeysFromEnv(env: Record<string, string | undefined>): PriceKeys {
  const get = (name: string) => env[name]?.trim() || undefined;
  const apiKey = get("PORKBUN_API_KEY");
  const secretApiKey = get("PORKBUN_SECRET_API_KEY");
  const username = get("NAMECOM_USERNAME");
  const token = get("NAMECOM_TOKEN");
  return {
    ...(apiKey && secretApiKey ? { porkbun: { apiKey, secretApiKey } } : {}),
    ...(username && token ? { namecom: { username, token } } : {}),
  };
}

/** Every secret in PriceKeys, for the redacting logger. */
export function priceSecrets(keys: PriceKeys): string[] {
  return [keys.porkbun?.apiKey, keys.porkbun?.secretApiKey, keys.namecom?.token].filter(
    (s): s is string => !!s,
  );
}

/** Resolves the assessment mode from config, the command, and whether a key is set. */
export function resolveAssessmentMode(
  configured: AssessmentMode | undefined,
  command: "mcp" | "check",
  hasKey: boolean,
): AssessmentMode {
  if (configured) return configured;
  if (command === "mcp") return "client";
  return hasKey ? "anthropic" : "off";
}

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

async function openCache(cacheDir: string, logger: Logger): Promise<SqliteStore | undefined> {
  try {
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const path = join(cacheDir, "cache.db");
    let driver: SqliteDriver;
    if (isBun) {
      const { openBunSqlite } = await import("@titlesearch/cache/sqlite/bun");
      driver = openBunSqlite(path);
    } else {
      const { openNodeSqlite } = await import("@titlesearch/cache/sqlite/node");
      driver = openNodeSqlite(path);
    }
    return new SqliteStore(driver);
  } catch (err) {
    // A broken cache must never stop a check; run uncached instead.
    logger.warn("Cache unavailable; continuing without it", { error: err });
    return undefined;
  }
}

export interface Runtime {
  services: TitlesearchServices;
  /** Which browser previews use, if any. */
  browser: "system" | "downloaded" | null;
  /** Stops the preview browser, if one started. */
  close(): Promise<void>;
}

async function wasmLoader(): Promise<WasmLoader> {
  if (!isBun) return nodeWasmLoader;
  const { bunWasmLoader } = await import("./wasm-bun.js");
  return bunWasmLoader;
}

export async function createServices(options: RuntimeOptions): Promise<Runtime> {
  const { config, logger } = options;
  const cache =
    options.noCache || !config.cache.enabled
      ? undefined
      : await openCache(options.cacheDir, logger);

  const providers: AvailabilityProvider[] = [
    new RdapProvider({
      ...(cache ? { cache } : {}),
      whois: { connector: nodeWhoisConnector, enable: config.whois.enable },
    }),
  ];
  if (config.providers.godaddy.enabled && !options.noGodaddy) {
    providers.push(new UpstreamMcpProvider(GODADDY_MCP, { mappings: builtInMappings() }));
  }
  // Price sources: Porkbun is the default; Name.com is the alternative or second opinion.
  const keys = options.priceKeys ?? {};
  if (keys.porkbun && config.providers.porkbun.enabled) {
    providers.push(new PorkbunProvider(keys.porkbun));
  }
  if (keys.namecom && config.providers.namecom.enabled) {
    providers.push(
      new NamecomProvider({ ...keys.namecom, environment: config.providers.namecom.environment }),
    );
  }

  const rateLimiter = createDefaultRateLimiter();
  const dns = new DohResolver();
  // Preview images share the cache's SQLite file, or memory when caching is off.
  const blobs = cache ?? new MemoryStore();
  let renderer: LocalChromiumRenderer | undefined;
  const systemBrowser = findBrowser();
  const downloadedBrowser = systemBrowser ? undefined : await installedChromium(options.dataDir);
  const browser = systemBrowser ? "system" : downloadedBrowser ? "downloaded" : null;
  if (config.previews.mode === "local") {
    // An installed Chrome or Edge first, then the verified download from `titlesearch browser install`.
    const executablePath = systemBrowser ?? downloadedBrowser;
    if (executablePath)
      renderer = new LocalChromiumRenderer({ executablePath, resolver: dns, logger });
    else
      logger.info(
        "No Chrome or Edge found, so previews use share images. Run `titlesearch browser install` for screenshots.",
      );
  }
  const previewer = createPreviewer({
    blobs,
    ...(renderer ? { renderer } : {}),
    shareImage: { encoder: createWebpEncoder(await wasmLoader()), resolver: dns },
    logger,
  });
  const probe: PresenceProbe = (domain, signal) =>
    probePresence(domain, { dns, signal, previewer });
  const mode = resolveAssessmentMode(
    config.assessment.mode,
    options.command,
    !!options.anthropicApiKey,
  );
  let classifier: AnthropicClassifier | undefined;
  if (mode === "anthropic") {
    if (!options.anthropicApiKey) {
      throw new ConfigError('assessment.mode is "anthropic", but ANTHROPIC_API_KEY isn\'t set.');
    }
    classifier = new AnthropicClassifier({
      apiKey: options.anthropicApiKey,
      model: config.assessment.model,
      effort: config.assessment.effort,
      refusalFallback: config.assessment.refusalFallback,
      logger,
    });
  }

  return {
    browser,
    services: {
      providers,
      probe,
      blobs,
      assessment: { mode, ...(classifier ? { classifier } : {}) },
      ...(cache ? { cache } : {}),
      context: (signal: AbortSignal): ProviderContext => ({ signal, rateLimiter, logger }),
    },
    close: async () => {
      await renderer?.close();
    },
  };
}
