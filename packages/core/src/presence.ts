// The presence probe: what's at a registered domain. DNS over DoH, one
// safeFetch of the home page (HTTPS, then HTTP), field extraction, and
// parking signatures. No headless browser: pages that need JavaScript get
// contentConfidence "low". See CLAUDE.md, Presence probe.

import { decodeBody, extractPage } from "./extract/extract.js";
import type { Occupancy, PresenceEvidence } from "./model.js";
import { toUntrustedSiteText } from "./model.js";
import { type DnsAnswer, DnsError, type DnsRecordType } from "./net/doh.js";
import type { Resolver } from "./net/resolver.js";
import {
  readSafeFetchBody,
  SafeFetchError,
  type SafeFetchResult,
  safeFetch,
} from "./net/safe-fetch.js";
import type { Transport } from "./net/transport.js";
import { extractAskingPrice, matchSignals, PARKING_SIGNATURES, type Signature } from "./parking.js";

export const USER_AGENT = "Mozilla/5.0 (compatible; Titlesearch/0.1)";
export const LOW_CONTENT_CHARS = 200;

export interface DnsClient extends Resolver {
  query(name: string, type: DnsRecordType, signal?: AbortSignal): Promise<DnsAnswer>;
}

export interface ProbeOptions {
  dns: DnsClient;
  transport?: Transport;
  signatures?: readonly Signature[];
  signal: AbortSignal;
}

export interface ProbeResult {
  evidence: PresenceEvidence;
  /** Deterministic occupancy, or undefined when DNS couldn't be read at all. */
  occupancy: Occupancy | undefined;
}

type ProbeError = PresenceEvidence["probeErrors"][number];

export async function probePresence(domain: string, options: ProbeOptions): Promise<ProbeResult> {
  const { dns, signal } = options;
  const signatures = options.signatures ?? PARKING_SIGNATURES;
  const probeErrors: ProbeError[] = [];

  const lookups = await Promise.allSettled(
    (["A", "AAAA", "NS", "MX"] as const).map((t) => dns.query(domain, t, signal)),
  );
  signal.throwIfAborted();
  const [a, aaaa, ns, mx] = lookups.map((r) => (r.status === "fulfilled" ? r.value : undefined));
  const failed = lookups.filter((r) => r.status === "rejected");
  if (failed.length > 0) {
    const reason = failed[0]?.status === "rejected" ? failed[0].reason : undefined;
    probeErrors.push({
      stage: "dns",
      code: reason instanceof DnsError ? "dns_failed" : "dns_error",
      message: `${failed.length} of 4 DNS lookups failed.`,
    });
  }
  const nameservers = ns?.records ?? [];
  const summary = {
    hasA: (a?.records.length ?? 0) > 0,
    hasAAAA: (aaaa?.records.length ?? 0) > 0,
    hasNS: nameservers.length > 0,
    hasMX: (mx?.records.length ?? 0) > 0,
    nameservers,
  };

  const base = {
    domain,
    dns: summary,
    parkingSignals: [] as string[],
    clientRedirects: [] as string[],
    probeErrors,
  };

  // Without address records there's no site. If the address lookups
  // themselves failed, that's unknown, not "no site".
  if (!summary.hasA && !summary.hasAAAA) {
    const signals = matchSignals(
      { domain, nameservers, urls: [], clientRedirects: [], texts: [] },
      signatures,
    );
    const evidence: PresenceEvidence = {
      ...base,
      parkingSignals: signals.map((s) => s.id),
      contentConfidence: "low",
    };
    return { evidence, occupancy: a && aaaa ? "no_site" : undefined };
  }

  // HTTPS first, then HTTP if HTTPS couldn't connect.
  let fetched: SafeFetchResult | undefined;
  const seenUrls: string[] = [];
  const noteChain = (chain: readonly { url: string; location?: string }[]) => {
    for (const h of chain) {
      seenUrls.push(h.url);
      if (h.location) {
        try {
          seenUrls.push(new URL(h.location, h.url).href);
        } catch {
          // Invalid Location; the hop is still recorded.
        }
      }
    }
  };
  for (const scheme of ["https", "http"] as const) {
    try {
      fetched = await safeFetch(`${scheme}://${domain}/`, {
        resolver: dns,
        signal,
        userAgent: USER_AGENT,
        ...(options.transport ? { transport: options.transport } : {}),
      });
      noteChain(fetched.chain);
      break;
    } catch (err) {
      signal.throwIfAborted();
      if (!(err instanceof SafeFetchError)) throw err;
      noteChain(err.chain);
      probeErrors.push({ stage: scheme, code: err.code, message: err.message });
      // Only a failure to connect is worth retrying over HTTP. A refused
      // address, port, or scheme would be refused again.
      if (err.code !== "network" && err.code !== "timeout") break;
    }
  }

  let page: ReturnType<typeof extractPage> | undefined;
  if (fetched && /html|xml/i.test(fetched.contentType ?? "text/html")) {
    const html = decodeBody(readSafeFetchBody(fetched), fetched.contentType);
    page = extractPage(html, fetched.url);
  }

  const clientRedirects = page?.clientRedirects ?? [];
  const texts = page
    ? [
        page.fields.title,
        page.fields.description,
        page.fields.ogTitle,
        page.fields.ogDescription,
        page.visibleText,
      ].filter((t): t is string => !!t)
    : [];
  const signals = matchSignals(
    { domain, nameservers, urls: seenUrls, clientRedirects, texts },
    signatures,
  );
  const forSale = signals.some((s) => s.verdict === "for_sale");
  const parked = signals.some((s) => s.verdict === "parked");

  const evidence: PresenceEvidence = {
    ...base,
    parkingSignals: signals.map((s) => s.id),
    clientRedirects,
    contentConfidence: (page?.visibleText.length ?? 0) < LOW_CONTENT_CHARS ? "low" : "normal",
  };
  if (fetched) {
    evidence.http = {
      chain: fetched.chain.map((h) => ({ url: h.url, status: h.status })),
      finalUrl: fetched.url,
      tlsValid: fetched.url.startsWith("https:"),
      pinned: fetched.pinned,
    };
  }
  if (page) {
    evidence.page = page.fields;
    const excerpt = toUntrustedSiteText(page.visibleText);
    if (excerpt) evidence.untrustedSiteText = excerpt;
  }
  if (forSale) {
    const price = extractAskingPrice(texts.join(" "));
    if (price) evidence.askingPrice = price;
  }

  let occupancy: Occupancy;
  if (forSale) occupancy = "for_sale";
  else if (parked) occupancy = "parked";
  else if (fetched) occupancy = "unassessed";
  // Addresses exist but nothing answered over HTTP or HTTPS.
  else occupancy = "no_site";
  return { evidence, occupancy };
}
