# 4. Keep packages/core runtime-agnostic through its compiler settings

- Status: accepted
- Date: 2026-09-29

## Context

Core must run unchanged on Node, Bun, Cloudflare Workers, and in the Tauri webview's sidecar. It may use only `fetch`, Web Crypto, `URL`, and injected interfaces.

## Decision

`packages/core/tsconfig.json` sets `"lib": ["ES2023", "WebWorker"]` and `"types": []`.

- The **WebWorker** lib provides `fetch`, `Request`, `Response`, `URL`, `crypto.subtle`, `TextEncoder`, `AbortSignal`, and timers without `document`, `window`, or other DOM-only APIs that don't exist on servers.
- **`types: []`** means `@types/node` is never loaded, even if it's hoisted into `node_modules`, so a Node API doesn't typecheck in core.

`scripts/check-invariants.mjs` fails if either setting changes, or if core gains a dependency other than `zod`. The Biome rules in [ADR 3](0003-invariant-lint-rules.md) catch Node, Bun, and Workers imports and globals.

## Consequences

The WebWorker lib declares a few globals (`self`, `postMessage`) that don't exist on every runtime. Core shouldn't use them, and the fetch lint rule already rejects `self.fetch`.
