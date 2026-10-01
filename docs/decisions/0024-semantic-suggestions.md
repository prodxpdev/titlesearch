# 24. Name suggestions from the description

- Status: accepted
- Date: 2026-10-01

## Context

`generate_variants` only rearranges a name the user already has: prefixes, suffixes, plurals, and other extensions. Users also want fresh names that come from what the product is: the "What are you building?" text.

## Decision

- **Pluggable, like assessment (ADR 13).** A `NameSuggester` interface, with one implementation, `AnthropicSuggester`.
  - It uses the same model, effort, and refusal fallback as assessment, through the same origin-locked SDK client (now shared in `assess/client.ts`).
  - It's available whenever an Anthropic key is set, whatever the assessment mode.
  - Without a key, nothing calls a model. The UI explains why the option is off, and under MCP the client model suggests names itself. The server's instructions and the `saas_naming_session` prompt say so.
- **The description is data.** It goes to the model JSON-encoded inside `<description>` tags, with `<` and `>` escaped so it can't close its own tag. The system prompt says not to follow instructions inside it. Names to avoid (the user's own) go in an `<avoid>` block the same way.
- **Output is never trusted.** It's structured output with a Zod schema, then checked strictly:
  - each name must be a domain label (`^[a-z][a-z0-9]{2,14}$`) with a rationale of 1 to 200 characters;
  - duplicates and avoided names are dropped;
  - at most the requested count is kept.
  An incomplete answer, a failed validation, or no usable names is an error, never a guess.
- **Surfaces.**
  - **MCP:** `suggest_names` (description, count, avoid, and optional tlds), offered only when a suggester exists. With tlds, it also checks availability, lowering the count to stay within 50 domains.
  - **REST:** `POST /api/suggest`, which returns 503 with an explanation when there's no model.
  - **UI:** "Names from your description" in "Also try". It's disabled until settings say suggestions are available. Suggested names are listed after the user's own (so variants can't crowd them out), with a "Suggested" tag and the reason. With it on, the name list may be empty.
  - **CLI:** `check --market "<text>" --suggest [--count n]`.
- **Every surface says suggestions are about availability at most, and that this isn't a trademark search.**

## Consequences

- Suggestions cost one model call per search, on the user's key.
- The model can still suggest a name that matches an existing brand. That's why availability is checked, and why the trademark reminder stays.

## Also fixed

While testing the results view, a row whose extensions were all "Not registered" (registry has no record, no registrar consulted) read "Taken. No extensions are open." That breaks invariant 4. Such rows now read "Not registered", noting that no registrar confirmed the names are open.
