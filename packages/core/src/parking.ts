// Parking and for-sale detection from versioned signature data
// (signatures/parking.json). Every signature lists the fixtures in
// fixtures/sites/ that it's tested against.

import * as z from "zod";
import data from "../signatures/parking.json" with { type: "json" };

const Verdict = z.enum(["parked", "for_sale"]);
const Base = {
  id: z.string().regex(/^[a-z0-9-]+$/),
  verdict: Verdict,
  description: z.string(),
  fixtures: z.array(z.string()).min(1),
};

export const SignatureSchema = z.discriminatedUnion("kind", [
  z.object({ ...Base, kind: z.literal("nameserver"), suffix: z.string().min(3) }),
  z.object({ ...Base, kind: z.literal("redirect_host"), host: z.string().min(3) }),
  z.object({ ...Base, kind: z.literal("client_redirect"), path: z.string().min(1) }),
  z.object({ ...Base, kind: z.literal("text"), pattern: z.string().min(1) }),
]);
export type Signature = z.infer<typeof SignatureSchema>;

export const SignatureFileSchema = z.object({
  version: z.literal(1),
  updated: z.string(),
  signatures: z.array(SignatureSchema),
});

export const PARKING_SIGNATURES: readonly Signature[] = SignatureFileSchema.parse(data).signatures;

export interface SignalInput {
  domain: string;
  nameservers: readonly string[];
  /** Every URL in the HTTP chain, plus redirect Location targets. */
  urls: readonly string[];
  clientRedirects: readonly string[];
  /** Title, descriptions, and visible text. */
  texts: readonly string[];
}

export interface Signal {
  id: string;
  verdict: "parked" | "for_sale";
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function hostMatches(host: string, suffix: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  const s = suffix.toLowerCase();
  return h === s || h.endsWith(`.${s}`);
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** The domain itself and its www host don't count as a redirect destination. */
function isOwnHost(host: string, domain: string): boolean {
  return host === domain || host === `www.${domain}`;
}

export function matchSignals(
  input: SignalInput,
  signatures: readonly Signature[] = PARKING_SIGNATURES,
): Signal[] {
  const out: Signal[] = [];
  const text = input.texts.join(" \n ").replace(/\s+/g, " ");
  for (const sig of signatures) {
    let hit = false;
    switch (sig.kind) {
      case "nameserver":
        hit = input.nameservers.some((ns) => hostMatches(ns, sig.suffix));
        break;
      case "redirect_host":
        hit = [...input.urls, ...input.clientRedirects].some((u) => {
          const h = hostOf(u);
          return h !== undefined && !isOwnHost(h, input.domain) && hostMatches(h, sig.host);
        });
        break;
      case "client_redirect": {
        const re = new RegExp(sig.path);
        hit = input.clientRedirects.some((u) => {
          try {
            const url = new URL(u);
            return isOwnHost(url.hostname, input.domain) && re.test(url.pathname);
          } catch {
            return false;
          }
        });
        break;
      }
      case "text": {
        const re = new RegExp(sig.pattern.replaceAll("{domain}", escapeRegExp(input.domain)), "i");
        hit = re.test(text);
        break;
      }
    }
    if (hit) out.push({ id: sig.id, verdict: sig.verdict });
  }
  return out;
}

/** Parses "3,795", "1.200", "12,500.50", or "450". Returns undefined for anything ambiguous, like "1,5". */
function parseAmount(token: string): number | undefined {
  const grouped = /^\d{1,3}([.,])\d{3}(?:\1\d{3})*(?:([.,])(\d{2}))?$/.exec(token);
  if (grouped) {
    const [, group, decimal, cents] = grouped;
    if (decimal !== undefined && decimal === group) return undefined;
    const whole = token.slice(0, decimal ? -3 : undefined).replaceAll(group as string, "");
    return Number(whole) + (cents ? Number(cents) / 100 : 0);
  }
  const plain = /^(\d{1,9})(?:[.,](\d{2}))?$/.exec(token);
  if (plain) return Number(plain[1]) + (plain[2] ? Number(plain[2]) / 100 : 0);
  return undefined;
}

/**
 * An asking price, only when the page states one next to buying language:
 * "Buy now: $3,795", "Buy for $3,995". The currency is kept exactly as the
 * page shows it ("$" isn't assumed to be USD). Ambiguous numbers give no price.
 */
export function extractAskingPrice(
  text: string,
): { amount: number; currency: string; source: "page" } | undefined {
  const m =
    /\b(?:buy(?: it)?(?: now)?(?: for)?|asking price|price|for sale)\b[^$€£\d]{0,20}(US\$|USD|EUR|GBP|[$€£])\s?(\d[\d.,]*\d|\d)(?![\d.,]*\d)/i.exec(
      text,
    );
  if (!m) return undefined;
  const amount = parseAmount(m[2] as string);
  if (amount === undefined || amount <= 0) return undefined;
  return { amount, currency: (m[1] as string).toUpperCase(), source: "page" };
}
