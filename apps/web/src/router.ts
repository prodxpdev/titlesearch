// Hash routes, as in the mockup: #/search, #/results, #/domain/<d>,
// #/shortlist, #/providers, #/connect.

import { useSyncExternalStore } from "react";

export type Route =
  | { name: "search" }
  | { name: "results" }
  | { name: "domain"; domain: string }
  | { name: "shortlist" }
  | { name: "providers" }
  | { name: "connect" };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/");
  switch (parts[0]) {
    case "results":
      return { name: "results" };
    case "domain":
      return { name: "domain", domain: decodeURIComponent(parts[1] ?? "") };
    case "shortlist":
      return { name: "shortlist" };
    case "providers":
      return { name: "providers" };
    case "connect":
      return { name: "connect" };
    default:
      return { name: "search" };
  }
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(
    (l) => {
      window.addEventListener("hashchange", l);
      return () => window.removeEventListener("hashchange", l);
    },
    () => window.location.hash,
  );
  return parseRoute(hash);
}

export function go(hash: string): void {
  window.location.hash = hash;
}
