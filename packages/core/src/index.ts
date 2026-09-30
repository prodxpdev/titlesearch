export {
  availabilityTtl,
  type CacheStore,
  cacheKeys,
  normalizeMarket,
  TTL,
} from "./cache.js";
export {
  type CheckOptions,
  checkDomains,
  expandCandidates,
  MAX_DOMAINS_PER_CALL,
  MAX_NAMES_PER_CALL,
  RequestLimitError,
} from "./check.js";
export { DomainError, domainFor, normalizeDomain, normalizeTld, topLevelLabel } from "./domain.js";
export { decodeBody, type ExtractedPage, extractPage, sniffCharset } from "./extract/extract.js";
export {
  type InspectOptions,
  inspectDomain,
  type PresenceProbe,
  shouldProbe,
  withPresence,
} from "./inspect.js";
export {
  createRedactor,
  type LogFields,
  type Logger,
  REDACTED,
  redactingLogger,
  silentLogger,
} from "./log.js";
export {
  Assessment,
  Availability,
  DnsSummary,
  DomainResult,
  HttpHop,
  Occupancy,
  PageFields,
  PresenceEvidence,
  Price,
  ReconcileReason,
  SourceError,
  SourceResult,
  toUntrustedSiteText,
  UNTRUSTED_SITE_TEXT_MAX,
  UntrustedSiteText,
} from "./model.js";
export * from "./net/index.js";
export {
  extractAskingPrice,
  matchSignals,
  PARKING_SIGNATURES,
  type Signal,
  type SignalInput,
  type Signature,
  SignatureFileSchema,
  SignatureSchema,
} from "./parking.js";
export {
  type DnsClient,
  LOW_CONTENT_CHARS,
  type ProbeOptions,
  type ProbeResult,
  probePresence,
  USER_AGENT,
} from "./presence.js";
export { type AvailabilityProvider, type ProviderContext, sourceError } from "./provider.js";
export {
  abortableSleep,
  type RateLimiter,
  TokenBucketLimiter,
  type TokenBucketOptions,
  unlimited,
} from "./rate-limit.js";
export { REGISTRY_SOURCES, type Reconciliation, reconcile } from "./reconcile.js";
export {
  DEFAULT_TLDS,
  generateVariants,
  PREFIXES,
  SUFFIXES,
  seedLabel,
  VARIANT_STRATEGIES,
  type Variant,
  type VariantStrategy,
} from "./variants.js";
