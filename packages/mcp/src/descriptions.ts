// Tool descriptions, written for the model that reads them.

export const CHECK_DOMAINS_DESCRIPTION = `Check whether domain names are free, across several extensions. Read-only: it can't register or buy anything.

Each result has:
- domain: the normalized domain (lowercase, punycode for non-ASCII names).
- availability, one of:
  - "available": a registrar confirmed it can be registered at a standard price.
  - "premium": a registrar confirmed it can be registered, at a premium price.
  - "registered": the registry says someone owns it.
  - "unregistered_at_registry": the registry has no record of it, but no registrar was asked. This is NOT the same as purchasable: the name may be reserved, blocked, or premium. Say so if you report it.
  - "unconfirmed": the sources disagree. Every source is listed; don't pick one. A common case is a registered name listed for resale.
  - "error": no source could answer.
- availabilityReason: which rule produced availability, such as "agreed" or "registry_taken_registrar_free".
- sources: every source consulted, with its own answer, any price it gave (first-year, with currency), when it answered, and any error. "rdap" and "whois" speak for the registry; other ids are registrars.

Prices appear only when a registrar returned one. Don't estimate prices that aren't there.

This checks domain availability only. It isn't a trademark search.`;

export const GENERATE_VARIANTS_DESCRIPTION = `Make candidate domains from a name idea: the seed on other extensions, with common prefixes and suffixes, and its plural. Deterministic and offline: it makes no network requests and says nothing about availability. Pass the candidates you like to check_domains.

Returns candidates, each with its domain and the strategy that produced it ("seed", "tld", "prefix", "suffix", or "plural"). The first is always the seed on the first extension.`;
