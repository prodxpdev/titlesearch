// The Worker's tests need workerd: run them with `pnpm test:workers`
// (vitest.workers.config.ts). Plain `vitest` here finds nothing to run.
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: [], passWithNoTests: true } });
