import type { PresenceEvidence } from "@titlesearch/core";

export function site(domain: string, patch: Partial<PresenceEvidence> = {}): PresenceEvidence {
  return {
    domain,
    dns: { hasA: true, hasAAAA: false, hasNS: true, hasMX: true, nameservers: ["ns1.example.com"] },
    http: {
      chain: [{ url: `https://${domain}/`, status: 200 }],
      finalUrl: `https://${domain}/`,
      tlsValid: true,
      pinned: false,
    },
    page: { title: `${domain} home`, jsonLdTypes: ["Organization"] },
    untrustedSiteText: `Welcome to ${domain}.`,
    parkingSignals: [],
    clientRedirects: [],
    probeErrors: [],
    contentConfidence: "normal",
    ...patch,
  };
}
