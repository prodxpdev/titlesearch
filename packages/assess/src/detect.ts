// Finds model runtimes already running on this machine: Ollama and LM Studio,
// on their default ports. From Datera's tier 2, with its three rules:
// - best effort: a runtime that isn't there is the normal case, not an error;
// - concurrent, with a short timeout, so the Providers page never waits long;
// - only list runtimes that answered just now, never a remembered one.

import { createOriginFetch, type Transport } from "@titlesearch/core";
import { LOCAL_RUNTIME_URLS } from "./models.js";

export interface DetectedRuntime {
  provider: "ollama" | "lmstudio";
  baseUrl: string;
  /** Chat models only: embedding models can't judge or suggest anything. */
  models: string[];
}

const PROBE_TIMEOUT_MS = 800;

function names(body: unknown): string[] | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const ollama = (body as { models?: unknown }).models;
  if (Array.isArray(ollama))
    return ollama.flatMap((m) => (typeof m?.name === "string" ? [m.name as string] : []));
  const openai = (body as { data?: unknown }).data;
  if (Array.isArray(openai))
    return openai.flatMap((m) => (typeof m?.id === "string" ? [m.id as string] : []));
  return undefined;
}

const isEmbedding = (id: string) => /embed|bge-|e5-|minilm/i.test(id);

async function probe(
  provider: "ollama" | "lmstudio",
  transport: Transport | undefined,
): Promise<DetectedRuntime | null> {
  const baseUrl = LOCAL_RUNTIME_URLS[provider];
  const f = createOriginFetch({
    origins: [],
    httpOrigins: [baseUrl],
    timeoutMs: PROBE_TIMEOUT_MS,
    maxBytes: 1024 * 1024,
    ...(transport ? { transport } : {}),
  });
  // Ollama's own listing first; the OpenAI-compatible one works for both.
  const paths = provider === "ollama" ? ["/api/tags", "/v1/models"] : ["/v1/models"];
  for (const path of paths) {
    try {
      const res = await f(`${baseUrl}${path}`);
      if (!res.ok) continue;
      const found = names(await res.json());
      if (!found) continue;
      return { provider, baseUrl, models: found.filter((m) => !isEmbedding(m)).sort() };
    } catch {
      // Not running, or not answering: the expected case.
    }
  }
  return null;
}

export async function detectLocalRuntimes(transport?: Transport): Promise<DetectedRuntime[]> {
  const found = await Promise.all([probe("ollama", transport), probe("lmstudio", transport)]);
  return found.filter((r): r is DetectedRuntime => r !== null);
}
