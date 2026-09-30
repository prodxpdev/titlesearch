// The one place core touches the global fetch. Everything else in core/net
// sends requests through a Transport so that runtimes able to pin a
// connection to a validated IP can supply their own.

export interface TransportRequest {
  method: "GET" | "POST";
  headers: Headers;
  body?: string;
  signal: AbortSignal;
}

export interface Transport {
  /**
   * True if `request` connects to `address` instead of re-resolving the host.
   * Reported on results so callers can tell whether a DNS answer could have
   * changed between validation and connection.
   */
  readonly pinsAddress: boolean;
  /**
   * Performs a single request. Must not follow redirects: 3xx responses are
   * returned as-is so the caller can validate each hop.
   */
  request(url: URL, init: TransportRequest, address?: string): Promise<Response>;
}

/**
 * Uses the runtime's fetch, which does its own DNS resolution, so the
 * connection is not pinned to the validated address. See
 * docs/decisions/0006-safefetch-address-pinning.md for which runtimes
 * provide a pinning transport.
 */
export const globalFetchTransport: Transport = {
  pinsAddress: false,
  request(url, init) {
    return fetch(url, {
      method: init.method,
      headers: init.headers,
      signal: init.signal,
      redirect: "manual",
      ...(init.body === undefined ? {} : { body: init.body }),
    });
  },
};
