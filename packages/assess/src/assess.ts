// assess_market_conflicts: availability for every extension, presence for
// every taken one, and, with a server-side classifier, a judgment for every
// real site. Shared by the MCP tool, the CLI's `check --market`, and the REST
// API.

import {
  type Assessment,
  cacheKeys,
  checkDomains,
  type DomainResult,
  type InspectOptions,
  type Occupancy,
  type ProviderContext,
  TTL,
  withPresence,
} from "@titlesearch/core";
import * as z from "zod";
import type { AssessmentMode, ConflictClassifier } from "./classifier.js";

export const MAX_MARKET_LENGTH = 1000;

export interface AssessOptions extends InspectOptions {
  mode: AssessmentMode;
  /** Required when mode is "server". */
  classifier?: ConflictClassifier;
}

export interface MarketAssessment {
  market: string;
  mode: AssessmentMode;
  /** The classifier that judged these results, if one ran. */
  assessedBy?: string;
  results: DomainResult[];
}

const OCCUPANCY_FOR_LEVEL: Record<Assessment["level"], Occupancy> = {
  competitor: "competitor",
  possible_overlap: "possible_overlap",
  none: "unrelated",
};

const CachedAssessment = z.object({
  domain: z.string(),
  level: z.enum(["competitor", "possible_overlap", "none"]),
  reasons: z.array(z.string()).min(2).max(4),
  assessedBy: z.string(),
  market: z.string(),
});

/** Runs the probe with at most `limit` sites in flight. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (t: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T);
      }
    }),
  );
  return out;
}

export async function assessMarketConflicts(
  domains: readonly string[],
  market: string,
  ctx: ProviderContext,
  options: AssessOptions,
): Promise<MarketAssessment> {
  const trimmed = market.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_MARKET_LENGTH) {
    throw new RangeError(`Describe the market in 1 to ${MAX_MARKET_LENGTH} characters.`);
  }
  if (options.mode === "server" && !options.classifier) {
    throw new Error('Assessment mode "server" needs a classifier.');
  }

  const checked = await checkDomains(domains, ctx, options);
  const results = await mapLimit(checked, 4, (r) => withPresence(r, ctx, options));

  const classifier = options.mode === "server" ? options.classifier : undefined;
  if (!classifier) return { market: trimmed, mode: options.mode, results };

  // Only real sites are judged. Parked, for-sale, and empty domains already
  // have a deterministic occupancy.
  const toJudge = results.filter((r) => r.occupancy === "unassessed" && r.presence);
  const assessments = new Map<string, Assessment>();

  const misses: typeof toJudge = [];
  await Promise.all(
    toJudge.map(async (r) => {
      if (options.cache) {
        try {
          const key = await cacheKeys.assessment(r.domain, trimmed, classifier.id);
          const hit = CachedAssessment.safeParse(await options.cache.get(key));
          if (hit.success && hit.data.domain === r.domain) {
            assessments.set(r.domain, hit.data);
            return;
          }
        } catch (err) {
          ctx.logger.warn("Cache read failed", { domain: r.domain, error: err });
        }
      }
      misses.push(r);
    }),
  );

  if (misses.length > 0) {
    const fresh = await classifier.assess(
      trimmed,
      misses.map((r) => r.presence as NonNullable<DomainResult["presence"]>),
      ctx.signal,
    );
    for (const a of fresh) {
      assessments.set(a.domain, a);
      if (options.cache) {
        try {
          await options.cache.set(
            await cacheKeys.assessment(a.domain, trimmed, classifier.id),
            a,
            TTL.assessment,
          );
        } catch (err) {
          ctx.logger.warn("Cache write failed", { domain: a.domain, error: err });
        }
      }
    }
  }

  return {
    market: trimmed,
    mode: options.mode,
    assessedBy: classifier.id,
    results: results.map((r) => {
      const a = assessments.get(r.domain);
      return a ? { ...r, assessment: a, occupancy: OCCUPANCY_FOR_LEVEL[a.level] } : r;
    }),
  };
}
