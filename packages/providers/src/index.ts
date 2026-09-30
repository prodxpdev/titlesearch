export { mapLimit } from "./concurrency.js";
export {
  GODADDY_CHECK_TOOL,
  GODADDY_MAPPING_ID,
  GODADDY_MCP,
  GODADDY_MCP_URL,
  GoDaddySingleCheck,
  godaddyMapping,
} from "./godaddy/godaddy.js";
export { createDefaultRateLimiter } from "./rate-limits.js";
export {
  BOOTSTRAP_TTL_SECONDS,
  type Bootstrap,
  BootstrapSchema,
  createBootstrapLoader,
  IANA_BOOTSTRAP_URL,
  parseBootstrap,
} from "./rdap/bootstrap.js";
export { parseRdapDomain, RdapDomainSchema } from "./rdap/parse.js";
export { RdapProvider, type RdapProviderOptions } from "./rdap/rdap-provider.js";
export { isRetryable, parseRetryAfter, type RetryOptions, withRetries } from "./retry.js";
export {
  type CallToolResult,
  PROTOCOL_VERSION,
  type Tool,
  UpstreamMcpClient,
  UpstreamMcpError,
} from "./upstream-mcp/client.js";
export { describesWrite, UpstreamMcpConfig } from "./upstream-mcp/config.js";
export {
  type MappingOutcome,
  MappingRegistry,
  type UpstreamMapping,
} from "./upstream-mcp/mapping.js";
export {
  type SecretResolver,
  UpstreamMcpProvider,
  type UpstreamMcpProviderOptions,
} from "./upstream-mcp/provider.js";
export { WHOIS_MAX_BYTES, WHOIS_TIMEOUT_MS, type WhoisConnector } from "./whois/connector.js";
export { parseWhois, type WhoisParse } from "./whois/parse.js";
export {
  activeWhoisServers,
  WHOIS_SERVERS,
  type WhoisFormat,
  type WhoisServer,
} from "./whois/servers.js";

import { godaddyMapping } from "./godaddy/godaddy.js";
import { MappingRegistry } from "./upstream-mcp/mapping.js";

/** The mappings that ship with Titlesearch. */
export function builtInMappings(): MappingRegistry {
  return new MappingRegistry([godaddyMapping]);
}
