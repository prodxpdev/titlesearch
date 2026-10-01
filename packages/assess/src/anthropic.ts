// The "anthropic" classifier: the Anthropic Messages API, with the user's
// key, through the official SDK. The SDK's fetch is routed through core's
// fixed-origin fetch, so every request stays on api.anthropic.com
// (invariant 2). Anything short of a valid, complete answer leaves sites
// unassessed. See docs/decisions/0013-market-assessment.md.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  type Assessment,
  type Logger,
  type PresenceEvidence,
  silentLogger,
  type Transport,
} from "@titlesearch/core";
import * as z from "zod";
import type { ConflictClassifier } from "./classifier.js";
import { ANTHROPIC_API_ORIGIN, createAnthropicClient } from "./client.js";
import { buildUserMessage, SYSTEM_PROMPT } from "./prompt.js";

export { ANTHROPIC_API_ORIGIN };
export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";
/** Sites per request. assess_market_conflicts checks at most 20 extensions. */
export const SITES_PER_REQUEST = 10;

const Level = z.enum(["competitor", "possible_overlap", "none"]);

/** What the model is asked to return. Kept loose for structured output; checked strictly below. */
export const ModelOutput = z.object({
  assessments: z.array(
    z.object({
      domain: z.string(),
      level: Level,
      reasons: z.array(z.string()),
    }),
  ),
});

const StrictItem = z.object({
  domain: z.string(),
  level: Level,
  reasons: z.array(z.string().trim().min(1).max(300)).min(2).max(4),
});

export interface AnthropicClassifierOptions {
  apiKey: string;
  /** From config; never hardcoded at the call site. */
  model: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Server-side refusal fallback (beta). On by default. */
  refusalFallback?: boolean;
  transport?: Transport;
  logger?: Logger;
  /** For tests: the SDK's retry count. */
  maxRetries?: number;
}

export class AnthropicClassifier implements ConflictClassifier {
  readonly id: string;
  readonly #client: Anthropic;
  readonly #options: AnthropicClassifierOptions;
  readonly #logger: Logger;

  constructor(options: AnthropicClassifierOptions) {
    this.#options = options;
    this.#logger = options.logger ?? silentLogger;
    this.id = `anthropic:${options.model}`;
    this.#client = createAnthropicClient(options);
  }

  async assess(
    market: string,
    evidence: readonly PresenceEvidence[],
    signal?: AbortSignal,
  ): Promise<Assessment[]> {
    const out: Assessment[] = [];
    for (let i = 0; i < evidence.length; i += SITES_PER_REQUEST) {
      out.push(
        ...(await this.#assessBatch(market, evidence.slice(i, i + SITES_PER_REQUEST), signal)),
      );
    }
    return out;
  }

  async #assessBatch(
    market: string,
    batch: readonly PresenceEvidence[],
    signal?: AbortSignal,
  ): Promise<Assessment[]> {
    if (batch.length === 0) return [];
    const fallback = this.#options.refusalFallback ?? true;
    const request = () =>
      this.#client.beta.messages.parse(
        {
          model: this.#options.model,
          max_tokens: 16000,
          ...(fallback
            ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
            : {}),
          output_config: {
            effort: this.#options.effort ?? "medium",
            format: zodOutputFormat(ModelOutput),
          },
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: buildUserMessage(market, batch) }],
        },
        signal ? { signal } : undefined,
      );
    let response: Awaited<ReturnType<typeof request>>;
    try {
      response = await request();
    } catch (err) {
      signal?.throwIfAborted();
      // The SDK's error messages don't include the API key; the logger redacts it regardless.
      const status = err instanceof Anthropic.APIError ? err.status : undefined;
      this.#logger.warn("Assessment request failed; sites stay unassessed", {
        status,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }

    if (response.stop_reason !== "end_turn") {
      this.#logger.warn("Assessment didn't complete; sites stay unassessed", {
        stopReason: response.stop_reason,
        ...(response.stop_details ? { category: response.stop_details.category } : {}),
      });
      return [];
    }
    const parsed = ModelOutput.safeParse(response.parsed_output);
    if (!parsed.success) {
      this.#logger.warn("Assessment output failed validation; sites stay unassessed");
      return [];
    }

    const wanted = new Set(batch.map((e) => e.domain));
    const seen = new Set<string>();
    const out: Assessment[] = [];
    for (const item of parsed.data.assessments) {
      const strict = StrictItem.safeParse(item);
      const domain = item.domain.trim().toLowerCase();
      // Unknown or repeated domains, and items that fail the strict schema, are dropped.
      if (!strict.success || !wanted.has(domain) || seen.has(domain)) continue;
      seen.add(domain);
      out.push({
        domain,
        level: strict.data.level,
        reasons: strict.data.reasons,
        assessedBy: this.id,
        market,
      });
    }
    return out;
  }
}
