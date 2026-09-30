# 2. Toolchain versions and compiler settings

- Status: accepted
- Date: 2026-09-29

## Context

The brief names pnpm workspaces, Turborepo, TypeScript strict with `noUncheckedIndexedAccess`, ESM only, Biome, Vitest, and Changesets, but not versions.

## Decision

- **TypeScript 7** (the native compiler, `typescript@7.0.2`). It's the current `latest` release, and typechecking speed matters across many packages. If a dependency's types or a tool we need only work with the JavaScript compiler, record that here and pin 6.x for the affected package.
- **Compiler settings** in `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `module`/`moduleResolution` `NodeNext`. `exactOptionalPropertyTypes` goes beyond the brief. It stops `undefined` from being written into optional fields such as `price` and `presence`, which keeps "field absent" and "field present but empty" distinct in results. Drop it for a package only with an ADR.
- **Default `types: []`**. Each package opts in to ambient types it needs. See [ADR 4](0004-core-runtime-agnostic.md) for core.
- **Internal packages export source** (`"exports": { ".": "./src/index.ts" }`) while everything is private. Packages published to npm get a build step and `publishConfig` when they're first published.
- **Exact version pins** for all dependencies, with Renovate grouping minor and patch updates weekly.
- **Node 24** for development and CI (`.nvmrc`). The Node LTS test job uses `lts/*`.

## Consequences

Contributors need Node 24 and pnpm 10. The TypeScript 7 choice should be revisited if the MCP SDK, Hono, or Tauri's JavaScript tooling has problems with it.
