import { defineConfig } from "vitest/config";

// Unit tests only; e2e/*.spec.ts are Playwright's (`pnpm e2e`).
export default defineConfig({ test: { include: ["src/**/*.test.ts"] } });
