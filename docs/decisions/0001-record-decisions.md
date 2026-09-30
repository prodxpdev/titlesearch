# 1. Record decisions as ADRs

- Status: accepted
- Date: 2026-09-29

## Context

Titlesearch runs on several runtimes and deploy targets, and many choices (a parser, a transport, a lint mechanism) will look arbitrary to someone who wasn't there. `CLAUDE.md` asks for a record of any choice a future contributor would otherwise have to rediscover.

## Decision

Each such choice gets a short Markdown file in `docs/decisions/`, numbered in order: `NNNN-short-title.md`. Each file has a status, a date, the context, the decision, and its consequences. A superseded ADR stays in place, with its status changed to name the ADR that replaces it.

## Consequences

Decisions are reviewable in pull requests alongside the code they explain.
