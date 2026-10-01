// Market-overlap judgment is pluggable (CLAUDE.md, Market-overlap assessment).

import type { Assessment, PresenceEvidence } from "@titlesearch/core";

export interface ConflictClassifier {
  /** Reported as Assessment.assessedBy and part of the assessment cache key. */
  id: string;
  /**
   * Judges each site against the market. Returns an assessment for each site
   * it could judge; a site it couldn't judge is simply absent and stays
   * "unassessed". Never guesses a level.
   */
  assess(
    market: string,
    evidence: readonly PresenceEvidence[],
    signal?: AbortSignal,
  ): Promise<Assessment[]>;
}

/**
 * - server: a model configured on this server judges: the Anthropic API, a
 *   local runtime such as Ollama, or an OpenAI-compatible server.
 * - client: the MCP client's model judges from the evidence (the default for `titlesearch mcp`).
 * - off: evidence only.
 */
export type AssessmentMode = "server" | "client" | "off";

export const ASSESSMENT_MODES = ["server", "client", "off"] as const;

/** Reads a mode from config or the environment. "anthropic" is the old name for "server". */
export function parseAssessmentMode(value: string | undefined): AssessmentMode | undefined {
  if (value === undefined) return undefined;
  if (value === "anthropic") return "server";
  return (ASSESSMENT_MODES as readonly string[]).includes(value)
    ? (value as AssessmentMode)
    : undefined;
}

export const NOT_A_TRADEMARK_SEARCH =
  "This compares public website content with your market description. It isn't a trademark search.";
