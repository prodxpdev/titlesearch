// Which model judges market overlap and suggests names, when the server does
// it. Modeled on Datera's provider tiers: the user's own key for Anthropic,
// a local runtime they already run (Ollama, LM Studio), or any server that
// speaks the OpenAI chat-completions API (OpenRouter, Groq, Together, vLLM,
// llama.cpp's server, ...). Everything above the model is provider-independent:
// the prompts, the untrusted-data framing, and the strict validation are the
// same whichever model answers. See docs/decisions/0025-open-models.md.

import * as z from "zod";

export const MODEL_PROVIDERS = ["anthropic", "ollama", "lmstudio", "openai-compatible"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

/** Where the local runtimes listen by default. */
export const LOCAL_RUNTIME_URLS: Record<"ollama" | "lmstudio", string> = {
  ollama: "http://127.0.0.1:11434",
  lmstudio: "http://127.0.0.1:1234",
};

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

/** A model choice, as config and settings store it. Never holds a key. */
export const ModelChoice = z
  .object({
    provider: z.enum(MODEL_PROVIDERS),
    /** The provider's own identifier, verbatim: "claude-opus-5-5", "llama3.1:8b". */
    id: z.string().trim().min(1).max(200),
    /** For "openai-compatible" (required) and to move a local runtime off its default port. */
    baseUrl: z.string().url().optional(),
  })
  .strict()
  .refine((m) => m.provider !== "openai-compatible" || !!m.baseUrl, {
    message: "An OpenAI-compatible server needs its base URL.",
    path: ["baseUrl"],
  })
  .refine((m) => !m.baseUrl || /^https?:$/.test(new URL(m.baseUrl).protocol), {
    message: "The base URL must be http:// or https://.",
    path: ["baseUrl"],
  });
export type ModelChoice = z.infer<typeof ModelChoice>;

/** Everything needed to name a model exactly, in an assessment or a log. Never holds a key. */
export interface ModelDescriptor {
  provider: ModelProvider;
  id: string;
  /** "local": on this machine, so site text and descriptions don't leave it. */
  locality: "local" | "remote";
  /** Where it's reached, for anything but Anthropic. */
  endpoint?: string;
}

export function providerLabel(provider: string): string {
  switch (provider) {
    case "anthropic":
      return "Anthropic";
    case "ollama":
      return "Ollama";
    case "lmstudio":
      return "LM Studio";
    case "openai-compatible":
      return "OpenAI-compatible";
    default:
      return provider;
  }
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** The descriptor for a choice: where it runs, and whether that's this machine. */
export function describeChoice(choice: ModelChoice): ModelDescriptor {
  if (choice.provider === "anthropic")
    return { provider: "anthropic", id: choice.id, locality: "remote" };
  const endpoint =
    choice.baseUrl ??
    (choice.provider === "openai-compatible" ? "" : LOCAL_RUNTIME_URLS[choice.provider]);
  return {
    provider: choice.provider,
    id: choice.id,
    locality: isLoopbackUrl(endpoint) ? "local" : "remote",
    endpoint,
  };
}

/** How assessments name their judge: "ollama:llama3.1:8b". Stable, so caches key on it. */
export function modelKey(d: Pick<ModelDescriptor, "provider" | "id">): string {
  return `${d.provider}:${d.id}`;
}

/** One way to say which model answered, everywhere: "Ollama · llama3.1:8b (this computer)". */
export function describeModel(d: ModelDescriptor): string {
  const where =
    d.locality === "local"
      ? "this computer"
      : d.endpoint
        ? new URL(d.endpoint).host
        : "Anthropic API";
  return `${providerLabel(d.provider)} · ${d.id} (${where})`;
}
