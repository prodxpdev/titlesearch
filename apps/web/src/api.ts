// The UI's only network code. It calls this origin's /api with relative
// paths, so it can't reach a third-party host (invariants 2 and 8). The
// session cookie authenticates; it's HttpOnly, so scripts never see it.

import type { DomainResult } from "@titlesearch/core";
import type { KeyName, Settings } from "@titlesearch/server";

export class AuthError extends Error {
  override readonly name = "AuthError";
}

export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  if (!path.startsWith("/api/")) throw new Error("The UI only calls its own /api.");
  const res = await fetch(path, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers: init.body === undefined ? {} : { "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (res.status === 401 && path !== "/api/session") throw new AuthError("Sign in again.");
  const data = (await res.json().catch(() => ({}))) as {
    error?: { code: string; message: string };
  } & T;
  if (!res.ok)
    throw new ApiError(
      res.status,
      data.error?.code ?? "error",
      data.error?.message ?? `HTTP ${res.status}`,
    );
  return data;
}

export interface MarketAssessmentResponse {
  market: string;
  mode: "server" | "client" | "off";
  assessedBy?: string;
  results: DomainResult[];
  notice: string;
}

export interface ProviderHealth {
  id: string;
  status: "ok" | "degraded" | "error";
  checkedAt: string;
}

export const api = {
  session: () => request<{ authenticated: boolean; login?: "code" | "oidc" }>("/api/session"),
  signIn: (code: string) =>
    request<{ authenticated: boolean }>("/api/session", { method: "POST", body: { code } }),
  signOut: () => request<{ authenticated: boolean }>("/api/session", { method: "DELETE" }),
  suggest: (description: string, count: number, avoid: string[]) =>
    request<{
      suggestions: { name: string; rationale: string; style: string }[];
      suggestedBy: string;
      notice: string;
    }>("/api/suggest", { method: "POST", body: { description, count, avoid } }),
  check: (names: string[], tlds: string[]) =>
    request<{ results: DomainResult[] }>("/api/check", { method: "POST", body: { names, tlds } }),
  assess: (name: string, market: string, tlds: string[]) =>
    request<MarketAssessmentResponse>("/api/assess", {
      method: "POST",
      body: { name, market, tlds },
    }),
  domain: (domain: string) => request<DomainResult>(`/api/domain/${encodeURIComponent(domain)}`),
  variants: (seed: string, strategies: string[], tlds: string[]) =>
    request<{ candidates: { domain: string; strategy: string }[] }>("/api/variants", {
      method: "POST",
      body: { seed, strategies, tlds },
    }),
  settings: () => request<{ settings: Settings; version: string }>("/api/settings"),
  /** Ollama and LM Studio, if they're running on this computer. */
  localModels: () =>
    request<{ runtimes: { provider: "ollama" | "lmstudio"; baseUrl: string; models: string[] }[] }>(
      "/api/models/local",
    ),
  /** Saves a key to the keychain (desktop app). The value is never sent back. */
  setKey: (name: KeyName, value: string) =>
    request<{ settings: Settings }>(`/api/keys/${name}`, { method: "PUT", body: { value } }),
  removeKey: (name: KeyName) =>
    request<{ settings: Settings }>(`/api/keys/${name}`, { method: "DELETE" }),
  updateSettings: (patch: unknown) =>
    request<{ settings: Settings }>("/api/settings", { method: "PATCH", body: patch }),
  health: () => request<{ providers: ProviderHealth[] }>("/api/providers/health"),
  rotateToken: () => request<{ token: string }>("/api/token/rotate", { method: "POST" }),
};

/** Preview images come only from this origin (invariant 8). */
export function previewUrl(hash: string): string {
  return `/api/preview/${hash}`;
}
