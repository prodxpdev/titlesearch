// Reconciliation: turning every source's answer into one availability
// (invariant 4). The rules are the table in CLAUDE.md. Nothing here prefers
// one source over another: when sources disagree the answer is
// "unconfirmed", and the caller reports every source.

import type { Availability, ReconcileReason, SourceResult } from "./model.js";

export type { ReconcileReason };

/** Source ids that speak for the registry rather than a registrar. */
export const REGISTRY_SOURCES: ReadonlySet<string> = new Set(["rdap", "whois"]);

export interface Reconciliation {
  availability: Availability;
  reason: ReconcileReason;
}

type RegistryView = "not_found" | "registered";
type RegistrarView = "available" | "premium" | "registered";

export function reconcile(sources: readonly SourceResult[]): Reconciliation {
  const answered = sources.filter((s) => s.availability !== "error");
  const registry = answered.filter((s) => REGISTRY_SOURCES.has(s.source));
  const registrars = answered.filter((s) => !REGISTRY_SOURCES.has(s.source));

  const registryViews = new Set<RegistryView>();
  for (const s of registry) {
    if (s.availability === "unregistered_at_registry") registryViews.add("not_found");
    else if (s.availability === "registered") registryViews.add("registered");
    else return { availability: "unconfirmed", reason: "invalid_source_state" };
  }

  const registrarViews = new Set<RegistrarView>();
  for (const s of registrars) {
    if (
      s.availability === "available" ||
      s.availability === "premium" ||
      s.availability === "registered"
    ) {
      registrarViews.add(s.availability);
    } else {
      return { availability: "unconfirmed", reason: "invalid_source_state" };
    }
  }

  if (registryViews.size > 1) return { availability: "unconfirmed", reason: "registries_disagree" };
  if (registrarViews.size > 1)
    return { availability: "unconfirmed", reason: "registrars_disagree" };

  const reg: RegistryView | undefined = [...registryViews][0];
  const rar: RegistrarView | undefined = [...registrarViews][0];

  if (reg === undefined) {
    return rar === undefined
      ? { availability: "error", reason: "no_answer" }
      : { availability: rar, reason: "registrar_only" };
  }

  if (reg === "not_found") {
    switch (rar) {
      case undefined:
        return { availability: "unregistered_at_registry", reason: "registry_only_not_found" };
      case "available":
      case "premium":
        return { availability: rar, reason: "agreed" };
      case "registered":
        return { availability: "unconfirmed", reason: "registry_free_registrar_taken" };
    }
  }

  switch (rar) {
    case undefined:
      return { availability: "registered", reason: "registry_only_registered" };
    case "registered":
      return { availability: "registered", reason: "agreed" };
    case "available":
    case "premium":
      return { availability: "unconfirmed", reason: "registry_taken_registrar_free" };
  }
}
