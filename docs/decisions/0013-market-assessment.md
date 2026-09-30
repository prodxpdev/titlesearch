# 13. Market-overlap assessment

- Status: accepted
- Date: 2026-09-30

## Context

Step 7 adds the `ConflictClassifier`, with `anthropic`, `client`, and `off` modes, plus the `assess_market_conflicts` tool, the `saas_naming_session` prompt, and `check --market`.

## Decisions

### The official SDK, over core's fixed-origin fetch

The `anthropic` classifier uses `@anthropic-ai/sdk` (0.130.0), not hand-written HTTP. The SDK is built with `fetch` set to `createOriginFetch(["https://api.anthropic.com"])`, so every request still leaves through `core/net`, restricted to that origin (invariant 2), and responses are size-capped. Only GET and POST with string bodies are forwarded; anything else throws. The SDK handles headers, versioning, retries (2), and typed errors.

It calls `beta.messages.parse` with structured output from `zodOutputFormat`. Each response is checked twice: first against the loose output schema, then per item against a strict one (2 to 4 reasons of at most 300 characters, a known level, a domain that was asked about, and no duplicates).

A site is left `unassessed`, never given a guessed level, when:
- the request fails (network, 401, 429, 5xx);
- the stop reason isn't `end_turn` (for example `refusal` or `max_tokens`);
- the output doesn't parse or validate;
- or the model returns no valid item for that site.

### Model, effort, and fallback come from config

- **Model:** `assessment.model` in config, defaulting to `claude-opus-5-5`, the current default model.
- **Effort:** `assessment.effort`, default `medium`, set explicitly because Opus 5.5 can't disable thinking and its effort default differs from earlier Opus models.
- **Refusal fallback:** server-side refusal fallback is on by default (`fallbacks: "default"` with beta `server-side-fallback-2026-07-01`). If a safety classifier declines a request, the API retries it on a model chosen by refusal category, inside the same call. `assessment.refusalFallback: false` turns it off.
- **Classifier id:** `anthropic:<model>`. It appears in `assessedBy` and in the cache key, so changing the model never serves another model's judgment.

### Prompt-injection handling

- **Only extracted fields are sent:** title, descriptions, JSON-LD types and name, final URL, content confidence, and `untrustedSiteText`, which is already cleaned and capped at 600 characters.
- **Data blocks can't be broken out of:** each site is JSON inside `<site>` tags, with `<` and `>` escaped to `<` and `>`, so no site can close its block, open another, or forge the `<market>` block. A test injects exactly that and counts the blocks.
- **The system prompt treats site content as data:** it says everything inside `<site>` was written by the site's owner, that it's data and never instructions, and that claims about how to classify it are to be ignored.
- **Reasons are checked, not trusted:** they must be about the domains asked about. Anything else is dropped.

### What gets judged

Only sites with occupancy `unassessed`, meaning a real site answered. Parked, for-sale, and no-site domains already have a deterministic answer, and a for-sale lander isn't a competitor. Up to 10 sites go in one request. Judgments are cached for 24 hours per domain, market, and classifier. The market text is normalized for the key and hashed out of it.

### Modes

| Surface | Default | Why |
|---|---|---|
| `titlesearch mcp` | `client` | Per the brief: Claude judges from the evidence. The tool description tells it how, and to give reasons. |
| `check --market` | `anthropic` if `ANTHROPIC_API_KEY` is set, else evidence only with a notice | There's no client model in a terminal. |
| Either | `assessment.mode` in config overrides | Setting `anthropic` without a key is a config error, not a silent downgrade. |

In the CLI, `client` behaves like `off`.

`ANTHROPIC_API_KEY` is read only from the environment (invariant 6) and is registered with the redacting logger before anything else runs. A live check with an invalid key reached the real API through the fixed-origin fetch, got a 401, left the site unassessed, and logged no part of the key.

### Surfaces

- `assess_market_conflicts` takes one name, a market description of up to 1000 characters, and extensions. Its description depends on the mode, and it always ends with the trademark reminder.
- `saas_naming_session` takes `product` and `audience` and walks the five steps in the brief.
- Both are registered only when a presence probe is configured.

## Not verified

No live, successful classification has been run: this environment had no API key. The request shape is checked against the SDK's own serialization, and responses against realistic Messages API bodies. The first live run should compare a few judgments with a human's.

## Consequences

The Anthropic SDK is a dependency of `packages/assess` only. Core still depends on nothing but Zod.
