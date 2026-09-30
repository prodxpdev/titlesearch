// Provider health, for the Providers screen. Health uses only the read-only
// check method: each provider checks a domain that's always registered.

import type { AvailabilityProvider, ProviderContext } from "@titlesearch/core";

/** Registered to IANA for documentation, and never expiring. */
export const HEALTH_DOMAIN = "example.com";
const TTL_MS = 5 * 60 * 1000;

export interface ProviderHealth {
  id: string;
  status: "ok" | "degraded" | "error";
  checkedAt: string;
  latencyMs: number;
  error?: { code: string; message: string };
}

export function createHealthCheck(now: () => number = Date.now) {
  let cached: { at: number; key: string; value: ProviderHealth[] } | undefined;
  return async (
    providers: readonly AvailabilityProvider[],
    ctx: ProviderContext,
  ): Promise<ProviderHealth[]> => {
    const key = providers.map((p) => p.id).join(",");
    if (cached && cached.key === key && now() - cached.at < TTL_MS) return cached.value;
    const value = await Promise.all(
      providers.map(async (p): Promise<ProviderHealth> => {
        const t0 = now();
        try {
          const [r] = await p.check([HEALTH_DOMAIN], ctx);
          const latencyMs = now() - t0;
          const checkedAt = new Date().toISOString();
          if (!r || r.availability === "error") {
            return {
              id: p.id,
              status: "error",
              checkedAt,
              latencyMs,
              error: r?.error ?? { code: "no_result", message: "No answer." },
            };
          }
          // example.com is always registered; any other answer means something's off.
          return {
            id: p.id,
            status: r.availability === "registered" ? "ok" : "degraded",
            checkedAt,
            latencyMs,
          };
        } catch {
          return {
            id: p.id,
            status: "error",
            checkedAt: new Date().toISOString(),
            latencyMs: now() - t0,
            error: { code: "failed", message: "The check failed." },
          };
        }
      }),
    );
    cached = { at: now(), key, value };
    return value;
  };
}
