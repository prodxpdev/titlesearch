// The IANA RDAP bootstrap for DNS (RFC 9224), cached for 24 hours. Only
// HTTPS service URLs are used; a TLD with only HTTP URLs is treated as having
// no RDAP service and falls back to WHOIS.

import { createOriginFetch, type Transport } from "@titlesearch/core";
import * as z from "zod";
import type { CacheLike } from "../cache.js";

export const IANA_BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
export const BOOTSTRAP_TTL_SECONDS = 24 * 60 * 60;
const CACHE_KEY = "rdap:bootstrap:dns:v1";

export const BootstrapSchema = z.object({
  version: z.string(),
  publication: z.string(),
  services: z.array(z.tuple([z.array(z.string()), z.array(z.string())])),
});
export type BootstrapFile = z.infer<typeof BootstrapSchema>;

export interface Bootstrap {
  publication: string;
  /** HTTPS base URLs for a TLD, each ending in "/". Empty if the TLD has no HTTPS RDAP service. */
  baseUrls(tld: string): string[];
  /** Every origin the bootstrap names, for the fixed-origin allowlist. */
  origins(): string[];
}

export function parseBootstrap(file: BootstrapFile): Bootstrap {
  const byTld = new Map<string, string[]>();
  const origins = new Set<string>();
  for (const [tlds, urls] of file.services) {
    const https = urls
      .filter((u) => u.startsWith("https://"))
      .map((u) => (u.endsWith("/") ? u : `${u}/`));
    for (const u of https) origins.add(new URL(u).origin);
    for (const tld of tlds) byTld.set(tld.toLowerCase(), https);
  }
  return {
    publication: file.publication,
    baseUrls: (tld) => byTld.get(tld.toLowerCase()) ?? [],
    origins: () => [...origins],
  };
}

export interface BootstrapLoaderOptions {
  cache: CacheLike;
  transport?: Transport;
}

/** Loads the bootstrap from cache or IANA. Concurrent callers share one request. */
export function createBootstrapLoader(options: BootstrapLoaderOptions) {
  const fetchIana = createOriginFetch({
    origins: [new URL(IANA_BOOTSTRAP_URL).origin],
    ...(options.transport ? { transport: options.transport } : {}),
  });
  let inflight: Promise<Bootstrap> | undefined;

  const load = async (signal?: AbortSignal): Promise<Bootstrap> => {
    const cached = await options.cache.get<BootstrapFile>(CACHE_KEY);
    if (cached) {
      const parsed = BootstrapSchema.safeParse(cached);
      if (parsed.success) return parseBootstrap(parsed.data);
    }
    const res = await fetchIana(IANA_BOOTSTRAP_URL, {
      headers: { accept: "application/json" },
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) throw new Error(`The RDAP bootstrap request failed with HTTP ${res.status}.`);
    const parsed = BootstrapSchema.safeParse(await res.json());
    if (!parsed.success) throw new Error("The RDAP bootstrap file failed validation.");
    await options.cache.set(CACHE_KEY, parsed.data, BOOTSTRAP_TTL_SECONDS);
    return parseBootstrap(parsed.data);
  };

  return (signal?: AbortSignal): Promise<Bootstrap> => {
    inflight ??= load(signal).finally(() => {
      inflight = undefined;
    });
    return inflight;
  };
}
