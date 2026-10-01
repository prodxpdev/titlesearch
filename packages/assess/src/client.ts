// The Anthropic SDK client every Titlesearch model call uses. The SDK's
// fetch is routed through core's fixed-origin fetch, so every request stays
// on api.anthropic.com (invariant 2).

import Anthropic from "@anthropic-ai/sdk";
import { createOriginFetch, type Transport } from "@titlesearch/core";

export const ANTHROPIC_API_ORIGIN = "https://api.anthropic.com";

export interface AnthropicClientOptions {
  apiKey: string;
  transport?: Transport;
  /** For tests: the SDK's retry count. */
  maxRetries?: number;
}

export function createAnthropicClient(options: AnthropicClientOptions): Anthropic {
  const originFetch = createOriginFetch({
    origins: [ANTHROPIC_API_ORIGIN],
    timeoutMs: 120_000,
    ...(options.transport ? { transport: options.transport } : {}),
  });
  return new Anthropic({
    apiKey: options.apiKey,
    baseURL: ANTHROPIC_API_ORIGIN,
    maxRetries: options.maxRetries ?? 2,
    fetch: async (input, init) => {
      const url = typeof input === "string" || input instanceof URL ? input : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      if (method !== "GET" && method !== "POST") throw new Error(`Unsupported method ${method}.`);
      if (init?.body !== undefined && init.body !== null && typeof init.body !== "string") {
        throw new Error("Only string request bodies are supported.");
      }
      return originFetch(url, {
        method,
        ...(init?.headers ? { headers: init.headers } : {}),
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
        ...(init?.signal ? { signal: init.signal } : {}),
      });
    },
  });
}
