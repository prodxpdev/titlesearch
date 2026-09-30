// inspect_domain: availability plus, for a taken domain, what's there.

import * as z from "zod";
import { cacheKeys, TTL } from "./cache.js";
import { type CheckOptions, checkDomains } from "./check.js";
import { type DomainResult, Occupancy, PresenceEvidence } from "./model.js";
import type { ProbeResult } from "./presence.js";
import type { ProviderContext } from "./provider.js";
import { REGISTRY_SOURCES } from "./reconcile.js";

/** Runs the presence probe for one domain. The runtime supplies DNS and transport. */
export type PresenceProbe = (domain: string, signal: AbortSignal) => Promise<ProbeResult>;

export interface InspectOptions extends CheckOptions {
  probe: PresenceProbe;
}

const CachedPresence = z.object({ evidence: PresenceEvidence, occupancy: Occupancy });

/**
 * Probes registered domains, and unconfirmed ones where a registry source
 * says registered (a resale listing, for example).
 */
export function shouldProbe(result: DomainResult): boolean {
  if (result.availability === "registered") return true;
  return (
    result.availability === "unconfirmed" &&
    result.sources.some((s) => REGISTRY_SOURCES.has(s.source) && s.availability === "registered")
  );
}

export async function withPresence(
  result: DomainResult,
  ctx: ProviderContext,
  options: InspectOptions,
): Promise<DomainResult> {
  if (!shouldProbe(result)) return result;
  const key = cacheKeys.presence(result.domain);
  if (options.cache) {
    try {
      const hit = CachedPresence.safeParse(await options.cache.get(key));
      if (hit.success && hit.data.evidence.domain === result.domain) {
        return { ...result, presence: hit.data.evidence, occupancy: hit.data.occupancy };
      }
    } catch (err) {
      ctx.logger.warn("Cache read failed", { domain: result.domain, error: err });
    }
  }
  const { evidence, occupancy } = await options.probe(result.domain, ctx.signal);
  if (options.cache && occupancy !== undefined) {
    try {
      await options.cache.set(key, { evidence, occupancy }, TTL.presence);
    } catch (err) {
      ctx.logger.warn("Cache write failed", { domain: result.domain, error: err });
    }
  }
  return { ...result, presence: evidence, ...(occupancy ? { occupancy } : {}) };
}

export async function inspectDomain(
  domain: string,
  ctx: ProviderContext,
  options: InspectOptions,
): Promise<DomainResult> {
  const [result] = await checkDomains([domain], ctx, options);
  return withPresence(result as DomainResult, ctx, options);
}
