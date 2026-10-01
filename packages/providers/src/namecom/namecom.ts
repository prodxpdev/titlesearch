// Name.com: the second price source (CLAUDE.md, Providers). A direct REST
// adapter for Check Availability, written from Name.com's Core API spec 1.35.0
// (fixtures/namecom/spec-contract.json). Read-only: it calls
// /core/v1/domains:checkAvailability and nothing else. See
// docs/decisions/0017-price-sources.md.

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

export const NAMECOM_ID = "namecom";
export const NAMECOM_API = "https://api.name.com";
/** The sandbox. Its usernames end in "-test", and it takes sandbox tokens only. */
export const NAMECOM_TEST_API = "https://api.dev.name.com";
/** Check Availability's per-call maximum. */
export const NAMECOM_BATCH = 50;
// Don't encode the colon: the spec says the encoded form isn't accepted.
const CHECK_PATH = "/core/v1/domains:checkAvailability";

export const NamecomSearchResult = z.object({
  domainName: z.string(),
  purchasable: z.boolean().optional(),
  premium: z.boolean().optional(),
  purchasePrice: z.number().finite().nonnegative().optional(),
  purchaseType: z.string().optional(),
});

export const NamecomCheckResponse = z.object({
  results: z.array(z.unknown()).optional(),
});

const NamecomError = z.object({ message: z.string(), details: z.string().nullish() });

export interface NamecomOptions {
  username: string;
  token: string;
  /** "test" uses the sandbox at api.dev.name.com. */
  environment?: "production" | "test";
  transport?: Transport;
  retry?: RetryOptions;
}

function basicAuth(username: string, token: string): string {
  // btoa only takes Latin-1, so encode as UTF-8 bytes first.
  const bytes = new TextEncoder().encode(`${username}:${token}`);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `Basic ${btoa(binary)}`;
}

export class NamecomProvider implements AvailabilityProvider {
  readonly id = NAMECOM_ID;
  readonly #options: NamecomOptions;
  readonly #base: string;
  readonly #fetch: OriginFetch;

  constructor(options: NamecomOptions) {
    if (!options.username || !options.token)
      throw new Error("Name.com needs a username and an API token.");
    this.#options = options;
    this.#base = options.environment === "test" ? NAMECOM_TEST_API : NAMECOM_API;
    this.#fetch = createOriginFetch({
      origins: [new URL(this.#base).origin],
      timeoutMs: 20_000,
      maxBytes: 1024 * 1024,
      ...(options.transport ? { transport: options.transport } : {}),
    });
  }

  /** Extensions Name.com doesn't sell are left out of its answer and reported as errors. */
  supports(): boolean {
    return true;
  }

  async check(domains: string[], ctx: ProviderContext): Promise<SourceResult[]> {
    const out: SourceResult[] = [];
    for (let i = 0; i < domains.length; i += NAMECOM_BATCH) {
      out.push(...(await this.#batch(domains.slice(i, i + NAMECOM_BATCH), ctx)));
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
          await ctx.rateLimiter.acquire(this.id, ctx.signal);
          return this.#fetch(`${this.#base}${CHECK_PATH}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: basicAuth(this.#options.username, this.#options.token),
            },
            // Registration only: aftermarket, expiring, and backorder listings
            // are names someone else holds, and come back as not purchasable.
            body: JSON.stringify({ domainNames: batch, purchaseType: "registration" }),
            signal: ctx.signal,
          });
        },
        ctx.signal,
        this.#options.retry,
      );
    } catch (err) {
      ctx.signal.throwIfAborted();
      ctx.logger.warn("Name.com request failed", { error: err });
      return all("network", "Name.com didn't respond.");
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return all("invalid_response", "Name.com's response isn't JSON.");
    }
    if (!res.ok) {
      const known = NamecomError.safeParse(body).success;
      switch (res.status) {
        case 401:
          return all("unauthorized", "Name.com didn't accept the username and token.");
        case 403:
          return all("forbidden", "Name.com refused the check for this account.");
        case 422:
          // Every domain in the batch is on an extension Name.com doesn't sell.
          return all("unsupported_tld", "Name.com doesn't sell these extensions.");
        case 429:
          return all("rate_limited", "Name.com is rate limiting checks.");
        default:
          return all(
            known ? "upstream_error" : "invalid_response",
            `Name.com returned HTTP ${res.status}.`,
          );
      }
    }
    const parsed = NamecomCheckResponse.safeParse(body);
    if (!parsed.success) return all("invalid_response", "Name.com's response failed validation.");

    // Results come back in no particular order, as punycode; normalize before matching.
    const answers = new Map<string, unknown>();
    for (const raw of parsed.data.results ?? []) {
      const name = (raw as { domainName?: unknown } | null)?.domainName;
      if (typeof name !== "string") continue;
      try {
        answers.set(normalizeDomain(name), raw);
      } catch {
        // An unusable name answers nothing.
      }
    }

    return batch.map((domain): SourceResult => {
      const base = {
        source: this.id,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - started,
      };
      const raw = answers.get(domain);
      if (raw === undefined)
        return sourceError(this.id, "not_checked", "Name.com couldn't check this domain.", started);
      const entry = NamecomSearchResult.safeParse(raw);
      if (!entry.success || entry.data.purchasable === undefined)
        return sourceError(
          this.id,
          "invalid_response",
          "Name.com's answer failed validation.",
          started,
        );
      const r = entry.data;
      if (!r.purchasable) return { ...base, availability: "registered" };
      // The filter asked for registrations; anything else contradicts it.
      if (r.purchaseType !== undefined && r.purchaseType !== "registration")
        return sourceError(
          this.id,
          "inconsistent_response",
          "Name.com offered a non-registration purchase.",
          started,
        );
      return {
        ...base,
        availability: r.premium ? "premium" : "available",
        ...(r.purchasePrice !== undefined
          ? { price: { amount: r.purchasePrice, currency: "USD", period: "first_year" } }
          : {}),
      };
    });
  }
}
