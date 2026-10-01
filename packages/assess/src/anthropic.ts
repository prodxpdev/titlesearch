// The server-side market-overlap classifier. It runs on any JsonModel
// (json-model.ts): the Anthropic API with the user's key, a local runtime such
// as Ollama, or an OpenAI-compatible server. Every request goes through core's
// origin-locked fetch (invariant 2), and anything short of a valid, complete
// answer leaves sites unassessed. See docs/decisions/0013-market-assessment.md
// and 0025-open-models.md.

import {
  type Assessment,
  type Logger,
  type PresenceEvidence,
  silentLogger,
  type Transport,
} from "@titlesearch/core";
import * as z from "zod";
import type { ConflictClassifier } from "./classifier.js";
import { ANTHROPIC_API_ORIGIN } from "./client.js";
import { AnthropicJsonModel, type JsonModel } from "./json-model.js";
import { buildUserMessage, SYSTEM_PROMPT } from "./prompt.js";

export { DEFAULT_ANTHROPIC_MODEL } from "./models.js";
export { ANTHROPIC_API_ORIGIN };
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

/**
 * The server-side classifier, over any model that answers in JSON: the
 * Anthropic API, a local runtime such as Ollama, or an OpenAI-compatible
 * server. Anything short of a valid, complete answer leaves sites unassessed.
 */
export class ModelClassifier implements ConflictClassifier {
  readonly id: string;
  readonly #model: JsonModel;
  readonly #logger: Logger;

  constructor(model: JsonModel, logger?: Logger) {
    this.#model = model;
    this.#logger = logger ?? silentLogger;
    this.id = model.id;
  }

  get descriptor(): JsonModel["descriptor"] {
    return this.#model.descriptor;
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
    const result = await this.#model.generate({
      system: SYSTEM_PROMPT,
      user: buildUserMessage(market, batch),
      schema: ModelOutput,
      schemaName: "market_assessments",
      maxTokens: 16000,
      signal,
    });
    if (!result.ok) {
      this.#logger.warn("Assessment didn't complete; sites stay unassessed", {
        model: this.id,
        reason: result.reason,
      });
      return [];
    }

    const wanted = new Set(batch.map((e) => e.domain));
    const seen = new Set<string>();
    const out: Assessment[] = [];
    for (const item of result.value.assessments) {
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

/** The classifier through the Anthropic API. */
export class AnthropicClassifier extends ModelClassifier {
  constructor(options: AnthropicClassifierOptions) {
    super(new AnthropicJsonModel(options), options.logger);
  }
}
