// Deterministic name variants for generate_variants. No network, no
// randomness: the same input always gives the same list, in the same order.

import { DomainError, normalizeDomain, normalizeTld } from "./domain.js";

export const VARIANT_STRATEGIES = ["prefix", "suffix", "plural", "tld"] as const;
export type VariantStrategy = (typeof VARIANT_STRATEGIES)[number];

export const DEFAULT_TLDS = ["com", "io", "co", "ai", "app", "dev"] as const;

// Common in product names. Kept short on purpose: variants are candidates for
// a human or model to judge, not a name generator.
export const PREFIXES = ["get", "try", "use", "go", "join", "meet", "hey", "with"] as const;
export const SUFFIXES = ["app", "hq", "labs", "hub", "kit", "now", "ly", "ify"] as const;

export interface Variant {
  domain: string;
  /** The strategy that produced it; "seed" for the seed itself. */
  strategy: VariantStrategy | "seed";
}

function pluralize(label: string): string | undefined {
  if (label.endsWith("s")) return undefined;
  if (/(?:x|z|ch|sh)$/.test(label)) return `${label}es`;
  if (/[^aeiou]y$/.test(label)) return `${label.slice(0, -1)}ies`;
  return `${label}s`;
}

/** Normalizes a seed to a single label ("Acme Cloud" → "acmecloud"). Throws on anything unusable. */
export function seedLabel(seed: string): string {
  const compact = seed.trim().replace(/[\s_]+/g, "");
  const host = normalizeDomain(`${compact.replace(/\.+$/, "")}.com`);
  const label = host.slice(0, -".com".length);
  if (label.includes(".")) throw new DomainError(seed, "Give a name, not a domain, as the seed.");
  return label;
}

/**
 * Generates candidate domains. The primary extension is the first in `tlds`.
 * Prefix, suffix, and plural variants use the primary extension; the "tld"
 * strategy puts the seed on every extension.
 */
export function generateVariants(
  seed: string,
  strategies: readonly VariantStrategy[] = VARIANT_STRATEGIES,
  tlds: readonly string[] = DEFAULT_TLDS,
  limit = 50,
): Variant[] {
  const label = seedLabel(seed);
  const exts = [...new Set(tlds.map(normalizeTld))];
  const primary = exts[0];
  if (!primary) throw new DomainError(seed, "Give at least one extension.");

  const out: Variant[] = [];
  const seen = new Set<string>();
  const add = (name: string, tld: string, strategy: Variant["strategy"]) => {
    let domain: string;
    try {
      domain = normalizeDomain(`${name}.${tld}`);
    } catch {
      return; // e.g. a combination longer than 63 characters
    }
    if (seen.has(domain)) return;
    seen.add(domain);
    out.push({ domain, strategy });
  };

  add(label, primary, "seed");
  if (strategies.includes("tld")) for (const t of exts.slice(1)) add(label, t, "tld");
  if (strategies.includes("plural")) {
    const plural = pluralize(label);
    if (plural) add(plural, primary, "plural");
  }
  if (strategies.includes("prefix"))
    for (const p of PREFIXES) add(`${p}${label}`, primary, "prefix");
  if (strategies.includes("suffix"))
    for (const s of SUFFIXES) add(`${label}${s}`, primary, "suffix");
  return out.slice(0, limit);
}
