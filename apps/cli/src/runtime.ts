// Builds the providers, cache, and per-call context from config.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type AssessmentMode,
  type BuiltinRuntime,
  createJsonModel,
  describeModel,
  MODEL_PROVIDERS,
  ModelChoice,
  ModelClassifier,
  type ModelDescriptor,
  ModelSuggester,
  modelUnavailable,
} from "@titlesearch/assess";
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
  /** From OPENAI_COMPATIBLE_API_KEY, for an OpenAI-compatible server. Also redacted. */
  openaiCompatibleApiKey?: string;
  /** Price-source credentials from the environment; also registered with the logger. */
  priceKeys?: PriceKeys;
  /** Runs the built-in model. Outlives rebuilds, so a running model isn't restarted. */
  builtin?: BuiltinRuntime;
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

/** Resolves the assessment mode from config, the command, and whether the model can be used. */
export function resolveAssessmentMode(
  configured: AssessmentMode | undefined,
  command: "mcp" | "check",
  modelReady: boolean,
): AssessmentMode {
  if (configured) return configured;
  if (command === "mcp") return "client";
  return modelReady ? "server" : "off";
}

/**
 * A model from TITLESEARCH_MODEL ("ollama:llama3.1:8b", "openai-compatible:<id>",
 * or a bare Anthropic id) and TITLESEARCH_MODEL_URL, overriding config.json.
 */
export function modelFromEnv(env: Record<string, string | undefined>): ModelChoice | undefined {
  const raw = env.TITLESEARCH_MODEL?.trim();
  if (!raw) return undefined;
  const colon = raw.indexOf(":");
  const prefix = colon > 0 ? raw.slice(0, colon) : "";
  const known = (MODEL_PROVIDERS as readonly string[]).includes(prefix);
  const parsed = ModelChoice.safeParse({
    provider: known ? prefix : "anthropic",
    id: known ? raw.slice(colon + 1) : raw,
    ...(env.TITLESEARCH_MODEL_URL?.trim() ? { baseUrl: env.TITLESEARCH_MODEL_URL.trim() } : {}),
  });
  if (!parsed.success)
    throw new ConfigError(`TITLESEARCH_MODEL: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return parsed.data;
}

export interface ModelStatus {
  choice: ModelChoice;
  descriptor: ModelDescriptor;
  label: string;
  /** Why the model can't be used yet, or undefined when it can. */
  unavailable: string | undefined;
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
  /** The configured model, and whether it can be used. */
  model: ModelStatus;
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
  const modelKeys = {
    anthropic: options.anthropicApiKey,
    openaiCompatible: options.openaiCompatibleApiKey,
  };
  const choice = config.assessment.model;
  const model = createJsonModel(choice, modelKeys, {
    builtin: options.builtin,
    effort: config.assessment.effort,
    refusalFallback: config.assessment.refusalFallback,
    logger,
  });
  const unavailable = modelUnavailable(choice, modelKeys, options.builtin);
  const mode = resolveAssessmentMode(config.assessment.mode, options.command, !!model);
  if (mode === "server" && !model) {
    throw new ConfigError(
      `assessment.mode is "server", but the model can't be used: ${unavailable}`,
    );
  }
  const classifier = mode === "server" && model ? new ModelClassifier(model, logger) : undefined;
  // Name suggestions use the same model whenever it can be used, whatever the assessment mode.
  const suggester = model ? new ModelSuggester(model, logger) : undefined;
  const descriptor = model?.descriptor ?? {
    provider: choice.provider,
    id: choice.id,
    locality: "remote" as const,
  };

  return {
    browser,
    services: {
      providers,
      probe,
      blobs,
      assessment: { mode, ...(classifier ? { classifier } : {}) },
      ...(suggester ? { suggester } : {}),
      ...(cache ? { cache } : {}),
      context: (signal: AbortSignal): ProviderContext => ({ signal, rateLimiter, logger }),
    },
    close: async () => {
      await renderer?.close();
    },
    model: { choice, descriptor, label: describeModel(descriptor), unavailable },
  };
}
