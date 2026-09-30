// Domain name normalization. Every domain that enters core goes through
// normalizeDomain, so results, cache keys, and provider calls all agree on
// one spelling: lowercase ASCII, punycode for internationalized labels, no
// trailing dot.

import { parseIPv4 } from "./net/ip.js";

export class DomainError extends Error {
  override readonly name = "DomainError";
  constructor(
    readonly input: string,
    message: string,
  ) {
    super(message);
  }
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * Normalizes a domain name, converting internationalized labels to punycode.
 * Throws DomainError for anything that isn't a registrable-looking host name:
 * IP addresses, single labels, URLs, and names with invalid labels.
 */
export function normalizeDomain(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "" || /[\s/\\?#@:%]/.test(trimmed)) {
    throw new DomainError(input, "Enter a domain name like example.com.");
  }

  // The WHATWG URL parser applies UTS #46 (IDNA) mapping and punycode, the
  // same way on every runtime.
  let host: string;
  try {
    host = new URL(`http://${trimmed}/`).hostname;
  } catch {
    throw new DomainError(input, "That isn't a valid domain name.");
  }
  if (host.endsWith(".")) host = host.slice(0, -1);

  if (host.startsWith("[") || parseIPv4(host)) {
    throw new DomainError(input, "IP addresses aren't domain names.");
  }
  if (host.length > 253) throw new DomainError(input, "Domain names are at most 253 characters.");

  const labels = host.split(".");
  if (labels.length < 2) throw new DomainError(input, "Include an extension, like .com.");
  for (const label of labels) {
    if (!LABEL.test(label)) throw new DomainError(input, `"${label}" isn't a valid label.`);
  }
  const tld = labels[labels.length - 1] as string;
  if (/^[0-9]+$/.test(tld)) throw new DomainError(input, "Extensions can't be all digits.");
  return host;
}

/** Normalizes an extension: "IO", ".io", and "io." all become "io". Multi-label suffixes such as "co.uk" are kept. */
export function normalizeTld(input: string): string {
  const t = input.trim().replace(/^\.+/, "").replace(/\.+$/, "");
  // Normalize through a throwaway name so IDN extensions get punycode too.
  const host = normalizeDomain(`x.${t}`);
  return host.slice(2);
}

/** Joins a name and an extension into a normalized domain. */
export function domainFor(name: string, tld: string): string {
  return normalizeDomain(`${name.trim()}.${normalizeTld(tld)}`);
}

/** The last label of a normalized domain, which is what the RDAP bootstrap keys on. */
export function topLevelLabel(domain: string): string {
  return domain.slice(domain.lastIndexOf(".") + 1);
}
