// The availability check shared by every surface: the check_domains MCP tool,
// the CLI's `check`, and POST /api/check. Runs every configured provider that
// supports each extension, reconciles, and caches by the policy in cache.ts.

import { availabilityTtl, type CacheStore, cacheKeys } from "./cache.js";
import { DomainError, normalizeDomain, normalizeTld, topLevelLabel } from "./domain.js";
import { DomainResult, SourceResult } from "./model.js";
import { type AvailabilityProvider, type ProviderContext, sourceError } from "./provider.js";
import { reconcile } from "./reconcile.js";
import { DEFAULT_TLDS } from "./variants.js";

export const MAX_DOMAINS_PER_CALL = 50;
export const MAX_NAMES_PER_CALL = 20;

export class RequestLimitError extends Error {
  override readonly name = "RequestLimitError";
}

/**
 * Turns name ideas and extensions into normalized domains, in input order,
 * without duplicates. A name containing a dot is taken as a full domain and
 * isn't combined with the extensions. Enforces the per-call caps.
 */
export function expandCandidates(
  names: readonly string[],
  tlds: readonly string[] = DEFAULT_TLDS,
): string[] {
  if (names.length === 0) throw new RequestLimitError("Give at least one name.");
  if (names.length > MAX_NAMES_PER_CALL) {
    throw new RequestLimitError(
      `At most ${MAX_NAMES_PER_CALL} names per call; got ${names.length}.`,
    );
  }
  const exts = [...new Set(tlds.map(normalizeTld))];
  const domains = new Set<string>();
  for (const raw of names) {
    const name = raw.trim();
    if (name.includes(".")) {
      domains.add(normalizeDomain(name));
      continue;
    }
    if (exts.length === 0) throw new DomainError(raw, "Give at least one extension.");
    for (const ext of exts) domains.add(normalizeDomain(`${name}.${ext}`));
  }
  if (domains.size > MAX_DOMAINS_PER_CALL) {
    throw new RequestLimitError(
      `At most ${MAX_DOMAINS_PER_CALL} domains per call; these names and extensions make ${domains.size}.`,
    );
  }
  return [...domains];
}

export interface CheckOptions {
  providers: readonly AvailabilityProvider[];
  cache?: CacheStore;
}

export async function checkDomains(
  input: readonly string[],
  ctx: ProviderContext,
  options: CheckOptions,
): Promise<DomainResult[]> {
  const domains = [...new Set(input.map(normalizeDomain))];
  if (domains.length > MAX_DOMAINS_PER_CALL) {
    throw new RequestLimitError(
      `At most ${MAX_DOMAINS_PER_CALL} domains per call; got ${domains.length}.`,
    );
  }
  const providerIds = options.providers.map((p) => p.id);
  const results = new Map<string, DomainResult>();

  // Cached results. The store is shared state, so entries are re-validated.
  if (options.cache) {
    const cache = options.cache;
    await Promise.all(
      domains.map(async (d) => {
        try {
          const hit = DomainResult.safeParse(
            await cache.get(cacheKeys.availability(d, providerIds)),
          );
          if (hit.success && hit.data.domain === d) results.set(d, hit.data);
        } catch (err) {
          ctx.logger.warn("Cache read failed", { domain: d, error: err });
        }
      }),
    );
  }

  const misses = domains.filter((d) => !results.has(d));
  const sourcesByDomain = new Map<string, SourceResult[]>(misses.map((d) => [d, []]));

  const perProvider = await Promise.all(
    options.providers.map(async (provider) => {
      const mine = misses.filter((d) => provider.supports(topLevelLabel(d)));
      if (mine.length === 0) return { mine, sources: [] as SourceResult[] };
      const started = Date.now();
      let sources: SourceResult[];
      try {
        sources = await provider.check(mine, ctx);
      } catch (err) {
        ctx.signal.throwIfAborted();
        ctx.logger.error("Provider failed", { provider: provider.id, error: err });
        return {
          mine,
          sources: mine.map(() =>
            sourceError(provider.id, "provider_failed", "The provider failed.", started),
          ),
        };
      }
      // A provider must return one valid result per domain, in order.
      if (sources.length !== mine.length) {
        ctx.logger.error("Provider returned the wrong number of results", {
          provider: provider.id,
        });
        return {
          mine,
          sources: mine.map(() =>
            sourceError(
              provider.id,
              "invalid_provider_result",
              "The provider's answer was malformed.",
              started,
            ),
          ),
        };
      }
      return {
        mine,
        sources: sources.map((s) => {
          const parsed = SourceResult.safeParse(s);
          return parsed.success
            ? parsed.data
            : sourceError(
                provider.id,
                "invalid_provider_result",
                "The provider's answer was malformed.",
                started,
              );
        }),
      };
    }),
  );

  for (const { mine, sources } of perProvider) {
    mine.forEach((d, i) => {
      const s = sources[i];
      if (s) sourcesByDomain.get(d)?.push(s);
    });
  }

  await Promise.all(
    misses.map(async (d) => {
      const sources = sourcesByDomain.get(d) ?? [];
      const { availability, reason } = reconcile(sources);
      const result: DomainResult = { domain: d, availability, availabilityReason: reason, sources };
      results.set(d, result);
      const ttl = availabilityTtl(availability);
      if (options.cache && ttl !== undefined) {
        try {
          await options.cache.set(cacheKeys.availability(d, providerIds), result, ttl);
        } catch (err) {
          ctx.logger.warn("Cache write failed", { domain: d, error: err });
        }
      }
    }),
  );

  return domains.map((d) => results.get(d) as DomainResult);
}
