// Builds the providers, cache, and per-call context from config.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type SqliteDriver, SqliteStore } from "@titlesearch/cache";
import {
  type AvailabilityProvider,
  type CacheStore,
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
  RdapProvider,
  UpstreamMcpProvider,
} from "@titlesearch/providers";
import { nodeWhoisConnector } from "@titlesearch/providers/whois/node";
import type { CliConfig } from "./config.js";

export interface RuntimeOptions {
  config: CliConfig;
  cacheDir: string;
  logger: Logger;
  /** Overrides from command-line flags. */
  noCache?: boolean;
  noGodaddy?: boolean;
}

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

async function openCache(cacheDir: string, logger: Logger): Promise<CacheStore | undefined> {
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

export async function createServices(options: RuntimeOptions): Promise<TitlesearchServices> {
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

  const rateLimiter = createDefaultRateLimiter();
  const dns = new DohResolver();
  const probe: PresenceProbe = (domain, signal) => probePresence(domain, { dns, signal });
  return {
    providers,
    probe,
    ...(cache ? { cache } : {}),
    context: (signal: AbortSignal): ProviderContext => ({ signal, rateLimiter, logger }),
  };
}
