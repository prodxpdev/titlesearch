// `check --suggest`: names suggested from the --market description, added to
// the names being checked. Needs a model on this machine (ANTHROPIC_API_KEY).

import { type NameSuggestion, NOT_A_TRADEMARK_SEARCH, SuggestionError } from "@titlesearch/assess";
import { DEFAULT_TLDS, MAX_DOMAINS_PER_CALL, MAX_NAMES_PER_CALL } from "@titlesearch/core";
import type { TitlesearchServices } from "@titlesearch/mcp";
import { UsageError } from "./check.js";

export const DEFAULT_SUGGEST_COUNT = 10;

/** How many names fit: the per-call caps on names and on domains. */
export function suggestionRoom(names: number, tlds: number): number {
  return Math.min(MAX_NAMES_PER_CALL - names, Math.floor(MAX_DOMAINS_PER_CALL / tlds) - names);
}

export async function suggestNames(
  services: TitlesearchServices,
  names: readonly string[],
  values: { market?: string | undefined; count?: string | undefined },
  tlds: readonly string[] | undefined,
  signal: AbortSignal,
): Promise<NameSuggestion[]> {
  const description = values.market?.trim();
  if (!description)
    throw new UsageError('--suggest needs --market "<what you\'re building>" to suggest from.');
  const suggester = services.suggester;
  if (!suggester)
    throw new UsageError(
      "--suggest needs ANTHROPIC_API_KEY. In Claude, ask it to suggest names instead.",
    );
  const asked = values.count === undefined ? DEFAULT_SUGGEST_COUNT : Number(values.count);
  if (!Number.isInteger(asked) || asked < 1)
    throw new UsageError("--count must be a whole number of at least 1.");
  const room = suggestionRoom(names.length, (tlds ?? DEFAULT_TLDS).length);
  if (room < 1)
    throw new UsageError("No room for suggestions: use fewer names or fewer extensions.");
  try {
    return await suggester.suggest(description, {
      count: Math.min(asked, room),
      avoid: names.map((n) => n.toLowerCase()),
      signal,
    });
  } catch (err) {
    if (err instanceof SuggestionError || err instanceof RangeError)
      throw new UsageError(err.message);
    throw err;
  }
}

export function formatSuggestions(suggestions: readonly NameSuggestion[]): string {
  const width = Math.max(...suggestions.map((s) => s.name.length));
  return [
    "Suggested from your description:",
    ...suggestions.map((s) => `  ${s.name.padEnd(width)}  ${s.rationale}`),
    NOT_A_TRADEMARK_SEARCH,
  ].join("\n");
}
