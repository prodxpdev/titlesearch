// The availability provider contract. Invariant 1: this interface has no
// write methods, and test/provider.test.ts fails if one is added.

import type { Logger } from "./log.js";
import type { SourceResult } from "./model.js";
import type { RateLimiter } from "./rate-limit.js";

export interface ProviderContext {
  signal: AbortSignal;
  /** Keyed limiter; providers pick keys, such as one per RDAP base URL. */
  rateLimiter: RateLimiter;
  /** Redacts configured secrets from every message and field. */
  logger: Logger;
}

export interface AvailabilityProvider {
  /** Stable id, reported as SourceResult.source. */
  readonly id: string;
  /** Whether this provider can answer for an extension (last label, lowercase). */
  supports(tld: string): boolean;
  /**
   * Returns exactly one SourceResult per input domain, in input order. A
   * failure for one domain is reported in its result as `error`; it never
   * rejects the whole call unless the context is aborted.
   */
  check(domains: string[], ctx: ProviderContext): Promise<SourceResult[]>;
}

/** Builds an `error` SourceResult. */
export function sourceError(
  source: string,
  code: string,
  message: string,
  startedAt: number,
): SourceResult {
  return {
    source,
    availability: "error",
    checkedAt: new Date().toISOString(),
    latencyMs: Math.max(0, Date.now() - startedAt),
    error: { code, message },
  };
}
