// A model that answers with JSON, for the classifier and the suggester. Two
// implementations: the Anthropic Messages API (structured output), and any
// server speaking the OpenAI chat-completions API, which covers Ollama, LM
// Studio, OpenRouter, Groq, Together, vLLM, and llama.cpp's server.
//
// Whatever comes back is only a candidate: callers validate it strictly with
// Zod, and anything short of a valid answer leaves sites unassessed or
// suggestions unoffered. A smaller model can make the answer worse, never
// make Titlesearch report something it didn't check.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  createOriginFetch,
  type Logger,
  type OriginFetch,
  silentLogger,
  type Transport,
} from "@titlesearch/core";
import * as z from "zod";
import { BuiltinJsonModel, type BuiltinRuntime } from "./builtin.js";
import { createAnthropicClient } from "./client.js";
import {
  describeChoice,
  isLoopbackUrl,
  LOCAL_RUNTIME_URLS,
  type ModelChoice,
  type ModelDescriptor,
  modelKey,
  providerLabel,
} from "./models.js";

export interface JsonRequest<T extends z.ZodType> {
  system: string;
  user: string;
  /** What the answer must look like. Validated loosely here; callers apply their strict rules. */
  schema: T;
  /** A short name for the schema, for providers that ask for one. */
  schemaName: string;
  maxTokens: number;
  signal?: AbortSignal | undefined;
}

export type JsonResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface JsonModel {
  readonly descriptor: ModelDescriptor;
  /** "anthropic:claude-opus-5-5", "ollama:llama3.1:8b". */
  readonly id: string;
  generate<T extends z.ZodType>(request: JsonRequest<T>): Promise<JsonResult<z.infer<T>>>;
}

// --- Anthropic ----------------------------------------------------------------

export interface AnthropicJsonModelOptions {
  apiKey: string;
  model: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Server-side refusal fallback (beta). On by default. */
  refusalFallback?: boolean;
  transport?: Transport;
  logger?: Logger;
  maxRetries?: number;
}

export class AnthropicJsonModel implements JsonModel {
  readonly descriptor: ModelDescriptor;
  readonly id: string;
  readonly #client: Anthropic;
  readonly #options: AnthropicJsonModelOptions;
  readonly #logger: Logger;

  constructor(options: AnthropicJsonModelOptions) {
    this.#options = options;
    this.#logger = options.logger ?? silentLogger;
    this.descriptor = { provider: "anthropic", id: options.model, locality: "remote" };
    this.id = modelKey(this.descriptor);
    this.#client = createAnthropicClient(options);
  }

  async generate<T extends z.ZodType>(request: JsonRequest<T>): Promise<JsonResult<z.infer<T>>> {
    const fallback = this.#options.refusalFallback ?? true;
    let response: Awaited<ReturnType<Anthropic["beta"]["messages"]["parse"]>>;
    try {
      response = await this.#client.beta.messages.parse(
        {
          model: this.#options.model,
          max_tokens: request.maxTokens,
          ...(fallback
            ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
            : {}),
          output_config: {
            effort: this.#options.effort ?? "medium",
            format: zodOutputFormat(request.schema as z.ZodType<unknown>),
          },
          system: request.system,
          messages: [{ role: "user", content: request.user }],
        },
        request.signal ? { signal: request.signal } : undefined,
      );
    } catch (err) {
      request.signal?.throwIfAborted();
      // The SDK's messages don't include the key; the logger redacts it regardless.
      const status = err instanceof Anthropic.APIError ? err.status : undefined;
      this.#logger.warn("Anthropic request failed", {
        status,
        error: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, reason: "Couldn't reach the Anthropic API." };
    }
    if (response.stop_reason !== "end_turn") {
      this.#logger.warn("Anthropic answer didn't complete", {
        stopReason: response.stop_reason,
        ...(response.stop_details ? { category: response.stop_details.category } : {}),
      });
      return { ok: false, reason: "The model didn't finish its answer." };
    }
    const parsed = request.schema.safeParse(response.parsed_output);
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, reason: "The model's answer failed validation." };
  }
}

// --- OpenAI-compatible --------------------------------------------------------

export interface OpenAICompatibleJsonModelOptions {
  provider: "builtin" | "ollama" | "lmstudio" | "openai-compatible";
  /** The server's base URL, with or without a trailing /v1. */
  baseUrl: string;
  model: string;
  /** Sent as a bearer token. Refused over plain HTTP to anything but this machine. */
  apiKey?: string | undefined;
  transport?: Transport;
  logger?: Logger;
  /** Local models on a laptop can take a while; the default allows three minutes. */
  timeoutMs?: number;
}

/** Strips reasoning blocks and code fences, then takes the outermost JSON object. */
export function extractJson(text: string): unknown {
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json)?/gi, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new SyntaxError("No JSON object in the answer.");
  return JSON.parse(cleaned.slice(start, end + 1));
}

const ChatCompletion = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable().optional() }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
});

/** "https://openrouter.ai/api/v1" and "http://127.0.0.1:11434" both end at …/v1/chat/completions. */
export function chatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return /\/v1$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

export class OpenAICompatibleJsonModel implements JsonModel {
  readonly descriptor: ModelDescriptor;
  readonly id: string;
  readonly #options: OpenAICompatibleJsonModelOptions;
  readonly #fetch: OriginFetch;
  readonly #url: string;
  readonly #logger: Logger;

  constructor(options: OpenAICompatibleJsonModelOptions) {
    const url = new URL(options.baseUrl);
    if (url.username || url.password) throw new Error("Put the key in the key field, not the URL.");
    if (options.apiKey && url.protocol === "http:" && !isLoopbackUrl(options.baseUrl))
      throw new Error("A key is only sent over HTTPS, or to a server on this computer.");
    this.#options = options;
    this.#logger = options.logger ?? silentLogger;
    this.#url = chatCompletionsUrl(options.baseUrl);
    this.descriptor = describeChoice({
      provider: options.provider,
      id: options.model,
      baseUrl: options.baseUrl,
    });
    this.id = modelKey(this.descriptor);
    // A configured endpoint, not a user-derived host: locked to its own origin (invariant 2).
    const http = url.protocol === "http:";
    this.#fetch = createOriginFetch({
      origins: http ? [] : [url.origin],
      ...(http ? { httpOrigins: [url.origin] } : {}),
      timeoutMs: options.timeoutMs ?? 180_000,
      maxBytes: 4 * 1024 * 1024,
      ...(options.transport ? { transport: options.transport } : {}),
    });
  }

  async generate<T extends z.ZodType>(request: JsonRequest<T>): Promise<JsonResult<z.infer<T>>> {
    const schema = z.toJSONSchema(request.schema);
    // Said in the prompt too: some servers ignore response_format.
    const system = `${request.system}\n\nReply with one JSON object and nothing else. It must match this JSON Schema:\n${JSON.stringify(schema)}`;
    // Strongest constraint first; servers that reject it get plainer JSON modes.
    const formats: (Record<string, unknown> | undefined)[] = [
      { type: "json_schema", json_schema: { name: request.schemaName, schema, strict: true } },
      { type: "json_object" },
      undefined,
    ];
    const name = providerLabel(this.descriptor.provider);
    for (const format of formats) {
      let res: Response;
      try {
        res = await this.#fetch(this.#url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.#options.apiKey ? { authorization: `Bearer ${this.#options.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: this.#options.model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: request.user },
            ],
            temperature: 0,
            max_tokens: request.maxTokens,
            stream: false,
            ...(format ? { response_format: format } : {}),
          }),
          ...(request.signal ? { signal: request.signal } : {}),
        });
      } catch (err) {
        request.signal?.throwIfAborted();
        this.#logger.warn("Model request failed", {
          model: this.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          ok: false,
          reason:
            this.descriptor.locality === "local"
              ? `Couldn't reach ${name} at ${this.#options.baseUrl}. Is it running?`
              : `Couldn't reach ${name} at ${this.#options.baseUrl}.`,
        };
      }
      // A server that doesn't understand this response_format: try the next one.
      if ((res.status === 400 || res.status === 422) && format) continue;
      if (res.status === 401 || res.status === 403)
        return { ok: false, reason: `${name} didn't accept the API key.` };
      if (res.status === 404)
        return { ok: false, reason: `${name} doesn't have the model "${this.#options.model}".` };
      if (!res.ok) return { ok: false, reason: `${name} returned HTTP ${res.status}.` };

      const body = ChatCompletion.safeParse(await res.json().catch(() => undefined));
      if (!body.success) return { ok: false, reason: `${name}'s answer wasn't a chat completion.` };
      const choice = body.data.choices[0];
      if (choice?.finish_reason === "length")
        return { ok: false, reason: "The model ran out of room before finishing its answer." };
      let json: unknown;
      try {
        json = extractJson(choice?.message.content ?? "");
      } catch {
        return { ok: false, reason: "The model's answer wasn't JSON." };
      }
      const parsed = request.schema.safeParse(json);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, reason: "The model's answer failed validation." };
    }
    return { ok: false, reason: `${name} rejected the request.` };
  }
}

// --- Choosing -----------------------------------------------------------------

export interface ModelKeys {
  anthropic?: string | undefined;
  openaiCompatible?: string | undefined;
}

export interface CreateModelOptions {
  /** Runs the built-in model. Only where it can run: the CLI and the desktop app. */
  builtin?: BuiltinRuntime | undefined;
  effort?: AnthropicJsonModelOptions["effort"];
  refusalFallback?: boolean;
  transport?: Transport;
  logger?: Logger;
}

/** Why a choice can't be used yet, or undefined when it can. */
export function modelUnavailable(
  choice: ModelChoice,
  keys: ModelKeys,
  builtin?: BuiltinRuntime,
): string | undefined {
  if (choice.provider === "anthropic" && !keys.anthropic) return "Add an Anthropic API key.";
  if (choice.provider === "builtin")
    return builtin
      ? builtin.unavailable(choice.id)
      : "The built-in model runs in the desktop app and the titlesearch command, not here.";
  if (choice.provider === "openai-compatible" && !choice.baseUrl)
    return "Give the server's base URL.";
  return undefined;
}

/** The model for a choice, or undefined when it can't be used yet (see modelUnavailable). */
export function createJsonModel(
  choice: ModelChoice,
  keys: ModelKeys,
  options: CreateModelOptions = {},
): JsonModel | undefined {
  if (modelUnavailable(choice, keys, options.builtin)) return undefined;
  if (choice.provider === "builtin" && options.builtin)
    return new BuiltinJsonModel(choice.id, options.builtin, {
      logger: options.logger,
      transport: options.transport,
    });
  const common = {
    ...(options.transport ? { transport: options.transport } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  };
  if (choice.provider === "anthropic")
    return new AnthropicJsonModel({
      apiKey: keys.anthropic as string,
      model: choice.id,
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.refusalFallback !== undefined
        ? { refusalFallback: options.refusalFallback }
        : {}),
      ...common,
    });
  if (choice.provider === "builtin") return undefined;
  const baseUrl =
    choice.baseUrl ??
    (choice.provider === "openai-compatible" ? "" : LOCAL_RUNTIME_URLS[choice.provider]);
  return new OpenAICompatibleJsonModel({
    provider: choice.provider,
    baseUrl,
    model: choice.id,
    // Local runtimes need no key; a key is only ever for the user's own server.
    ...(choice.provider === "openai-compatible" && keys.openaiCompatible
      ? { apiKey: keys.openaiCompatible }
      : {}),
    ...common,
  });
}
