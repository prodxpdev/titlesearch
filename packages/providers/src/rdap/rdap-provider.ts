// RDAP, built in and always on. Speaks for the registry: 404 is "not found"
// (unregistered_at_registry, never "available"), 200 is "registered". Falls
// back to WHOIS for extensions with no HTTPS RDAP service.

import {
  type AvailabilityProvider,
  createOriginFetch,
  type OriginFetch,
  type ProviderContext,
  type SourceResult,
  sourceError,
  type Transport,
  topLevelLabel,
} from "@titlesearch/core";
import { type CacheLike, memoryCache } from "../cache.js";
import { mapLimit } from "../concurrency.js";
import { type RetryOptions, withRetries } from "../retry.js";
import { WHOIS_MAX_BYTES, WHOIS_TIMEOUT_MS, type WhoisConnector } from "../whois/connector.js";
import { parseWhois } from "../whois/parse.js";
import { activeWhoisServers, type WhoisServer } from "../whois/servers.js";
import { type Bootstrap, createBootstrapLoader } from "./bootstrap.js";
import { parseRdapDomain } from "./parse.js";

export interface RdapProviderOptions {
  /** Stores the bootstrap for 24 hours. Defaults to an in-process cache. */
  cache?: CacheLike;
  transport?: Transport;
  retry?: RetryOptions;
  /** Requests in flight at once across all RDAP servers. */
  concurrency?: number;
  /** WHOIS fallback. Without a connector, extensions with no RDAP report `error`. */
  whois?: {
    connector: WhoisConnector;
    /** Extensions to enable beyond the defaults, such as "de". */
    enable?: readonly string[];
  };
}

export class RdapProvider implements AvailabilityProvider {
  readonly id = "rdap";
  readonly #loadBootstrap: (signal?: AbortSignal) => Promise<Bootstrap>;
  readonly #options: RdapProviderOptions;
  readonly #whoisServers: Map<string, WhoisServer>;
  #fetchFor: { publication: string; fetch: OriginFetch } | undefined;

  constructor(options: RdapProviderOptions = {}) {
    this.#options = options;
    this.#loadBootstrap = createBootstrapLoader({
      cache: options.cache ?? memoryCache(),
      ...(options.transport ? { transport: options.transport } : {}),
    });
    this.#whoisServers = options.whois ? activeWhoisServers(options.whois.enable) : new Map();
  }

  /** RDAP answers for every extension, reporting `error` where neither RDAP nor WHOIS can. */
  supports(): boolean {
    return true;
  }

  async check(domains: string[], ctx: ProviderContext): Promise<SourceResult[]> {
    let bootstrap: Bootstrap;
    try {
      bootstrap = await this.#loadBootstrap(ctx.signal);
    } catch (err) {
      ctx.signal.throwIfAborted();
      ctx.logger.warn("RDAP bootstrap unavailable", { error: err });
      const started = Date.now();
      return domains.map(() =>
        sourceError(
          "rdap",
          "bootstrap_unavailable",
          "The RDAP bootstrap couldn't be loaded.",
          started,
        ),
      );
    }
    const rdapFetch = this.#originFetch(bootstrap);
    return mapLimit(domains, this.#options.concurrency ?? 8, (domain) =>
      this.#checkOne(domain, bootstrap, rdapFetch, ctx),
    );
  }

  #originFetch(bootstrap: Bootstrap): OriginFetch {
    if (this.#fetchFor?.publication !== bootstrap.publication) {
      this.#fetchFor = {
        publication: bootstrap.publication,
        fetch: createOriginFetch({
          origins: bootstrap.origins(),
          ...(this.#options.transport ? { transport: this.#options.transport } : {}),
        }),
      };
    }
    return this.#fetchFor.fetch;
  }

  async #checkOne(
    domain: string,
    bootstrap: Bootstrap,
    rdapFetch: OriginFetch,
    ctx: ProviderContext,
  ): Promise<SourceResult> {
    const started = Date.now();
    const tld = topLevelLabel(domain);
    const base = bootstrap.baseUrls(tld)[0];
    if (!base) return this.#whois(domain, tld, ctx, started);

    const url = `${base}domain/${domain}`;
    let res: Response;
    try {
      res = await withRetries(
        async () => {
          await ctx.rateLimiter.acquire(`rdap:${base}`, ctx.signal);
          return rdapFetch(url, {
            headers: { accept: "application/rdap+json" },
            signal: ctx.signal,
          });
        },
        ctx.signal,
        this.#options.retry,
      );
    } catch (err) {
      ctx.signal.throwIfAborted();
      ctx.logger.warn("RDAP request failed", { domain, error: err });
      return sourceError("rdap", "network", "The RDAP server didn't respond.", started);
    }

    const done = (
      fields: Omit<SourceResult, "source" | "checkedAt" | "latencyMs">,
    ): SourceResult => ({
      source: "rdap",
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - started,
      ...fields,
    });

    if (res.status === 404) return done({ availability: "unregistered_at_registry" });
    if (res.status === 200) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return sourceError("rdap", "invalid_response", "The RDAP response isn't JSON.", started);
      }
      const parsed = parseRdapDomain(body, domain);
      if (!parsed.ok) return sourceError("rdap", "invalid_response", parsed.reason, started);
      const raw = {
        ...(parsed.registrar ? { registrar: parsed.registrar } : {}),
        ...(parsed.created ? { created: parsed.created } : {}),
      };
      return done({ availability: "registered", ...(Object.keys(raw).length ? { raw } : {}) });
    }
    if (res.status === 429) {
      return sourceError(
        "rdap",
        "rate_limited",
        "The RDAP server is rate limiting requests.",
        started,
      );
    }
    return sourceError(
      "rdap",
      `http_${res.status}`,
      `The RDAP server returned HTTP ${res.status}.`,
      started,
    );
  }

  async #whois(
    domain: string,
    tld: string,
    ctx: ProviderContext,
    started: number,
  ): Promise<SourceResult> {
    const server = this.#whoisServers.get(tld);
    const connector = this.#options.whois?.connector;
    if (!server || !connector) {
      return sourceError(
        "rdap",
        "no_registry_source",
        `No RDAP or supported WHOIS service for .${tld}.`,
        started,
      );
    }
    let text: string;
    try {
      await ctx.rateLimiter.acquire(`whois:${server.host}`, ctx.signal);
      const timeout = AbortSignal.timeout(WHOIS_TIMEOUT_MS);
      text = await connector.query(server.host, domain, {
        signal: AbortSignal.any([ctx.signal, timeout]),
        maxBytes: WHOIS_MAX_BYTES,
      });
    } catch (err) {
      ctx.signal.throwIfAborted();
      ctx.logger.warn("WHOIS query failed", { domain, host: server.host, error: err });
      return sourceError("whois", "network", "The WHOIS server didn't respond.", started);
    }
    const parsed = parseWhois(text, domain, server.format);
    const base = {
      source: "whois",
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - started,
    };
    switch (parsed.status) {
      case "not_found":
        return { ...base, availability: "unregistered_at_registry" };
      case "registered": {
        const raw = {
          ...(parsed.registrar ? { registrar: parsed.registrar } : {}),
          ...(parsed.created ? { created: parsed.created } : {}),
        };
        return { ...base, availability: "registered", ...(Object.keys(raw).length ? { raw } : {}) };
      }
      case "unrecognized":
        return sourceError(
          "whois",
          "unrecognized_response",
          "The WHOIS response wasn't recognized.",
          started,
        );
    }
  }
}
