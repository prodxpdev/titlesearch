// Tool input and output schemas. Shared with the REST API (step 8), so both
// surfaces validate the same shapes.

import {
  DomainResult,
  MAX_DOMAINS_PER_CALL,
  MAX_NAMES_PER_CALL,
  VARIANT_STRATEGIES,
} from "@titlesearch/core";
import * as z from "zod";

const Tlds = z
  .array(z.string().min(1).max(63))
  .min(1)
  .max(20)
  .describe(
    'Extensions without the dot, such as ["com", "io"]. Defaults to com, io, co, ai, app, dev.',
  );

export const CheckDomainsInput = {
  names: z
    .array(z.string().min(1).max(253))
    .min(1)
    .max(MAX_NAMES_PER_CALL)
    .describe(
      `Name ideas, such as "acme". Each is checked on every extension in tlds. A name containing a dot, such as "acme.co.uk", is checked as-is. At most ${MAX_NAMES_PER_CALL} names and ${MAX_DOMAINS_PER_CALL} resulting domains per call.`,
    ),
  tlds: Tlds.optional(),
};

export const CheckDomainsOutput = {
  results: z.array(DomainResult),
};

export const GenerateVariantsInput = {
  seed: z.string().min(1).max(63).describe('A name idea, such as "acme". Spaces are removed.'),
  strategies: z
    .array(z.enum(VARIANT_STRATEGIES))
    .min(1)
    .optional()
    .describe(
      'Which variants to make. "prefix" adds get, try, use, and similar. "suffix" adds hq, app, labs, and similar. "plural" adds an s. "tld" puts the seed on every extension. Defaults to all four.',
    ),
  tlds: Tlds.optional(),
};

export const GenerateVariantsOutput = {
  candidates: z.array(
    z.object({
      domain: z.string(),
      strategy: z.enum(["seed", ...VARIANT_STRATEGIES]),
    }),
  ),
};

/** JSON Schema for every tool input, for docs and non-MCP clients. */
export function toolInputJsonSchemas(): Record<string, unknown> {
  return {
    check_domains: z.toJSONSchema(z.object(CheckDomainsInput)),
    generate_variants: z.toJSONSchema(z.object(GenerateVariantsInput)),
  };
}
