// A minimal, stateless-first MCP client over Streamable HTTP. It speaks only
// initialize, tools/list, and tools/call, and refuses any tools/call whose
// tool isn't on the config's allowlist before anything is sent.
// docs/decisions/0007-upstream-mcp-client.md explains why this isn't the SDK
// client.

import {
  createOriginFetch,
  type OriginFetch,
  readJsonMessages,
  type Transport,
} from "@titlesearch/core";
import * as z from "zod";
import type { UpstreamMcpConfig } from "./config.js";

export const PROTOCOL_VERSION = "2025-06-18";

export class UpstreamMcpError extends Error {
  override readonly name = "UpstreamMcpError";
  constructor(
    readonly code:
      | "tool_not_allowed"
      | "method_not_allowed"
      | "http_error"
      | "rate_limited"
      | "invalid_response"
      | "rpc_error",
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const JsonRpcResponse = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.number(), z.string()]),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

export const ToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()),
  annotations: z
    .object({
      readOnlyHint: z.boolean().optional(),
      destructiveHint: z.boolean().optional(),
    })
    .optional(),
});
export type Tool = z.infer<typeof ToolSchema>;

export const CallToolResultSchema = z.object({
  content: z.array(z.unknown()).optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
});
export type CallToolResult = z.infer<typeof CallToolResultSchema>;

const InitializeResult = z.object({ protocolVersion: z.string() });

type Method = "initialize" | "tools/list" | "tools/call";
const ALLOWED_METHODS: ReadonlySet<string> = new Set<Method>([
  "initialize",
  "tools/list",
  "tools/call",
]);

export interface UpstreamMcpClientOptions {
  transport?: Transport;
  /** Resolved bearer token, if the config has auth. Never logged or put in errors. */
  bearerToken?: string;
  timeoutMs?: number;
}

export class UpstreamMcpClient {
  readonly #config: UpstreamMcpConfig;
  readonly #fetch: OriginFetch;
  readonly #token: string | undefined;
  readonly #allowed: ReadonlySet<string>;
  #nextId = 1;
  #sessionId: string | undefined;
  #protocolVersion: string | undefined;
  #initializing: Promise<void> | undefined;

  constructor(config: UpstreamMcpConfig, options: UpstreamMcpClientOptions = {}) {
    this.#config = config;
    this.#allowed = new Set(config.allowedTools);
    this.#token = options.bearerToken;
    this.#fetch = createOriginFetch({
      origins: [new URL(config.url).origin],
      timeoutMs: options.timeoutMs ?? 15_000,
      ...(options.transport ? { transport: options.transport } : {}),
    });
  }

  async listTools(signal?: AbortSignal): Promise<Tool[]> {
    const result = await this.#request("tools/list", {}, signal);
    const parsed = z.object({ tools: z.array(ToolSchema) }).safeParse(result);
    if (!parsed.success)
      throw new UpstreamMcpError("invalid_response", "tools/list response failed validation.");
    return parsed.data.tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    // Refused before initialize, before anything is sent.
    if (!this.#allowed.has(name)) {
      throw new UpstreamMcpError(
        "tool_not_allowed",
        `Tool "${name}" isn't allowed for ${this.#config.id}.`,
      );
    }
    const result = await this.#request("tools/call", { name, arguments: args }, signal);
    const parsed = CallToolResultSchema.safeParse(result);
    if (!parsed.success)
      throw new UpstreamMcpError("invalid_response", "tools/call response failed validation.");
    return parsed.data;
  }

  async #request(method: Method, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (method !== "initialize") await this.#initialize(signal);
    return this.#send(method, params, signal);
  }

  #initialize(signal?: AbortSignal): Promise<void> {
    this.#initializing ??= (async () => {
      const result = await this.#send(
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "titlesearch", version: "0.0.0" },
        },
        signal,
      );
      const parsed = InitializeResult.safeParse(result);
      if (!parsed.success)
        throw new UpstreamMcpError("invalid_response", "initialize response failed validation.");
      this.#protocolVersion = parsed.data.protocolVersion;
      await this.#post({ jsonrpc: "2.0", method: "notifications/initialized" }, signal);
    })().catch((err: unknown) => {
      this.#initializing = undefined;
      throw err;
    });
    return this.#initializing;
  }

  async #send(method: Method, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!ALLOWED_METHODS.has(method)) {
      throw new UpstreamMcpError("method_not_allowed", `Method ${method} isn't allowed.`);
    }
    const id = this.#nextId++;
    const res = await this.#post({ jsonrpc: "2.0", id, method, params }, signal);
    let messages: unknown[];
    try {
      messages = await readJsonMessages(res);
    } catch {
      throw new UpstreamMcpError("invalid_response", `${method} returned an unreadable response.`);
    }
    for (const m of messages) {
      const parsed = JsonRpcResponse.safeParse(m);
      if (!parsed.success || parsed.data.id !== id) continue;
      if (parsed.data.error) {
        throw new UpstreamMcpError("rpc_error", `${method} failed: ${parsed.data.error.message}`);
      }
      return parsed.data.result;
    }
    throw new UpstreamMcpError("invalid_response", `${method} returned no matching response.`);
  }

  async #post(message: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (this.#protocolVersion) headers["mcp-protocol-version"] = this.#protocolVersion;
    if (this.#sessionId) headers["mcp-session-id"] = this.#sessionId;
    if (this.#token) headers.authorization = `Bearer ${this.#token}`;

    const res = await this.#fetch(this.#config.url, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
      ...(signal ? { signal } : {}),
    });
    const session = res.headers.get("mcp-session-id");
    if (session) this.#sessionId = session;
    if (res.status === 429) {
      throw new UpstreamMcpError(
        "rate_limited",
        `${this.#config.id} is rate limiting requests.`,
        429,
      );
    }
    if (!res.ok) {
      throw new UpstreamMcpError(
        "http_error",
        `${this.#config.id} returned HTTP ${res.status}.`,
        res.status,
      );
    }
    return res;
  }
}
