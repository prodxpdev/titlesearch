// Runs a search: expands variants, then checks each name across the chosen
// extensions, two names at a time so the grid fills in as answers arrive.

import type { DomainResult } from "@titlesearch/core";
import { AuthError, api } from "./api";
import { getState, type NameRow, setState } from "./store";

const MAX_NAMES = 20;
/** Names suggested from the description, at most. */
const SUGGESTIONS = 10;

/** "Acme.com" → "acme". Names are single labels; extensions come from the chips. */
export function cleanName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "").replace(/\..*$/, "");
}

export async function runSearch(): Promise<void> {
  const s = getState();
  const tlds = Object.entries(s.tlds)
    .filter(([, on]) => on)
    .map(([t]) => t);
  const seeds = [...new Set(s.names.split("\n").map(cleanName).filter(Boolean))].slice(
    0,
    MAX_NAMES,
  );
  const market = s.market.trim();
  const suggest = s.variants.semantic && market.length > 0;
  if ((seeds.length === 0 && !suggest) || tlds.length === 0) return;

  const strategies = (["prefix", "suffix", "plural"] as const).filter((k) => s.variants[k]);
  const rows: NameRow[] = seeds.map((name) => ({
    name,
    origin: "seed",
    status: "pending" as const,
    results: [],
  }));
  const seen = new Set<string>(seeds);
  setState({ suggestError: undefined });

  // Names from the description come right after the user's own, so they
  // aren't crowded out by variants.
  if (suggest) {
    const count = Math.min(SUGGESTIONS, MAX_NAMES - rows.length);
    if (count > 0) {
      try {
        const { suggestions } = await api.suggest(market, count, seeds);
        for (const sg of suggestions) {
          if (seen.has(sg.name)) continue;
          seen.add(sg.name);
          rows.push({
            name: sg.name,
            origin: "suggested",
            rationale: sg.rationale,
            status: "pending",
            results: [],
          });
        }
      } catch (err) {
        if (err instanceof AuthError) return setState({ authenticated: false });
        setState({
          suggestError: err instanceof Error ? err.message : "Couldn't get suggestions.",
        });
      }
    }
  }
  if (rows.length === 0) return;

  for (const seed of seeds) {
    if (strategies.length === 0) continue;
    try {
      const { candidates } = await api.variants(seed, [...strategies], [tlds[0] as string]);
      for (const c of candidates) {
        const name = c.domain.slice(0, c.domain.indexOf("."));
        if (c.strategy === "seed" || seen.has(name)) continue;
        seen.add(name);
        rows.push({ name, origin: c.strategy, status: "pending", results: [] });
      }
    } catch (err) {
      if (err instanceof AuthError) return setState({ authenticated: false });
    }
  }
  const limited = rows.slice(0, MAX_NAMES);
  setState({ rows: limited, searchedTlds: tlds, searchedMarket: market, assessedBy: undefined });

  let next = 0;
  const worker = async () => {
    while (next < limited.length) {
      const i = next++;
      const name = limited[i]?.name as string;
      try {
        let results: DomainResult[];
        if (market) {
          const r = await api.assess(name, market, tlds);
          results = r.results;
          if (r.assessedBy) setState({ assessedBy: r.assessedBy });
        } else {
          results = (await api.check([name], tlds)).results;
        }
        setRow(name, { status: "done", results });
      } catch (err) {
        if (err instanceof AuthError) return setState({ authenticated: false });
        setRow(name, {
          status: "error",
          error: err instanceof Error ? err.message : "The check failed.",
        });
      }
    }
  };
  await Promise.all([worker(), worker()]);
}

function setRow(name: string, patch: Partial<NameRow>): void {
  setState((s) => ({ rows: s.rows.map((r) => (r.name === name ? { ...r, ...patch } : r)) }));
}

/** Plain-language verdict for a row, as the mockup's "Viable." / "Crowded." */
export function rowVerdict(row: NameRow, tlds: string[]): { verdict: string; note: string } {
  if (row.status === "pending") return { verdict: "Checking", note: "" };
  if (row.status === "error") return { verdict: "Couldn't check", note: row.error ?? "" };
  const by = (t: string) => row.results.find((r) => r.domain === `${row.name}.${t}`);
  const open = tlds.filter((t) => ["available", "premium"].includes(by(t)?.availability ?? ""));
  // No registry record, but no registrar confirmed it either (invariant 4): not "open", not "taken".
  const unrecorded = tlds.filter((t) => by(t)?.availability === "unregistered_at_registry");
  const competitors = tlds.filter((t) => by(t)?.occupancy === "competitor");
  const overlaps = tlds.filter((t) => by(t)?.occupancy === "possible_overlap");
  const com = by("com");
  const openText =
    open.length === 1
      ? "One extension is open."
      : `${open.length === 0 ? "No" : open.length} extensions are open.`;
  if (competitors.length) {
    return {
      verdict: "Crowded",
      note: `A competitor holds the .${competitors.join(", .")}. ${openText}`,
    };
  }
  let comText = "";
  if (com?.occupancy === "for_sale") comText = "The .com is for sale.";
  else if (com?.occupancy === "parked") comText = "The .com is parked.";
  else if (com?.occupancy === "unrelated") comText = "The .com is an unrelated site.";
  else if (com?.availability === "available") comText = "The .com is open.";
  else if (com?.availability === "unconfirmed") comText = "The .com's sources disagree.";
  else if (com?.availability === "unregistered_at_registry")
    comText = "The .com has no registry record.";
  const overlapText = overlaps.length ? `Possible overlap on .${overlaps.join(", .")}.` : "";
  if (!open.length && unrecorded.length) {
    const n =
      unrecorded.length === 1 ? "One extension has" : `${unrecorded.length} extensions have`;
    return {
      verdict: "Not registered",
      note: [comText, overlapText, `${n} no registry record, but no registrar confirmed it's open.`]
        .filter(Boolean)
        .join(" "),
    };
  }
  return {
    verdict: open.length ? "Viable" : "Taken",
    note: [comText, overlapText, openText].filter(Boolean).join(" "),
  };
}
