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
  /**
   * Plain-HTTP origins, each named explicitly: cloud metadata servers and
   * local emulators (such as http://metadata.google.internal). Never derived
   * from user input.
   */
  httpOrigins?: readonly string[];
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

interface Allowlist {
  check(url: URL): void;
}

function allowlist(
  origins: readonly string[],
  httpOrigins: readonly string[] = [],
  suffixes: readonly string[] = [],
): Allowlist {
  const allowed = new Set(
    origins.map((o) => {
      const u = new URL(o);
      if (u.protocol !== "https:") throw new Error(`Origin ${o} must use HTTPS.`);
      return u.origin;
    }),
  );
  for (const o of httpOrigins) {
    const u = new URL(o);
    if (u.protocol !== "http:") throw new Error(`HTTP origin ${o} must use http:.`);
    allowed.add(u.origin);
  }
  for (const s of suffixes) {
    if (!/^\.[a-z0-9.-]+\.[a-z]+$/.test(s))
      throw new Error(`Host suffix ${s} must look like ".example.com".`);
  }
  const bySuffix = (url: URL) =>
    url.protocol === "https:" && url.port === "" && suffixes.some((s) => url.hostname.endsWith(s));
  return {
    check(url) {
      if (!allowed.has(url.origin) && !bySuffix(url)) {
        throw new OriginFetchError(
          "origin_not_allowed",
          `Origin ${url.origin} isn't allowed here.`,
        );
      }
      if (url.username !== "" || url.password !== "") {
        throw new OriginFetchError("origin_not_allowed", "URLs with credentials aren't allowed.");
      }
    },
  };
}

/** Sends a request and follows redirects, checking every hop. Returns the final, unread response. */
async function follow(
  input: string | URL,
  init: OriginFetchInit,
  list: Allowlist,
  transport: Transport,
  signal: AbortSignal,
): Promise<{ res: Response; url: URL }> {
  let url = new URL(input);
  list.check(url);
  let method = init.method ?? "GET";
  let body = init.body;
  for (let redirects = 0; ; redirects++) {
    const res = await transport.request(url, {
      method,
      headers: new Headers(init.headers),
      signal,
      ...(body === undefined ? {} : { body }),
    });
    if (!REDIRECT_STATUSES.has(res.status)) return { res, url };
    await res.body?.cancel().catch(() => {});
    const location = res.headers.get("location");
    if (!location)
      throw new OriginFetchError("invalid_redirect", "Redirect without a Location header.");
    if (redirects >= MAX_REDIRECTS) {
      throw new OriginFetchError("too_many_redirects", `More than ${MAX_REDIRECTS} redirects.`);
    }
    url = new URL(location, url);
    list.check(url);
    // 303, and 301/302 after POST, switch to GET as browsers do.
    if (res.status === 303 || (method === "POST" && (res.status === 301 || res.status === 302))) {
      method = "GET";
      body = undefined;
    }
  }
}

export function createOriginFetch(options: OriginFetchOptions): OriginFetch {
  const list = allowlist(options.origins, options.httpOrigins);
  const transport = options.transport ?? globalFetchTransport;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  return async (input, init = {}) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    let url = new URL(input);
    try {
      const followed = await follow(url, init, list, transport, signal);
      const res = followed.res;
      url = followed.url;
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

export interface OriginStreamOptions {
  /** Exact HTTPS origins, as for createOriginFetch. */
  origins: readonly string[];
  /**
   * HTTPS hosts ending in one of these, on the default port: download CDNs
   * whose hostnames vary by region (".hf.co"). Only for downloads whose
   * content is verified against a pinned checksum.
   */
  hostSuffixes?: readonly string[];
  transport?: Transport;
  /** How long to wait for the response headers. The body has no overall limit. */
  headersTimeoutMs?: number;
}

/**
 * A GET restricted to an allowlist, like createOriginFetch, whose body is
 * left unread for the caller to stream: for multi-gigabyte downloads that
 * are verified by checksum as they're written. The caller enforces size and
 * stalls, and cancels through `signal`.
 */
export function createOriginStream(
  options: OriginStreamOptions,
): (
  url: string | URL,
  init?: { signal?: AbortSignal; headers?: HeadersInit },
) => Promise<Response> {
  const list = allowlist(options.origins, [], options.hostSuffixes);
  const transport = options.transport ?? globalFetchTransport;
  const headersTimeoutMs = options.headersTimeoutMs ?? 30_000;
  return async (input, init = {}) => {
    const outer = init.signal;
    const controller = new AbortController();
    const abort = () => controller.abort(outer?.reason);
    outer?.addEventListener("abort", abort, { once: true });
    if (outer?.aborted) abort();
    const timer = setTimeout(
      () => controller.abort(new OriginFetchError("timeout", "No response in time.")),
      headersTimeoutMs,
    );
    try {
      const headers = init.headers ? { headers: init.headers } : {};
      return (await follow(input, headers, list, transport, controller.signal)).res;
    } catch (err) {
      if (controller.signal.reason instanceof OriginFetchError) throw controller.signal.reason;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
}
