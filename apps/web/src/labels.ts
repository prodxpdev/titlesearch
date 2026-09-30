// Status labels and styles, exactly as CLAUDE.md (UI) lists them, mapped from
// the model. "Unconfirmed" is reserved for sources that disagree.

import type { DomainResult, SourceResult } from "@titlesearch/core";

export type StatusKey =
  | "available"
  | "premium"
  | "competitor"
  | "overlap"
  | "unrelated"
  | "taken"
  | "parked"
  | "forsale"
  | "nosite"
  | "notregistered"
  | "unknown"
  | "error";

export const LABEL: Record<StatusKey, string> = {
  available: "Available",
  premium: "Premium",
  competitor: "Competitor",
  overlap: "Possible overlap",
  unrelated: "Unrelated site",
  taken: "Taken",
  parked: "Parked",
  forsale: "For sale",
  nosite: "No site",
  notregistered: "Not registered",
  unknown: "Unconfirmed",
  error: "Couldn't check",
};

export function statusOf(r: DomainResult): StatusKey {
  switch (r.availability) {
    case "available":
      return "available";
    case "premium":
      return "premium";
    case "unregistered_at_registry":
      return "notregistered";
    case "error":
      return "error";
    case "unconfirmed":
      return r.occupancy === "for_sale"
        ? "forsale"
        : r.occupancy === "parked"
          ? "parked"
          : "unknown";
    case "registered":
      switch (r.occupancy) {
        case "competitor":
          return "competitor";
        case "possible_overlap":
          return "overlap";
        case "unrelated":
          return "unrelated";
        case "parked":
          return "parked";
        case "for_sale":
          return "forsale";
        case "no_site":
          return "nosite";
        default:
          return "taken";
      }
  }
}

/** The CSS custom-property family for a status, from the mockup's palette. */
export function statusStyle(s: StatusKey): { background: string; color: string } {
  const k =
    s === "available"
      ? "vacant"
      : s === "premium"
        ? "premium"
        : s === "competitor"
          ? "conflict"
          : s === "overlap"
            ? "overlap"
            : s === "unknown"
              ? "unknown"
              : "neutral";
  return { background: `var(--${k}-bg)`, color: `var(--${k})` };
}

const SOURCE_NAMES: Record<string, string> = {
  rdap: "RDAP",
  whois: "WHOIS",
  godaddy: "GoDaddy",
  porkbun: "Porkbun",
  namecom: "Name.com",
};
export const sourceName = (id: string) => SOURCE_NAMES[id] ?? id;

export function priceOf(r: DomainResult): { text: string; source: string } | undefined {
  const s = r.sources.find((x: SourceResult) => x.price);
  if (!s?.price) return undefined;
  const amount = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: s.price.currency,
  }).format(s.price.amount);
  return { text: amount, source: sourceName(s.source) };
}

export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currency}${amount.toLocaleString("en-US")}`;
  }
}

/** The lot's one line of detail. */
export function detailOf(r: DomainResult): string {
  const s = statusOf(r);
  const p = r.presence;
  switch (s) {
    case "available":
      return priceOf(r) ? "First year" : "No price from this source";
    case "premium":
      return priceOf(r) ? "Registry premium price" : "No price from this source";
    case "notregistered":
      return "No registrar confirmed. Price unknown.";
    case "unknown":
      return "Sources disagree";
    case "error":
      return "No source answered";
    case "nosite":
      return "Registered, nothing served";
    case "parked":
      return p?.parkingSignals.some((x) => x.startsWith("ns-"))
        ? "Parking-service nameservers"
        : "Parked page";
    case "forsale":
      return p?.askingPrice
        ? `Sale page, asking ${formatMoney(p.askingPrice.amount, p.askingPrice.currency)}`
        : "Sale page";
    default:
      return p?.page?.title ?? p?.page?.ogTitle ?? (p ? "Site found" : "Registered");
  }
}

export function relativeTime(iso: string, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}
