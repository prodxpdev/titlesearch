// An availability provider backed by an upstream MCP server. The upstream is
// a registrar-grade source: its answers can confirm "available".

import {
  type AvailabilityProvider,
  type ProviderContext,
  type SourceResult,
  sourceError,
  type Transport,
  topLevelLabel,
} from "@titlesearch/core";
import { mapLimit } from "../concurrency.js";
import { type CallToolResult, UpstreamMcpClient, UpstreamMcpError } from "./client.js";
import { UpstreamMcpConfig } from "./config.js";
import type { MappingRegistry, UpstreamMapping } from "./mapping.js";

export type SecretResolver = (secretRef: string) => Promise<string>;

export interface UpstreamMcpProviderOptions {
  mappings: MappingRegistry;
  transport?: Transport;
  secrets?: SecretResolver;
  concurrency?: number;
}

export class UpstreamMcpProvider implements AvailabilityProvider {
  readonly id: string;
  readonly #config: UpstreamMcpConfig;
  readonly #mapping: UpstreamMapping;
  readonly #options: UpstreamMcpProviderOptions;
  #client: Promise<UpstreamMcpClient> | undefined;
  #verified: Promise<void> | undefined;

  constructor(config: UpstreamMcpConfig, options: UpstreamMcpProviderOptions) {
    this.#config = UpstreamMcpConfig.parse(config);
    this.#mapping = options.mappings.get(this.#config.mapping);
    if (this.#mapping.tool !== this.#config.checkTool) {
      throw new Error(
        `Mapping ${this.#mapping.id} is for ${this.#mapping.tool}, not ${this.#config.checkTool}.`,
      );
    }
    this.#options = options;
    this.id = this.#config.id;
  }

  supports(tld: string): boolean {
    return this.#mapping.supports?.(tld) ?? true;
  }

  async check(domains: string[], ctx: ProviderContext): Promise<SourceResult[]> {
    const started = Date.now();
    let client: UpstreamMcpClient;
    try {
      client = await this.#getClient();
      await this.#verify(client, ctx.signal);
    } catch (err) {
      ctx.signal.throwIfAborted();
      ctx.logger.warn("Upstream MCP unavailable", { provider: this.id, error: err });
      const code = err instanceof UpstreamMcpError ? err.code : "unavailable";
      const message =
        err instanceof Error ? err.message : "The upstream MCP server is unavailable.";
      return domains.map(() => sourceError(this.id, code, message, started));
    }

    return mapLimit(domains, this.#options.concurrency ?? 4, async (domain) => {
      const t0 = Date.now();
      if (!this.supports(topLevelLabel(domain))) {
        return sourceError(
          this.id,
          "unsupported_tld",
          `${this.id} doesn't check this extension.`,
          t0,
        );
      }
      let result: CallToolResult;
      try {
        await ctx.rateLimiter.acquire(`mcp:${this.id}`, ctx.signal);
        result = await client.callTool(
          this.#config.checkTool,
          this.#mapping.buildArguments(domain),
          ctx.signal,
        );
      } catch (err) {
        ctx.signal.throwIfAborted();
        const code = err instanceof UpstreamMcpError ? err.code : "network";
        return sourceError(this.id, code, `${this.id} couldn't check ${domain}.`, t0);
      }
      const outcome = this.#mapping.interpret(result, domain);
      if ("error" in outcome)
        return sourceError(this.id, outcome.error.code, outcome.error.message, t0);
      return {
        source: this.id,
        availability: outcome.availability,
        ...(outcome.price ? { price: outcome.price } : {}),
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - t0,
      };
    });
  }

  #getClient(): Promise<UpstreamMcpClient> {
    this.#client ??= (async () => {
      let bearerToken: string | undefined;
      if (this.#config.auth) {
        if (!this.#options.secrets)
          throw new Error(`${this.id} needs a secret, and no secret store is configured.`);
        bearerToken = await this.#options.secrets(this.#config.auth.secretRef);
      }
      return new UpstreamMcpClient(this.#config, {
        ...(this.#options.transport ? { transport: this.#options.transport } : {}),
        ...(bearerToken ? { bearerToken } : {}),
      });
    })().catch((err: unknown) => {
      this.#client = undefined;
      throw err;
    });
    return this.#client;
  }

  /**
   * Confirms once that the check tool exists and declares itself read-only and
   * non-destructive. Defense in depth: the allowlist already stops other tools.
   */
  #verify(client: UpstreamMcpClient, signal: AbortSignal): Promise<void> {
    this.#verified ??= (async () => {
      const tools = await client.listTools(signal);
      const tool = tools.find((t) => t.name === this.#config.checkTool);
      if (!tool) {
        throw new UpstreamMcpError(
          "invalid_response",
          `${this.id} no longer offers ${this.#config.checkTool}.`,
        );
      }
      if (tool.annotations?.readOnlyHint !== true || tool.annotations.destructiveHint === true) {
        throw new UpstreamMcpError(
          "tool_not_allowed",
          `${this.#config.checkTool} doesn't declare itself read-only.`,
        );
      }
    })().catch((err: unknown) => {
      this.#verified = undefined;
      throw err;
    });
    return this.#verified;
  }
}
