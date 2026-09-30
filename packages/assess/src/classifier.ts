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
 * - anthropic: a server-side classifier calls the Anthropic API.
 * - client: the MCP client's model judges from the evidence (the default for `titlesearch mcp`).
 * - off: evidence only.
 */
export type AssessmentMode = "anthropic" | "client" | "off";

export const NOT_A_TRADEMARK_SEARCH =
  "This compares public website content with your market description. It isn't a trademark search.";
