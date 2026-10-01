// Porkbun: the default price source (CLAUDE.md, Providers). A direct REST
// adapter for the bulk availability check, written from Porkbun's OpenAPI
// spec v3.48 (fixtures/porkbun/spec-contract.json). Read-only: it calls
// /domain/checkDomain and nothing else. See docs/decisions/0017-price-sources.md.

import {
  type AvailabilityProvider,
  createOriginFetch,
  normalizeDomain,
  type OriginFetch,
  type ProviderContext,
  type SourceResult,
  sourceError,
  type Transport,
} from "@titlesearch/core";
import * as z from "zod";
import { type RetryOptions, withRetries } from "../retry.js";

export const PORKBUN_ID = "porkbun";
export const PORKBUN_API = "https://api.porkbun.com/api/json/v3";
/** The bulk check's per-call maximum. */
export const PORKBUN_BATCH = 25;

const YesNo = z.enum(["yes", "no"]);
const Money = z.string().regex(/^\d+(\.\d{1,2})?$/, "a decimal USD amount");

export const PorkbunDomainEntry = z.object({
  avail: YesNo,
  price: Money,
  premium: YesNo,
  firstYearPromo: YesNo.optional(),
  regularPrice: Money.optional(),
  minDuration: z.number().int().positive().optional(),
});

export const PorkbunBulkResponse = z.object({
  status: z.literal("SUCCESS"),
  domains: z.record(z.string(), z.unknown()),
  unresolved: z.array(z.string()).optional(),
  invalid: z.array(z.unknown()).optional(),
});

const PorkbunError = z.object({
  status: z.literal("ERROR"),
  code: z.string().optional(),
  message: z.string().optional(),
});

export interface PorkbunOptions {
  apiKey: string;
  secretApiKey: string;
  transport?: Transport;
  retry?: RetryOptions;
}

export class PorkbunProvider implements AvailabilityProvider {
  readonly id = PORKBUN_ID;
  readonly #options: PorkbunOptions;
  readonly #fetch: OriginFetch;

  constructor(options: PorkbunOptions) {
    if (!options.apiKey || !options.secretApiKey)
      throw new Error("Porkbun needs an API key and a secret API key.");
    this.#options = options;
    this.#fetch = createOriginFetch({
      origins: [new URL(PORKBUN_API).origin],
      timeoutMs: 20_000,
      maxBytes: 1024 * 1024,
      ...(options.transport ? { transport: options.transport } : {}),
    });
  }

  /** Unsupported extensions come back as "invalid" and are reported as errors. */
  supports(): boolean {
    return true;
  }

  async check(domains: string[], ctx: ProviderContext): Promise<SourceResult[]> {
    const out: SourceResult[] = [];
    for (let i = 0; i < domains.length; i += PORKBUN_BATCH) {
      out.push(...(await this.#batch(domains.slice(i, i + PORKBUN_BATCH), ctx)));
    }
    return out;
  }

  async #batch(batch: string[], ctx: ProviderContext): Promise<SourceResult[]> {
    const started = Date.now();
    const all = (code: string, message: string) =>
      batch.map(() => sourceError(this.id, code, message, started));

    let res: Response;
    try {
      res = await withRetries(
        async () => {
          // The bulk budget counts domains, not requests.
          for (let n = 0; n < batch.length; n++)
            await ctx.rateLimiter.acquire(`${this.id}:bulk`, ctx.signal);
          return this.#fetch(`${PORKBUN_API}/domain/checkDomain`, {
            method: "POST",
            // Keys go in headers, so they're never part of a logged body.
            headers: {
              "content-type": "application/json",
              "x-api-key": this.#options.apiKey,
              "x-secret-api-key": this.#options.secretApiKey,
            },
            body: JSON.stringify({ domains: batch }),
            signal: ctx.signal,
          });
        },
        ctx.signal,
        this.#options.retry,
      );
    } catch (err) {
      ctx.signal.throwIfAborted();
      ctx.logger.warn("Porkbun request failed", { error: err });
      return all("network", "Porkbun didn't respond.");
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return all("invalid_response", "Porkbun's response isn't JSON.");
    }
    const error = PorkbunError.safeParse(body);
    if (res.status === 429 || (error.success && error.data.code === "RATE_LIMIT_EXCEEDED")) {
      return all("rate_limited", "Porkbun is rate limiting checks.");
    }
    // Bad keys come back as INVALID_API_KEYS_001 and similar numbered codes.
    if (error.success && error.data.code?.startsWith("INVALID_API_KEY")) {
      return all("unauthorized", "Porkbun didn't accept the API keys.");
    }
    if (error.success) {
      const code = error.data.code?.toLowerCase() ?? "upstream_error";
      return all(code, `Porkbun refused the check (${error.data.code ?? "error"}).`);
    }
    const parsed = PorkbunBulkResponse.safeParse(body);
    if (!res.ok || !parsed.success)
      return all("invalid_response", "Porkbun's response failed validation.");

    // Keys may be spelled differently (case, Unicode); normalize before matching.
    const answers = new Map<string, unknown>();
    for (const [k, v] of Object.entries(parsed.data.domains)) {
      try {
        answers.set(normalizeDomain(k), v);
      } catch {
        // An unusable key answers nothing.
      }
    }
    const unresolved = new Set<string>();
    for (const u of parsed.data.unresolved ?? []) {
      try {
        unresolved.add(normalizeDomain(u));
      } catch {
        // Ignore.
      }
    }

    return batch.map((domain): SourceResult => {
      const t = Date.now();
      const base = { source: this.id, checkedAt: new Date().toISOString(), latencyMs: t - started };
      if (unresolved.has(domain)) {
        // Porkbun: "NOT a statement of availability".
        return sourceError(
          this.id,
          "unresolved",
          "Porkbun's registry lookup didn't answer.",
          started,
        );
      }
      const raw = answers.get(domain);
      if (raw === undefined)
        return sourceError(this.id, "not_checked", "Porkbun couldn't check this domain.", started);
      const entry = PorkbunDomainEntry.safeParse(raw);
      if (!entry.success)
        return sourceError(
          this.id,
          "invalid_response",
          "Porkbun's answer failed validation.",
          started,
        );
      if (entry.data.avail === "no") return { ...base, availability: "registered" };
      const amount = Number(entry.data.price);
      return {
        ...base,
        availability: entry.data.premium === "yes" ? "premium" : "available",
        price: { amount, currency: "USD", period: "first_year" },
      };
    });
  }
}
