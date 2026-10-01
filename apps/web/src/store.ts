// App state: the current search, its results, the shortlist, and viewer
// preferences. Results live in sessionStorage; the shortlist and preferences
// in localStorage. Both are per-viewer conveniences, wrapped so a blocked or
// cleared storage never breaks the app.

import type { DomainResult } from "@titlesearch/core";
import { useSyncExternalStore } from "react";

export interface NameRow {
  name: string;
  /** "seed" for a name the user typed; otherwise the variant strategy. */
  origin: string;
  status: "pending" | "done" | "error";
  error?: string;
  results: DomainResult[];
}

export interface State {
  names: string;
  market: string;
  tlds: Record<string, boolean>;
  variants: { prefix: boolean; suffix: boolean; plural: boolean };
  searchedTlds: string[];
  searchedMarket: string;
  rows: NameRow[];
  assessedBy?: string | undefined;
  shortlist: Record<string, boolean>;
  previewsOn: boolean;
  blurPreviews: boolean;
  toast: string;
  authenticated: boolean | undefined;
  /** How this server signs in: a terminal code (local) or the identity provider (deployed). */
  login: "code" | "oidc";
}

export const TLD_CHOICES = ["com", "io", "ai", "app", "dev", "co", "xyz", "net", "so", "tech"];
const DEFAULT_TLDS = new Set(["com", "io", "ai", "app", "dev", "co"]);

function load<T>(storage: () => Storage, key: string, fallback: T): T {
  try {
    const raw = storage().getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
function save(storage: () => Storage, key: string, value: unknown): void {
  try {
    storage().setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked or full: keep going in memory.
  }
}
const local = () => window.localStorage;
const session = () => window.sessionStorage;

let state: State = {
  names: "",
  market: "",
  tlds: Object.fromEntries(TLD_CHOICES.map((t) => [t, DEFAULT_TLDS.has(t)])),
  variants: { prefix: false, suffix: false, plural: false },
  searchedTlds: [],
  searchedMarket: "",
  rows: [],
  shortlist: {},
  previewsOn: true,
  blurPreviews: false,
  toast: "",
  authenticated: undefined,
  login: "code",
  ...load(session, "ts.search", {}),
  ...load(local, "ts.prefs", {}),
};

const listeners = new Set<() => void>();

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  const { names, market, tlds, variants, searchedTlds, searchedMarket, rows, assessedBy } = state;
  save(session, "ts.search", {
    names,
    market,
    tlds,
    variants,
    searchedTlds,
    searchedMarket,
    rows,
    assessedBy,
  });
  save(local, "ts.prefs", {
    shortlist: state.shortlist,
    previewsOn: state.previewsOn,
    blurPreviews: state.blurPreviews,
  });
  for (const l of listeners) l();
}

export function getState(): State {
  return state;
}

export function useStore<T>(select: (s: State) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => select(state),
  );
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(message: string): void {
  setState({ toast: message });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setState({ toast: "" }), 1800);
}

export function findResult(domain: string): DomainResult | undefined {
  for (const row of state.rows) {
    const r = row.results.find((x) => x.domain === domain);
    if (r) return r;
  }
  return undefined;
}

export function upsertResult(result: DomainResult): void {
  setState((s) => ({
    rows: s.rows.map((row) => ({
      ...row,
      results: row.results.map((r) => (r.domain === result.domain ? result : r)),
    })),
  }));
}
