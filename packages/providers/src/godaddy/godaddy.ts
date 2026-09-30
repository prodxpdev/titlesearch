// GoDaddy's public MCP server as an upstream-MCP configuration. The schema
// and mapping are written from responses recorded in fixtures/godaddy/; see
// docs/decisions/0009-godaddy-mcp.md for what those recordings showed.

import { normalizeDomain } from "@titlesearch/core";
import * as z from "zod";
import type { CallToolResult } from "../upstream-mcp/client.js";
import type { UpstreamMcpConfig } from "../upstream-mcp/config.js";
import type { MappingOutcome, UpstreamMapping } from "../upstream-mcp/mapping.js";

export const GODADDY_MCP_URL = "https://api.godaddy.com/v1/domains/mcp";
export const GODADDY_CHECK_TOOL = "domains_check_availability";
export const GODADDY_MAPPING_ID = "godaddy-check-availability-v1";

export const GODADDY_MCP: UpstreamMcpConfig = {
  id: "godaddy",
  url: GODADDY_MCP_URL,
  transport: "streamable-http",
  // domains_suggest is also read-only, but Titlesearch doesn't need it.
  allowedTools: [GODADDY_CHECK_TOOL],
  checkTool: GODADDY_CHECK_TOOL,
  mapping: GODADDY_MAPPING_ID,
};

// The single-domain response. Bulk responses (2+ domains) don't distinguish
// premium from standard, so the mapping always checks one domain per call.
const DomainEntry = z.object({
  name: z.string(),
  available: z.boolean(),
  isExactMatch: z.boolean().optional(),
  inventoryType: z.string().optional(),
  purchasable: z.boolean().optional(),
});

export const GoDaddySingleCheck = z.object({
  isAvailable: z.boolean(),
  domains: z.array(DomainEntry),
});

const err = (code: string, message: string): MappingOutcome => ({ error: { code, message } });

function sameDomain(name: string, domain: string): boolean {
  try {
    return normalizeDomain(name) === domain;
  } catch {
    return false;
  }
}

export const godaddyMapping: UpstreamMapping = {
  id: GODADDY_MAPPING_ID,
  tool: GODADDY_CHECK_TOOL,

  buildArguments(domain) {
    // One domain per call. Normalized domains never contain a comma, the
    // tool's list separator.
    return { domains: domain };
  },

  interpret(result: CallToolResult, domain: string): MappingOutcome {
    if (result.isError) return err("upstream_error", "GoDaddy reported an error for this domain.");
    const parsed = GoDaddySingleCheck.safeParse(result.structuredContent);
    if (!parsed.success) return err("invalid_response", "GoDaddy's response failed validation.");

    const exact = parsed.data.domains.filter(
      (d) => d.isExactMatch === true && sameDomain(d.name, domain),
    );
    if (exact.length > 1)
      return err("invalid_response", "GoDaddy returned more than one exact match.");
    const match = exact[0];

    if (!parsed.data.isAvailable) {
      // "Unavailable" must not come with an exact match that says available.
      if (match?.available)
        return err("inconsistent_response", "GoDaddy's response contradicts itself.");
      return { availability: "registered" };
    }

    if (!match?.available) {
      return err(
        "inconsistent_response",
        "GoDaddy said available but returned no matching domain.",
      );
    }
    if (match.purchasable !== true) {
      return err("inconsistent_response", "GoDaddy said available but not purchasable.");
    }
    // GoDaddy's MCP returns no prices (priceInfo is always null), so none are reported.
    switch (match.inventoryType) {
      case "Standard":
        return { availability: "available" };
      case "Registry Premium":
      // Plain "Premium" can be an aftermarket listing of a registered name
      // (bank.app in the fixtures). RDAP then says registered, and
      // reconciliation makes the result unconfirmed.
      case "Premium":
        return { availability: "premium" };
      case "Auction":
        // Sold at auction, not at registry price: not available to register.
        return { availability: "registered" };
      default:
        return err("unknown_inventory_type", `GoDaddy returned an unknown inventory type.`);
    }
  },
};
