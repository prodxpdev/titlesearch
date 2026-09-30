// Human-readable output for `titlesearch check`. Status labels follow the
// mockup's vocabulary where it has one; every detail names its source.

import { type MarketAssessment, NOT_A_TRADEMARK_SEARCH } from "@titlesearch/assess";
import type { DomainResult, Occupancy, SourceResult } from "@titlesearch/core";

const SOURCE_NAMES: Record<string, string> = { rdap: "RDAP", whois: "WHOIS", godaddy: "GoDaddy" };
const sourceName = (id: string) => SOURCE_NAMES[id] ?? id;

// Status labels from CLAUDE.md (UI). "Taken" covers a registered domain
// whose site hasn't been judged, or wasn't looked at (plain `check`).
export const STATUS_LABELS: Record<DomainResult["availability"], string> = {
  available: "Available",
  premium: "Premium",
  registered: "Taken",
  unregistered_at_registry: "Not registered",
  unconfirmed: "Unconfirmed",
  error: "Couldn't check",
};

function describeSource(s: SourceResult): string {
  const name = sourceName(s.source);
  if (s.error) return `${name}: ${s.error.code.replaceAll("_", " ")}`;
  const price = s.price ? ` ${s.price.amount.toFixed(2)} ${s.price.currency}` : "";
  switch (s.availability) {
    case "unregistered_at_registry":
      return `${name}: not found`;
    case "registered":
      return `${name}: registered${s.raw?.registrar ? ` (${s.raw.registrar})` : ""}`;
    default:
      return `${name}: ${s.availability}${price}`;
  }
}

export function detail(r: DomainResult): string {
  const parts = r.sources.map(describeSource);
  if (r.availability === "unregistered_at_registry")
    parts.push("No registrar confirmed. Price unknown.");
  if (r.availabilityReason === "registry_taken_registrar_free")
    parts.push("possibly a resale listing");
  return parts.join("; ");
}

export function formatTable(results: readonly DomainResult[]): string {
  const rows = results.map((r) => [r.domain, STATUS_LABELS[r.availability], detail(r)]);
  const header = ["Domain", "Status", "Detail"];
  const widths = [0, 1].map((i) =>
    Math.max(header[i]?.length ?? 0, ...rows.map((row) => row[i]?.length ?? 0)),
  );
  const line = (cols: string[]) =>
    cols
      .map((c, i) => (i < 2 ? c.padEnd(widths[i] ?? 0) : c))
      .join("  ")
      .trimEnd();
  return [
    line(header),
    ...rows.map(line),
    "",
    "Availability only. This isn't a trademark search.",
  ].join("\n");
}

/** Labels for taken domains once presence is known, from the brief's vocabulary. */
export const OCCUPANCY_LABELS: Record<Occupancy, string> = {
  competitor: "Competitor",
  possible_overlap: "Possible overlap",
  unrelated: "Unrelated site",
  parked: "Parked",
  for_sale: "For sale",
  no_site: "No site",
  unassessed: "Taken",
};

function statusOf(r: DomainResult): string {
  return r.occupancy ? OCCUPANCY_LABELS[r.occupancy] : STATUS_LABELS[r.availability];
}

function assessmentDetail(r: DomainResult): string {
  const parts = [detail(r)];
  const p = r.presence;
  if (p?.askingPrice)
    parts.push(
      `Site: asking ${p.askingPrice.currency}${p.askingPrice.amount.toLocaleString("en-US")}`,
    );
  if (p?.page?.title) parts.push(`Site: "${p.page.title}"`);
  return parts.filter(Boolean).join("; ");
}

export function formatAssessment(a: MarketAssessment): string {
  const rows = a.results.map((r) => [r.domain, statusOf(r), assessmentDetail(r)]);
  const header = ["Domain", "Status", "Detail"];
  const widths = [0, 1].map((i) =>
    Math.max(header[i]?.length ?? 0, ...rows.map((row) => row[i]?.length ?? 0)),
  );
  const line = (cols: string[]) =>
    cols
      .map((c, i) => (i < 2 ? c.padEnd(widths[i] ?? 0) : c))
      .join("  ")
      .trimEnd();
  const out = [`Market: ${a.market}`, "", line(header)];
  a.results.forEach((r, i) => {
    out.push(line(rows[i] as string[]));
    if (r.assessment) {
      const indent = " ".repeat((widths[0] ?? 0) + 2);
      out.push(`${indent}Assessment (${r.assessment.assessedBy}):`);
      for (const reason of r.assessment.reasons) out.push(`${indent}- ${reason}`);
    }
  });
  out.push("", NOT_A_TRADEMARK_SEARCH);
  return out.join("\n");
}
