// Unit tests only. The live contract canary has its own config
// (vitest.canary.config.ts) and file suffix, so it can never run here.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
