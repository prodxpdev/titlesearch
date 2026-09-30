// The Titlesearch MCP server: tools over core, independent of transport.
// The CLI connects it to stdio; the HTTP server (step 8) to Streamable HTTP.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type AvailabilityProvider,
  type CacheStore,
  checkDomains,
  DomainError,
  type DomainResult,
  expandCandidates,
  generateVariants,
  type ProviderContext,
  RequestLimitError,
} from "@titlesearch/core";
import { CHECK_DOMAINS_DESCRIPTION, GENERATE_VARIANTS_DESCRIPTION } from "./descriptions.js";
import {
  CheckDomainsInput,
  CheckDomainsOutput,
  GenerateVariantsInput,
  GenerateVariantsOutput,
} from "./schemas.js";

export interface TitlesearchServices {
  providers: readonly AvailabilityProvider[];
  cache?: CacheStore;
  /** Builds a provider context for one tool call. */
  context(signal: AbortSignal): ProviderContext;
}

export const SERVER_NAME = "titlesearch";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

function toolError(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

/** Errors callers can fix by changing their input; anything else is unexpected. */
function inputError(err: unknown): string | undefined {
  if (err instanceof RequestLimitError || err instanceof DomainError) return err.message;
  return undefined;
}

const STATUS_TEXT: Record<DomainResult["availability"], string> = {
  available: "available",
  premium: "premium",
  registered: "registered",
  unregistered_at_registry: "not at the registry (unconfirmed by a registrar)",
  unconfirmed: "unconfirmed: sources disagree",
  error: "error: no source answered",
};

export function summarize(results: readonly DomainResult[]): string {
  return results
    .map((r) => {
      const sources = r.sources
        .map((s) => {
          const price = s.price ? ` ${s.price.amount} ${s.price.currency}` : "";
          return `${s.source}: ${s.availability}${price}${s.error ? ` (${s.error.code})` : ""}`;
        })
        .join("; ");
      return `${r.domain}: ${STATUS_TEXT[r.availability]}${sources ? ` [${sources}]` : ""}`;
    })
    .join("\n");
}

export function createTitlesearchMcpServer(
  services: TitlesearchServices,
  version = "0.0.0",
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version },
    {
      instructions:
        "Titlesearch checks domain availability for product names. It is read-only and isn't a trademark search. Use generate_variants for candidates, then check_domains.",
    },
  );

  server.registerTool(
    "check_domains",
    {
      title: "Check domains",
      description: CHECK_DOMAINS_DESCRIPTION,
      inputSchema: CheckDomainsInput,
      outputSchema: CheckDomainsOutput,
      annotations: READ_ONLY,
    },
    async ({ names, tlds }, extra) => {
      let domains: string[];
      try {
        domains = expandCandidates(names, tlds);
      } catch (err) {
        const message = inputError(err);
        if (message) return toolError(message);
        throw err;
      }
      const results = await checkDomains(domains, services.context(extra.signal), {
        providers: services.providers,
        ...(services.cache ? { cache: services.cache } : {}),
      });
      return {
        content: [{ type: "text", text: summarize(results) }],
        structuredContent: { results },
      };
    },
  );

  server.registerTool(
    "generate_variants",
    {
      title: "Generate variants",
      description: GENERATE_VARIANTS_DESCRIPTION,
      inputSchema: GenerateVariantsInput,
      outputSchema: GenerateVariantsOutput,
      annotations: READ_ONLY,
    },
    async ({ seed, strategies, tlds }) => {
      try {
        const candidates = generateVariants(seed, strategies, tlds);
        return {
          content: [{ type: "text", text: candidates.map((c) => c.domain).join("\n") }],
          structuredContent: { candidates },
        };
      } catch (err) {
        const message = inputError(err);
        if (message) return toolError(message);
        throw err;
      }
    },
  );

  return server;
}
