// "Copy for Claude" and "Export Markdown": the results as Markdown, built
// entirely in the browser.

import type { DomainResult } from "@titlesearch/core";
import { detailOf, LABEL, priceOf, statusOf } from "./labels";
import type { NameRow } from "./store";

function line(r: DomainResult): string {
  const s = statusOf(r);
  const price = priceOf(r);
  const reasons = r.assessment ? ` Reasons: ${r.assessment.reasons.join(" ")}` : "";
  return `- ${r.domain}: ${LABEL[s]}${price ? `, ${price.text} (${price.source})` : ""}. ${detailOf(r)}.${reasons}`;
}

export function toMarkdown(rows: NameRow[], tlds: string[], market: string): string {
  const out = ["# Titlesearch results", ""];
  if (market) out.push(`Market: ${market}`, "");
  for (const row of rows) {
    out.push(`## ${row.name}`);
    for (const t of tlds) {
      const r = row.results.find((x) => x.domain === `${row.name}.${t}`);
      out.push(r ? line(r) : `- ${row.name}.${t}: not checked`);
    }
    out.push("");
  }
  out.push("Market overlap compares public website content. It isn't a trademark search.");
  return out.join("\n");
}

export async function copyForClaude(
  rows: NameRow[],
  tlds: string[],
  market: string,
): Promise<void> {
  await navigator.clipboard.writeText(toMarkdown(rows, tlds, market));
}

export function exportMarkdown(rows: NameRow[], tlds: string[], market: string): void {
  const url = URL.createObjectURL(
    new Blob([toMarkdown(rows, tlds, market)], { type: "text/markdown" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "titlesearch-results.md";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
