# 7. A minimal upstream MCP client instead of the SDK client

- Status: accepted
- Date: 2026-09-30

## Context

The generic upstream-MCP provider calls registrar MCP servers such as GoDaddy's over Streamable HTTP. Invariant 1 requires that only allowlisted tools can be called, refused before any request is made. Invariant 2 requires every request to go through `core/net`.

## Decision

`packages/providers/src/upstream-mcp/client.ts` is a small JSON-RPC client that speaks only `initialize`, `notifications/initialized`, `tools/list`, and `tools/call`.

- `callTool` checks the allowlist first, before initializing or sending anything. A method outside those four is refused too.
- Requests go through `createOriginFetch`, restricted to the config URL's origin, over HTTPS only.
- Responses may be `application/json` or a finite `text/event-stream`. Both are read by `readJsonMessages` in `core/net`, so the no-raw-body lint rule keeps its existing exemptions.
- It negotiates the protocol version, sends `mcp-protocol-version` afterward, and echoes `mcp-session-id` if a server sets one. It never opens the standalone GET event stream.

The provider also calls `tools/list` once and refuses to run unless the check tool exists and declares `readOnlyHint: true` without `destructiveHint: true`. Config validation rejects an allowlist containing a tool whose name describes a write (`describesWrite`). Both checks are defense in depth; the allowlist is the enforcement.

### Why not the SDK client

The brief requires the official SDK for Titlesearch's own MCP server. That still holds for step 5. For the client side:

- The SDK's Streamable HTTP client transport may open a long-lived GET event stream. The fixed-origin fetch buffers and caps whole responses, so that stream would hang until the timeout.
- The allowlist check belongs at the single point where requests leave. With the SDK, that point would be a wrapper around a much larger surface: resources, prompts, sampling, and elicitation handlers.
- The client needs only four methods, all covered by tests against recorded GoDaddy traffic.

Revisit this if an upstream needs features beyond stateless request and response.

## Consequences

MCP protocol changes that affect these four methods must be tracked by hand. The nightly contract canary catches drift for GoDaddy.
