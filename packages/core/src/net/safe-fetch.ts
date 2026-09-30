// safeFetch: the only way to request a user-derived host (invariant 2).
//
// Every hop is validated before a request is made: scheme, credentials, port,
// host name, and every address the host resolves to. Redirects are followed
// by hand so each Location gets the same checks. The body is read here, capped,
// and kept out of the result's public shape (invariant 3); only core/extract
// can read it, through readSafeFetchBody.

import { classifyIp, parseIPv4, parseIPv6 } from "./ip.js";
import { readCapped } from "./read-capped.js";
import type { Resolver } from "./resolver.js";
import { globalFetchTransport, type Transport } from "./transport.js";

export const SAFE_FETCH_MAX_REDIRECTS = 3;
export const SAFE_FETCH_TIMEOUT_MS = 5_000;
export const SAFE_FETCH_MAX_BYTES = 512 * 1024;
const ALLOWED_PORTS = new Set(["", "80", "443"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// Names that never belong to a public site, whatever DNS says about them.
const BLOCKED_NAME_SUFFIXES = ["localhost", "local", "internal", "home.arpa", "localdomain"];

export type SafeFetchErrorCode =
  | "invalid_url"
  | "blocked_scheme"
  | "blocked_credentials"
  | "blocked_port"
  | "blocked_host"
  | "blocked_address"
  | "dns_failed"
  | "too_many_redirects"
  | "invalid_redirect"
  | "timeout"
  | "network";

export interface SafeFetchHop {
  url: string;
  status: number;
  /** The validated address for this hop. */
  address: string;
}

export class SafeFetchError extends Error {
  override readonly name = "SafeFetchError";
  constructor(
    readonly code: SafeFetchErrorCode,
    message: string,
    /** Hops completed before the failure. */
    readonly chain: readonly SafeFetchHop[] = [],
  ) {
    super(message);
  }
}

export interface SafeFetchResult {
  /** The final URL after redirects. */
  url: string;
  status: number;
  contentType: string | undefined;
  /** Every hop, including the final one. */
  chain: SafeFetchHop[];
  /** True if the body was longer than the cap and was cut off. */
  truncated: boolean;
  /** True if the transport connected to the validated address. */
  pinned: boolean;
}

export interface SafeFetchOptions {
  resolver: Resolver;
  transport?: Transport;
  signal?: AbortSignal;
  /** Can lower the 5-second timeout, never raise it. */
  timeoutMs?: number;
  /** Can lower the 512 KB body cap, never raise it. */
  maxBytes?: number;
  userAgent?: string;
}

// Bodies live here, not on the result, so nothing outside core can read them.
const bodies = new WeakMap<SafeFetchResult, Uint8Array>();

/** For core/extract only. Not exported from the package. */
export function readSafeFetchBody(result: SafeFetchResult): Uint8Array {
  const body = bodies.get(result);
  if (!body) throw new Error("Not a safeFetch result.");
  return body;
}

export async function safeFetch(
  input: string,
  options: SafeFetchOptions,
): Promise<SafeFetchResult> {
  const transport = options.transport ?? globalFetchTransport;
  const timeoutMs = Math.min(options.timeoutMs ?? SAFE_FETCH_TIMEOUT_MS, SAFE_FETCH_TIMEOUT_MS);
  const maxBytes = Math.min(options.maxBytes ?? SAFE_FETCH_MAX_BYTES, SAFE_FETCH_MAX_BYTES);
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  const chain: SafeFetchHop[] = [];
  let url = parseTarget(input, chain);

  try {
    for (let redirects = 0; ; redirects++) {
      signal.throwIfAborted();
      const address = await validateDestination(url, options.resolver, signal, chain);
      signal.throwIfAborted();
      const headers = new Headers({ accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" });
      if (options.userAgent) headers.set("user-agent", options.userAgent);

      let res: Response;
      try {
        res = await transport.request(url, { method: "GET", headers, signal }, address);
      } catch (err) {
        if (signal.aborted) throw err;
        throw new SafeFetchError("network", `Request to ${url.host} failed.`, chain);
      }
      chain.push({ url: url.href, status: res.status, address });

      if (REDIRECT_STATUSES.has(res.status)) {
        await res.body?.cancel().catch(() => {});
        const location = res.headers.get("location");
        if (!location) {
          throw new SafeFetchError(
            "invalid_redirect",
            "Redirect without a Location header.",
            chain,
          );
        }
        if (redirects >= SAFE_FETCH_MAX_REDIRECTS) {
          throw new SafeFetchError(
            "too_many_redirects",
            `More than ${SAFE_FETCH_MAX_REDIRECTS} redirects.`,
            chain,
          );
        }
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          throw new SafeFetchError("invalid_redirect", "Redirect to an invalid URL.", chain);
        }
        url = parseTarget(next.href, chain);
        continue;
      }

      const { bytes, truncated } = await readCapped(res, maxBytes);
      const result: SafeFetchResult = {
        url: url.href,
        status: res.status,
        contentType: res.headers.get("content-type") ?? undefined,
        chain,
        truncated,
        pinned: transport.pinsAddress,
      };
      bodies.set(result, bytes);
      return result;
    }
  } catch (err) {
    if (err instanceof SafeFetchError) throw err;
    if (timeout.aborted && !options.signal?.aborted) {
      throw new SafeFetchError("timeout", `No complete response within ${timeoutMs} ms.`, chain);
    }
    throw err;
  }
}

function parseTarget(input: string, chain: SafeFetchHop[]): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new SafeFetchError("invalid_url", "Not a valid URL.", chain);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new SafeFetchError("blocked_scheme", `Scheme ${url.protocol} isn't allowed.`, chain);
  }
  if (url.username !== "" || url.password !== "") {
    throw new SafeFetchError("blocked_credentials", "URLs with credentials aren't allowed.", chain);
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new SafeFetchError("blocked_port", `Port ${url.port} isn't allowed.`, chain);
  }
  return url;
}

async function validateDestination(
  url: URL,
  resolver: Resolver,
  signal: AbortSignal,
  chain: SafeFetchHop[],
): Promise<string> {
  // URL parsing has already canonicalized IPv4 shorthand, octal, hex, and
  // decimal forms to dotted quads, and IPv6 to its compressed form.
  const host = url.hostname;

  if (host.startsWith("[")) {
    const literal = host.slice(1, -1);
    if (!parseIPv6(literal)) throw new SafeFetchError("invalid_url", "Invalid IPv6 host.", chain);
    return checkAddress(literal, chain);
  }
  if (parseIPv4(host)) return checkAddress(host, chain);

  const name = host.endsWith(".") ? host.slice(0, -1) : host;
  if (
    !name.includes(".") ||
    BLOCKED_NAME_SUFFIXES.some((s) => name === s || name.endsWith(`.${s}`))
  ) {
    throw new SafeFetchError("blocked_host", `Host ${name} isn't a public name.`, chain);
  }

  let addresses: string[];
  try {
    addresses = await resolver.resolveHost(name, signal);
  } catch (err) {
    if (signal.aborted) throw err;
    throw new SafeFetchError("dns_failed", `Couldn't resolve ${name}.`, chain);
  }
  if (addresses.length === 0) {
    throw new SafeFetchError("dns_failed", `${name} has no addresses.`, chain);
  }
  // Every address must be public. If any isn't, the runtime's own resolver
  // could pick it, so the whole host is refused.
  for (const a of addresses) checkAddress(a, chain);
  // Prefer IPv4 for the pinned connection; it's the family every runtime supports.
  return addresses.find((a) => parseIPv4(a)) ?? (addresses[0] as string);
}

function checkAddress(address: string, chain: SafeFetchHop[]): string {
  const c = classifyIp(address);
  if (!c) throw new SafeFetchError("blocked_address", `${address} isn't an IP address.`, chain);
  if (c.blocked) {
    throw new SafeFetchError("blocked_address", `Address is not public (${c.reason}).`, chain);
  }
  return address;
}
