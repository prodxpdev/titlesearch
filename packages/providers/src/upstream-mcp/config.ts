// Configuration for an upstream MCP availability source (invariant 1).

import * as z from "zod";

/**
 * Tool names that describe a write. A config that allowlists one is rejected,
 * even though the allowlist alone would be enough to stop other tools. Names
 * are split into words on separators and camelCase, so "domains_purchase" and
 * "updateDnsRecord" match but "check_address" doesn't.
 */
const WRITE_VERBS = new Set([
  "register",
  "renew",
  "transfer",
  "purchase",
  "buy",
  "checkout",
  "order",
  "create",
  "update",
  "edit",
  "modify",
  "delete",
  "remove",
  "lock",
  "unlock",
  "set",
  "add",
  "cart",
]);

export function describesWrite(toolName: string): boolean {
  const words = toolName
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  return words.some((w) => WRITE_VERBS.has(w));
}

export const UpstreamMcpConfig = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits, and hyphens"),
    url: z.url().refine((u) => u.startsWith("https://"), "Upstream MCP servers must use HTTPS."),
    transport: z.literal("streamable-http"),
    auth: z.object({ type: z.literal("bearer"), secretRef: z.string().min(1) }).optional(),
    allowedTools: z.array(z.string().min(1)).min(1),
    checkTool: z.string().min(1),
    mapping: z.string().min(1),
  })
  .refine((c) => c.allowedTools.includes(c.checkTool), {
    message: "checkTool must be in allowedTools.",
    path: ["checkTool"],
  })
  .refine((c) => !c.allowedTools.some(describesWrite), {
    message: "allowedTools may not include a tool whose name describes a write.",
    path: ["allowedTools"],
  });
export type UpstreamMcpConfig = z.infer<typeof UpstreamMcpConfig>;
