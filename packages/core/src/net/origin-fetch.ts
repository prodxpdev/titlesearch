// Fetch for fixed, configured origins: DoH resolvers, the IANA RDAP
// bootstrap, RDAP servers it lists, registrar APIs, upstream MCP servers, and
// the Anthropic API. These hosts come from code or deploy-time config, never
// from a user, so they skip the per-address checks in safeFetch. What they
// get instead is an origin allowlist fixed when the fetcher is created: a
// request or redirect to any other origin is refused before it's sent.

import { readCapped } from "./read-capped.js";
import { globalFetchTransport, type Transport } from "./transport.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface OriginFetchInit {
  method?: "GET" | "POST";
  headers?: HeadersInit;
  body?: string;
  signal?: AbortSignal;
}

/** A fetch restricted to an allowlist of origins. The response body is already fully read and capped. */
export type OriginFetch = (url: string | URL, init?: OriginFetchInit) => Promise<Response>;

export interface OriginFetchOptions {
  /** Origins such as "https://rdap.verisign.com". HTTPS only. */
  origins: readonly string[];
  transport?: Transport;
  timeoutMs?: number;
  maxBytes?: number;
}

export class OriginFetchError extends Error {
  override readonly name = "OriginFetchError";
  constructor(
    readonly code:
      | "origin_not_allowed"
      | "too_many_redirects"
      | "invalid_redirect"
      | "timeout"
      | "too_large",
    message: string,
  ) {
    super(message);
  }
}

export function createOriginFetch(options: OriginFetchOptions): OriginFetch {
  const allowed = new Set(
    options.origins.map((o) => {
      const u = new URL(o);
      if (u.protocol !== "https:") throw new Error(`Origin ${o} must use HTTPS.`);
      return u.origin;
    }),
  );
  const transport = options.transport ?? globalFetchTransport;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const check = (url: URL) => {
    if (!allowed.has(url.origin)) {
      throw new OriginFetchError("origin_not_allowed", `Origin ${url.origin} isn't allowed here.`);
    }
    if (url.username !== "" || url.password !== "") {
      throw new OriginFetchError("origin_not_allowed", "URLs with credentials aren't allowed.");
    }
  };

  return async (input, init = {}) => {
    let url = new URL(input);
    check(url);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    let method = init.method ?? "GET";
    let body = init.body;

    try {
      for (let redirects = 0; ; redirects++) {
        const res = await transport.request(url, {
          method,
          headers: new Headers(init.headers),
          signal,
          ...(body === undefined ? {} : { body }),
        });
        if (REDIRECT_STATUSES.has(res.status)) {
          await res.body?.cancel().catch(() => {});
          const location = res.headers.get("location");
          if (!location)
            throw new OriginFetchError("invalid_redirect", "Redirect without a Location header.");
          if (redirects >= MAX_REDIRECTS) {
            throw new OriginFetchError(
              "too_many_redirects",
              `More than ${MAX_REDIRECTS} redirects.`,
            );
          }
          url = new URL(location, url);
          check(url);
          // 303, and 301/302 after POST, switch to GET as browsers do.
          if (
            res.status === 303 ||
            (method === "POST" && (res.status === 301 || res.status === 302))
          ) {
            method = "GET";
            body = undefined;
          }
          continue;
        }
        const { bytes, truncated } = await readCapped(res, maxBytes);
        if (truncated) {
          throw new OriginFetchError(
            "too_large",
            `Response from ${url.origin} exceeded ${maxBytes} bytes.`,
          );
        }
        const nullBody = res.status === 204 || res.status === 205 || res.status === 304;
        return new Response(nullBody ? null : bytes, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        });
      }
    } catch (err) {
      if (timeout.aborted && !init.signal?.aborted && !(err instanceof OriginFetchError)) {
        throw new OriginFetchError(
          "timeout",
          `No response from ${url.origin} within ${timeoutMs} ms.`,
        );
      }
      throw err;
    }
  };
}
