// DNS over HTTPS through the JSON API, so DNS behaves the same on every
// runtime. Cloudflare is tried first and Google second. Response shapes were
// recorded into fixtures/doh/.

import * as z from "zod";
import { parseIPv4, parseIPv6 } from "./ip.js";
import { createOriginFetch, type OriginFetch } from "./origin-fetch.js";
import type { Resolver } from "./resolver.js";
import type { Transport } from "./transport.js";

export type DnsRecordType = "A" | "AAAA" | "NS" | "MX";

const TYPE_CODES: Record<DnsRecordType, number> = { A: 1, NS: 2, MX: 15, AAAA: 28 };

export interface DohEndpoint {
  id: string;
  url: string;
}

export const DEFAULT_DOH_ENDPOINTS: readonly DohEndpoint[] = [
  { id: "cloudflare", url: "https://cloudflare-dns.com/dns-query" },
  { id: "google", url: "https://dns.google/resolve" },
];

const DohResponseSchema = z.object({
  Status: z.number().int(),
  TC: z.boolean().optional(),
  Answer: z
    .array(z.object({ name: z.string(), type: z.number().int(), data: z.string() }))
    .optional(),
});

export interface DnsAnswer {
  /** `nxdomain` means the name doesn't exist. `ok` with no records means it exists without records of this type. */
  status: "ok" | "nxdomain";
  /**
   * Record data for the requested type. A and AAAA are addresses. NS are
   * lowercase host names without the trailing dot. MX are "priority host"
   * strings as the resolver returned them.
   */
  records: string[];
  /** Which endpoint answered. */
  endpoint: string;
}

export class DnsError extends Error {
  override readonly name = "DnsError";
  constructor(
    message: string,
    readonly attempts: readonly { endpoint: string; reason: string }[],
  ) {
    super(message);
  }
}

export interface DohResolverOptions {
  endpoints?: readonly DohEndpoint[];
  transport?: Transport;
  timeoutMs?: number;
}

export class DohResolver implements Resolver {
  readonly #endpoints: readonly DohEndpoint[];
  readonly #fetch: OriginFetch;

  constructor(options: DohResolverOptions = {}) {
    this.#endpoints = options.endpoints ?? DEFAULT_DOH_ENDPOINTS;
    this.#fetch = createOriginFetch({
      origins: this.#endpoints.map((e) => new URL(e.url).origin),
      maxBytes: 64 * 1024,
      timeoutMs: options.timeoutMs ?? 3_000,
      ...(options.transport ? { transport: options.transport } : {}),
    });
  }

  async query(name: string, type: DnsRecordType, signal?: AbortSignal): Promise<DnsAnswer> {
    const attempts: { endpoint: string; reason: string }[] = [];
    for (const endpoint of this.#endpoints) {
      try {
        const answer = await this.#queryOne(endpoint, name, type, signal);
        if (answer) return answer;
        attempts.push({ endpoint: endpoint.id, reason: "no usable answer" });
      } catch (err) {
        if (signal?.aborted) throw err;
        attempts.push({
          endpoint: endpoint.id,
          reason: err instanceof Error ? err.message : "failed",
        });
      }
    }
    throw new DnsError(`DNS lookup for ${name} (${type}) failed on every resolver.`, attempts);
  }

  async resolveHost(name: string, signal?: AbortSignal): Promise<string[]> {
    // Both families must succeed; see Resolver.resolveHost.
    const [a, aaaa] = await Promise.all([
      this.query(name, "A", signal),
      this.query(name, "AAAA", signal),
    ]);
    return [...a.records, ...aaaa.records];
  }

  async #queryOne(
    endpoint: DohEndpoint,
    name: string,
    type: DnsRecordType,
    signal: AbortSignal | undefined,
  ): Promise<DnsAnswer | undefined> {
    const url = new URL(endpoint.url);
    url.searchParams.set("name", name);
    url.searchParams.set("type", type);
    const res = await this.#fetch(url, {
      headers: { accept: "application/dns-json" },
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) return undefined;
    const parsed = DohResponseSchema.safeParse(await res.json());
    if (!parsed.success || parsed.data.TC) return undefined;

    const { Status, Answer = [] } = parsed.data;
    if (Status === 3) return { status: "nxdomain", records: [], endpoint: endpoint.id };
    // SERVFAIL, REFUSED, and the rest: let the next resolver try.
    if (Status !== 0) return undefined;

    const records: string[] = [];
    for (const rr of Answer) {
      // CNAMEs in the chain are skipped; only the requested type is kept.
      if (rr.type !== TYPE_CODES[type]) continue;
      const data = normalizeRecord(type, rr.data);
      // A malformed record makes the whole answer untrustworthy.
      if (data === undefined) return undefined;
      if (data !== null) records.push(data);
    }
    return { status: "ok", records, endpoint: endpoint.id };
  }
}

/** Returns the normalized record, null to skip it, or undefined if it's malformed. */
function normalizeRecord(type: DnsRecordType, data: string): string | null | undefined {
  switch (type) {
    case "A":
      return parseIPv4(data) ? data : undefined;
    case "AAAA":
      return parseIPv6(data) ? data.toLowerCase() : undefined;
    case "NS": {
      const host = data.toLowerCase().replace(/\.$/, "");
      return host.length > 0 ? host : undefined;
    }
    case "MX": {
      const m = /^(\d+)\s+(\S+)$/.exec(data.trim());
      if (!m) return undefined;
      const host = (m[2] as string).toLowerCase().replace(/\.$/, "");
      // A null MX ("0 .", RFC 7505) says the domain accepts no mail.
      if (host === "") return null;
      return `${m[1]} ${host}`;
    }
  }
}
