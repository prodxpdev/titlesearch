// Response mappings are code, registered by id. Config names a mapping; it
// never supplies an expression (see CLAUDE.md, generic upstream-MCP provider).

import type { Price } from "@titlesearch/core";
import type { CallToolResult } from "./client.js";

export type MappingOutcome =
  | { availability: "available" | "premium" | "registered"; price?: Price }
  | { error: { code: string; message: string } };

export interface UpstreamMapping {
  id: string;
  /** The tool this mapping was written against. Must equal the config's checkTool. */
  tool: string;
  supports?(tld: string): boolean;
  buildArguments(domain: string): Record<string, unknown>;
  /** Maps one tool result. Anything unexpected is an error, never a guess. */
  interpret(result: CallToolResult, domain: string): MappingOutcome;
}

export class MappingRegistry {
  readonly #mappings = new Map<string, UpstreamMapping>();

  constructor(mappings: readonly UpstreamMapping[] = []) {
    for (const m of mappings) this.register(m);
  }

  register(mapping: UpstreamMapping): void {
    if (this.#mappings.has(mapping.id))
      throw new Error(`Mapping ${mapping.id} is already registered.`);
    this.#mappings.set(mapping.id, mapping);
  }

  get(id: string): UpstreamMapping {
    const m = this.#mappings.get(id);
    if (!m) throw new Error(`No mapping is registered as ${id}.`);
    return m;
  }
}
