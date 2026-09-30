// The cache contract and caching policy. Stores live in @titlesearch/cache;
// the contract and policy live here so core's check service can use them.

import type { Availability } from "./model.js";

export interface CacheStore {
  /** Returns the value, or undefined if it's missing or expired. */
  get<T>(key: string): Promise<T | undefined>;
  /**
   * Stores a JSON-serializable value for `ttlSeconds` (a positive, finite
   * number). Replaces any existing value and TTL. Values round-trip through
   * JSON, so what `get` returns is a copy.
   */
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
}

// What gets cached, for how long, and under which key. The TTLs are the
// table in CLAUDE.md. Keys carry a version prefix so a shape change can
// invalidate old entries by bumping it.

const PREFIX = "ts:v1";

export const TTL = {
  registered: 6 * 60 * 60,
  /** Available, premium, or unregistered_at_registry. */
  unclaimed: 10 * 60,
  presence: 6 * 60 * 60,
  rdapBootstrap: 24 * 60 * 60,
  assessment: 24 * 60 * 60,
} as const;

/**
 * TTL for a reconciled availability, or undefined if it must not be cached:
 * unconfirmed results (invariant 4 asks for a fresh look) and errors.
 */
export function availabilityTtl(availability: Availability): number | undefined {
  switch (availability) {
    case "registered":
      return TTL.registered;
    case "available":
    case "premium":
    case "unregistered_at_registry":
      return TTL.unclaimed;
    case "unconfirmed":
    case "error":
      return undefined;
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Normalizes market text so trivial differences share a cache entry. */
export function normalizeMarket(market: string): string {
  return market.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

export const cacheKeys = {
  /**
   * A reconciled availability. Includes the providers consulted, so turning
   * a registrar on or off never serves a result built from other sources.
   */
  availability(domain: string, providerIds: readonly string[]): string {
    return `${PREFIX}:avail:${[...providerIds].sort().join(",")}:${domain}`;
  },
  presence(domain: string): string {
    return `${PREFIX}:presence:${domain}`;
  },
  /** Keyed by domain, a hash of the normalized market text, and the classifier id. */
  async assessment(domain: string, market: string, classifierId: string): Promise<string> {
    const marketHash = (await sha256Hex(normalizeMarket(market))).slice(0, 32);
    return `${PREFIX}:assess:${classifierId}:${marketHash}:${domain}`;
  },
};
