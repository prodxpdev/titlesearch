export {
  DEFAULT_DOH_ENDPOINTS,
  type DnsAnswer,
  DnsError,
  type DnsRecordType,
  type DohEndpoint,
  DohResolver,
  type DohResolverOptions,
} from "./doh.js";
export {
  type BlockReason,
  classifyIp,
  type IpClass,
  type IpFamily,
  parseIPv4,
  parseIPv6,
} from "./ip.js";
export {
  createOriginFetch,
  type OriginFetch,
  OriginFetchError,
  type OriginFetchInit,
  type OriginFetchOptions,
} from "./origin-fetch.js";
export type { Resolver } from "./resolver.js";
// readSafeFetchBody is deliberately not exported: only core/extract reads bodies.
export {
  SAFE_FETCH_MAX_BYTES,
  SAFE_FETCH_MAX_REDIRECTS,
  SAFE_FETCH_TIMEOUT_MS,
  SafeFetchError,
  type SafeFetchErrorCode,
  type SafeFetchHop,
  type SafeFetchOptions,
  type SafeFetchResult,
  safeFetch,
} from "./safe-fetch.js";
export { globalFetchTransport, type Transport, type TransportRequest } from "./transport.js";
