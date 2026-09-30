// Loads the recorded site cases in fixtures/sites/ and replays them: DNS
// answers from case.json, every hop (including connection errors), and the
// final body. Works on Node, Bun, and workerd because Vite inlines the files.

import type { DnsAnswer, DnsRecordType } from "../src/net/doh.js";
import type { Transport } from "../src/net/transport.js";
import type { DnsClient } from "../src/presence.js";

export interface SiteCase {
  name: string;
  domain: string;
  dns: { A: string[]; AAAA: string[]; NS: string[]; MX: string[] };
  hops: { url: string; status?: number; location?: string; contentType?: string; error?: string }[];
  body: string | undefined;
}

const cases = import.meta.glob<Omit<SiteCase, "name" | "body">>(
  "../../../fixtures/sites/*/case.json",
  {
    eager: true,
    import: "default",
  },
);
const bodies = import.meta.glob<string>("../../../fixtures/sites/*/body.html", {
  eager: true,
  query: "?raw",
  import: "default",
});

const nameOf = (path: string) => path.split("/").at(-2) as string;

export const SITE_CASES: Map<string, SiteCase> = new Map(
  Object.entries(cases).map(([path, c]) => {
    const name = nameOf(path);
    const body = bodies[path.replace("case.json", "body.html")];
    return [name, { ...c, name, body }];
  }),
);

export function siteCase(name: string): SiteCase {
  const c = SITE_CASES.get(name);
  if (!c) throw new Error(`No fixture case ${name}`);
  return c;
}

const PUBLIC = "93.184.215.14";

/** DNS from the recording for the case's domain; any other host resolves to a public address. */
export function replayDns(c: SiteCase): DnsClient {
  const answer = (records: string[]): DnsAnswer => ({ status: "ok", records, endpoint: "fixture" });
  return {
    async query(name: string, type: DnsRecordType) {
      if (name !== c.domain) return answer(type === "A" ? [PUBLIC] : []);
      const records = c.dns[type].map((r) =>
        type === "NS" ? r.toLowerCase().replace(/\.$/, "") : r,
      );
      return answer(records);
    },
    async resolveHost(name: string) {
      if (name !== c.domain) return [PUBLIC];
      return [...c.dns.A, ...c.dns.AAAA];
    },
  };
}

/** Replays each recorded hop by URL. A recorded error becomes a network failure. */
export function replayTransport(c: SiteCase): Transport & { urls: string[] } {
  const urls: string[] = [];
  return {
    pinsAddress: false,
    urls,
    async request(url) {
      urls.push(url.href);
      const hop = c.hops.find((h) => h.url === url.href);
      if (!hop) throw new TypeError(`fetch failed: no recording for ${url.href}`);
      if (hop.error) throw new TypeError(`fetch failed: ${hop.error}`);
      const headers = new Headers();
      if (hop.contentType) headers.set("content-type", hop.contentType);
      if (hop.location) headers.set("location", hop.location);
      const isFinal = hop === c.hops.at(-1);
      const body =
        isFinal && hop.status !== undefined && ![204, 304].includes(hop.status)
          ? (c.body ?? "")
          : null;
      return new Response(hop.location ? null : body, { status: hop.status ?? 200, headers });
    },
  };
}
