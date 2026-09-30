// WHOIS servers for extensions with no HTTPS RDAP service. Hosts come from
// IANA's root zone database (whois.iana.org). Each enabled entry has recorded
// "registered" and "not found" responses in fixtures/whois/ that its parser is
// tested against. An extension that isn't here, or isn't enabled, reports
// `error`: WHOIS formats differ too much to guess.
//
// See docs/decisions/0008-whois-fallback.md for why some servers are excluded.

export type WhoisFormat =
  /** ICANN-style "Domain Name:" records with a fixed not-found line. */
  | { kind: "icann"; notFound: RegExp }
  /** DENIC's "Domain:" / "Status: free|connect" format. */
  | { kind: "denic" };

export interface WhoisServer {
  host: string;
  format: WhoisFormat;
  enabledByDefault: boolean;
  note?: string;
}

const identityDigital = (host: string): WhoisServer => ({
  host,
  format: { kind: "icann", notFound: /^Domain not found\.$/m },
  enabledByDefault: true,
});

export const WHOIS_SERVERS: Readonly<Record<string, WhoisServer>> = {
  io: identityDigital("whois.nic.io"),
  sh: identityDigital("whois.nic.sh"),
  ac: identityDigital("whois.nic.ac"),
  me: identityDigital("whois.nic.me"),
  co: {
    host: "whois.registry.co",
    format: { kind: "icann", notFound: /^The queried object does not exist: DOMAIN NOT FOUND$/m },
    enabledByDefault: true,
  },
  us: {
    host: "whois.nic.us",
    format: { kind: "icann", notFound: /^No Data Found$/m },
    enabledByDefault: true,
  },
  de: {
    host: "whois.denic.de",
    format: { kind: "denic" },
    enabledByDefault: false,
    note: "DENIC limits use to technical or administrative necessities of Internet operation. Enable only after reviewing its terms.",
  },
};

/** Resolves which servers are active: the defaults, plus explicitly enabled extensions. */
export function activeWhoisServers(enable: readonly string[] = []): Map<string, WhoisServer> {
  const active = new Map<string, WhoisServer>();
  for (const [tld, server] of Object.entries(WHOIS_SERVERS)) {
    if (server.enabledByDefault || enable.includes(tld)) active.set(tld, server);
  }
  return active;
}
