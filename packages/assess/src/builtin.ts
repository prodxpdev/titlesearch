// The built-in model: open weights Titlesearch downloads once, after install,
// and runs on this computer with a pinned llama.cpp server. Nothing is
// bundled: the installers stay small, and nobody downloads gigabytes they
// didn't ask for. Every file is pinned by size and SHA-256 and checked as it's
// written. See docs/decisions/0026-built-in-model.md.
//
// This file is data and interfaces only, so every runtime can name the
// choices. Downloading and running them is the CLI's job (apps/cli/src/builtin).

import { type Logger, silentLogger, type Transport } from "@titlesearch/core";
import type * as z from "zod";
import {
  type JsonModel,
  type JsonRequest,
  type JsonResult,
  OpenAICompatibleJsonModel,
} from "./json-model.js";
import { type ModelDescriptor, modelKey } from "./models.js";

export {
  BUILTIN_MODELS,
  type BuiltinModel,
  builtinModel,
  DEFAULT_BUILTIN_MODEL,
} from "./builtin-catalog.js";

/**
 * Runs built-in models on this computer. Implemented by the CLI; absent on
 * deployed servers, where the built-in model isn't offered.
 */
export interface BuiltinRuntime {
  /** Why the model can't run yet ("Download it first."), or undefined when it can. */
  unavailable(id: string): string | undefined;
  /**
   * Starts the model's server, or reuses a running one, and resolves once it
   * answers. The key is random per start, so nothing else on this computer
   * can use the server.
   */
  start(id: string, signal?: AbortSignal): Promise<{ baseUrl: string; apiKey: string }>;
}

/** A built-in model, started on first use and reached like any OpenAI-compatible server. */
export class BuiltinJsonModel implements JsonModel {
  readonly descriptor: ModelDescriptor;
  readonly id: string;
  readonly #runtime: BuiltinRuntime;
  readonly #logger: Logger;
  readonly #transport: Transport | undefined;
  #inner: { baseUrl: string; apiKey: string; model: OpenAICompatibleJsonModel } | undefined;

  constructor(
    modelId: string,
    runtime: BuiltinRuntime,
    options: { logger?: Logger | undefined; transport?: Transport | undefined } = {},
  ) {
    this.descriptor = { provider: "builtin", id: modelId, locality: "local" };
    this.id = modelKey(this.descriptor);
    this.#runtime = runtime;
    this.#logger = options.logger ?? silentLogger;
    this.#transport = options.transport;
  }

  async generate<T extends z.ZodType>(request: JsonRequest<T>): Promise<JsonResult<z.infer<T>>> {
    let server: { baseUrl: string; apiKey: string };
    try {
      server = await this.#runtime.start(this.descriptor.id, request.signal);
    } catch (err) {
      request.signal?.throwIfAborted();
      const message = err instanceof Error ? err.message : String(err);
      this.#logger.warn("Built-in model didn't start", { model: this.id, error: message });
      return { ok: false, reason: `The built-in model didn't start: ${message}` };
    }
    // A restarted server has a new port and key.
    if (this.#inner?.baseUrl !== server.baseUrl || this.#inner.apiKey !== server.apiKey) {
      this.#inner = {
        ...server,
        model: new OpenAICompatibleJsonModel({
          provider: "builtin",
          baseUrl: server.baseUrl,
          model: this.descriptor.id,
          apiKey: server.apiKey,
          logger: this.#logger,
          ...(this.#transport ? { transport: this.#transport } : {}),
        }),
      };
    }
    return this.#inner.model.generate(request);
  }
}
